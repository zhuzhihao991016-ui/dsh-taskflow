/**
 * P2 Planner adapter: drives the Codex CLI (`codex exec`) in a read-only,
 * ephemeral, schema-constrained run to produce the Issue plan for a run,
 * then parses the JSONL event stream back into issue objects. The process
 * executor is injectable so contract tests drive the adapter with fakes;
 * the production executor launches the Codex CLI: JS entries through the
 * current Node runtime and native/PATH executables directly. Batch launchers
 * are rejected because cmd.exe cannot preserve an arbitrary argv safely.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PlannedIssue } from './dag.ts'

/** Stable error code for planner failures (surfaced in run transitions). */
export type PlannerErrorCode =
  | 'timeout'
  | 'process-failed'
  | 'parse-failed'
  | 'no-plan-output'

/** Stable planner error. */
export class PlannerError extends Error {
  constructor(
    readonly code: PlannerErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(`taskflow: planner ${code}: ${message}`)
    this.name = 'PlannerError'
  }
}

/** One spawned-process result. */
export interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when the run was terminated by an abort signal (not a timeout). */
  aborted?: boolean
  /** True when the run was terminated because combined output exceeded the cap. */
  outputLimitExceeded?: boolean
}

/** Executor contract; production uses {@link spawnCodexProcess}, tests use fakes. */
export interface ProcessExecutor {
  run(request: {
    command: readonly string[]
    cwd: string
    stdinText: string
    timeoutMs: number
    signal?: AbortSignal
    /** Combined stdout+stderr cap in bytes (defaults to 64 MiB). */
    maxOutputBytes?: number
  }): Promise<ProcessResult>
}

/** Default cap for combined stdout+stderr collected from one Codex run. */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** Grace period before force-settling a killed run if 'close' never arrives. */
const KILL_SETTLE_GRACE_MS = 3000

/** Signal used to terminate the whole child process tree. */
const TREE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL'

function isJavaScriptEntry(file: string): boolean {
  return /\.(?:c|m)?js$/i.test(file)
}

function isCmdEntry(file: string): boolean {
  return /\.(?:cmd|bat)$/i.test(file)
}

/** Read the live AbortSignal state without retaining a stale type narrowing. */
function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Resolve the spawn target for a Codex CLI command. JS entries run under the
 * current Node runtime; native entries (including the bare `codex`
 * executable on PATH) launch directly. .cmd/.bat launchers are rejected:
 * callers should point CODEX_CLI_PATH at the underlying .js or .exe entry.
 */
function resolveSpawnTarget(command: readonly string[]): {
  file: string
  args: string[]
  detached: boolean
} {
  const [entry, ...rest] = command
  if (isJavaScriptEntry(entry)) {
    return { file: process.execPath, args: [entry, ...rest], detached: process.platform !== 'win32' }
  }
  if (isCmdEntry(entry)) {
    throw new TypeError(
      'taskflow: .cmd/.bat launchers are not supported; set CODEX_CLI_PATH to the underlying .js or .exe entry',
    )
  }
  return { file: entry, args: [...rest], detached: process.platform !== 'win32' }
}

/**
 * Terminate the entire process tree of one spawned child. POSIX children are
 * spawned detached into their own process group, so `kill(-pid)` reaches every
 * descendant; Windows uses `taskkill /T /F` with argv-only arguments (the PID
 * is a plain argument, never a shell expression).
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill(TREE_KILL_SIGNAL)
    return
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  } else {
    try {
      process.kill(-pid, TREE_KILL_SIGNAL)
    } catch {
      child.kill(TREE_KILL_SIGNAL)
    }
  }
}

/**
 * Production executor: resolves the CLI entry (Node script or native
 * executable), writes the prompt to stdin, collects
 * stdout/stderr under a hard output cap, and terminates the whole child
 * process tree on timeout, abort, or output-limit overflow. Every run settles
 * exactly once and always removes the timer and abort listener.
 */
export const spawnCodexProcess: ProcessExecutor = {
  async run(request) {
    if (request.command.length === 0) {
      throw new TypeError('taskflow: spawnCodexProcess requires a non-empty command')
    }
    if (isAbortRequested(request.signal)) {
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true }
    }
    const maxOutputBytes = Math.floor(request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
    if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new TypeError('taskflow: maxOutputBytes must be a positive finite number')
    }
    const timeoutMs = Math.floor(request.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('taskflow: timeoutMs must be a positive finite number')
    }
    const { file, args, detached } = resolveSpawnTarget(request.command)
    return new Promise((resolve) => {
      const child = spawn(file, args, {
        cwd: request.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached,
      })
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let aborted = false
      let outputLimitExceeded = false
      let settled = false
      let timer: NodeJS.Timeout | undefined
      let killFallbackTimer: NodeJS.Timeout | undefined

      function cleanup(): void {
        if (timer !== undefined) clearTimeout(timer)
        if (killFallbackTimer !== undefined) clearTimeout(killFallbackTimer)
        request.signal?.removeEventListener('abort', onAbort)
      }
      function settle(result: ProcessResult): void {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      function armKillFallback(): void {
        if (killFallbackTimer !== undefined) return
        killFallbackTimer = setTimeout(() => {
          settle({
            exitCode: null,
            stdout,
            stderr,
            timedOut,
            ...(aborted ? { aborted: true } : {}),
            ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
          })
        }, KILL_SETTLE_GRACE_MS)
      }
      function onAbort(): void {
        aborted = true
        killProcessTree(child)
        armKillFallback()
      }
      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
        armKillFallback()
      }, timeoutMs)

      if (isAbortRequested(request.signal)) {
        onAbort()
      } else {
        request.signal?.addEventListener('abort', onAbort, { once: true })
        // abort() can dispatch synchronously on Node's EventTarget, so the
        // signal may flip between the check and the registration; re-check.
        if (isAbortRequested(request.signal)) onAbort()
      }
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || outputLimitExceeded) return
        const remaining = Math.max(0, maxOutputBytes - stdoutBytes - stderrBytes)
        if (remaining > 0) stdout += chunk.subarray(0, remaining).toString('utf8')
        stdoutBytes += chunk.length
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputLimitExceeded = true
          killProcessTree(child)
          armKillFallback()
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled || outputLimitExceeded) return
        const remaining = Math.max(0, maxOutputBytes - stdoutBytes - stderrBytes)
        if (remaining > 0) stderr += chunk.subarray(0, remaining).toString('utf8')
        stderrBytes += chunk.length
        if (stdoutBytes + stderrBytes > maxOutputBytes) {
          outputLimitExceeded = true
          killProcessTree(child)
          armKillFallback()
        }
      })
      child.stdout.on('error', () => undefined)
      child.stderr.on('error', () => undefined)
      child.stdin.on('error', () => undefined)
      child.on('error', (error) => {
        settle({
          exitCode: null,
          stdout,
          stderr: `${stderr}\n${error.message}`,
          timedOut,
          ...(aborted ? { aborted: true } : {}),
          ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        })
      })
      child.on('close', (code) => {
        const exitCode = timedOut || aborted || outputLimitExceeded ? null : code
        settle({
          exitCode,
          stdout,
          stderr,
          timedOut,
          ...(aborted ? { aborted: true } : {}),
          ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        })
      })
      child.stdin.write(request.stdinText)
      child.stdin.end()
    })
  },
}

/** Input handed to the planner. */
export interface PlanInput {
  title: string
  description: string
  /** Repo root the Codex run works in (read-only). */
  repoRoot: string
  /** Spool/work directory for the schema file and artifacts. */
  workDir: string
  /** Optional cancellation signal forwarded to the process executor. */
  signal?: AbortSignal
}

/** Plan outcome: the validated issue list (validation happens in the service). */
export type PlanResult = readonly PlannedIssue[]

/** The planning prompt template (Chinese, task-pack style). */
export function buildPlanPrompt(input: PlanInput): string {
  return [
    '你是任务规划器。请把下面的任务目标拆分为一组可独立验收的实施 Issue，并以 JSON 输出（输出必须符合 --output-schema 给定的 JSON Schema）。',
    '',
    '## 任务目标',
    input.title,
    input.description !== '' ? input.description : '（无附加描述）',
    '',
    '## 输出要求',
    '- `issues` 数组，每项含：`key`（唯一，如 issue-001）、`taskId`（可选，项目内原始任务 ID，如 TF-000）、`acceptance`（非空验收标准）、`deps`（依赖的 issue key 数组，可省略）、`risk`（L1/L2/L3，可省略）',
    '- Issue 粒度：每个 Issue 应可独立执行与验收；按依赖关系组织（无环）',
    '- 只输出 JSON，不要输出其他说明文字',
  ].join('\n')
}

/** The JSON Schema handed to `codex exec --output-schema`. Codex applies
 * strict Structured Outputs: every object must set `additionalProperties:
 * false` and every declared property must be required (optional values are
 * modeled as nullable). Verified against a real `codex exec --json` run. */
export const PLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'acceptance', 'deps', 'risk'],
        properties: {
          key: { type: 'string', minLength: 1 },
          taskId: { type: 'string' },
          acceptance: { type: 'string', minLength: 1 },
          deps: { type: 'array', items: { type: 'string' } },
          risk: { type: ['string', 'null'], enum: ['L1', 'L2', 'L3', null] },
        },
      },
    },
  },
}

/** Write the schema file into the spool work dir. */
export async function writePlanSchema(workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true })
  const path = join(workDir, 'plan.schema.json')
  await writeFile(path, JSON.stringify(PLAN_OUTPUT_SCHEMA, null, 2), 'utf8')
  return path
}

/**
 * Extract the last assistant text message from a `codex exec --json` event
 * stream. The production CLI emits `item.completed` events whose `item` is an
 * `agent_message` with `text` (verified against a real run); the
 * `response_item`/`payload.message` shape is kept as a secondary fallback for
 * other CLI builds.
 */
export function lastAssistantText(stdout: string): string | undefined {
  let last: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: {
      type?: string
      item?: { type?: string; text?: string }
      payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }
    }
    try {
      event = JSON.parse(trimmed) as typeof event
    } catch {
      continue // malformed line: skip, do not fail the parse of the rest
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text !== undefined) {
      if (event.item.text !== '') last = event.item.text
      continue
    }
    if (event.type === 'response_item' && event.payload?.type === 'message' && event.payload.role === 'assistant') {
      const text = (event.payload.content ?? [])
        .filter((block) => block.type === 'output_text' || block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (text !== '') last = text
    }
  }
  return last
}

/** Parse the plan object out of the final assistant text. */
export function parsePlanText(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new PlannerError('parse-failed', 'no JSON object in planner output')
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown
}

/** Default planner timeout: 15 minutes (the phase gate for Codex runs). */
export const DEFAULT_PLAN_TIMEOUT_MS = 15 * 60 * 1000

/** Default planner retries for infrastructure failures (timeout/process). */
export const DEFAULT_PLAN_MAX_RETRIES = 1

/**
 * Resolve the Codex CLI entry to spawn. Order: explicit `CODEX_CLI_PATH`
 * environment override, the npm-global node entry on Windows, else the bare
 * `codex` executable (launched directly on Unix; on Windows it must resolve
 * to an .exe or use `CODEX_CLI_PATH` for the underlying .js entry).
 */
export function resolveCodexCli(): string {
  const explicit = process.env.CODEX_CLI_PATH
  if (explicit !== undefined && explicit !== '') {
    return explicit
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData !== undefined && appData !== '') {
      const candidate = join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (existsSync(candidate)) return candidate
    }
  }
  return 'codex'
}

/**
 * The Codex planner adapter: runs `codex exec` read-only + ephemeral with a
 * strict output schema, parses the final assistant message, and returns the
 * raw plan object. Service-level validation (validatePlan) stays in the
 * service; this adapter only guarantees a parseable plan object.
 */
export class CodexPlanner {
  constructor(
    private readonly executor: ProcessExecutor = spawnCodexProcess,
    private readonly timeoutMs: number = DEFAULT_PLAN_TIMEOUT_MS,
    private readonly maxRetries: number = DEFAULT_PLAN_MAX_RETRIES,
    private readonly cliPath: string = resolveCodexCli(),
  ) {}

  /** Produce a plan object for one run; never mutates the repo (read-only + ephemeral). */
  async plan(input: PlanInput): Promise<unknown> {
    const schemaPath = await writePlanSchema(input.workDir)
    const prompt = buildPlanPrompt(input)
    // Canonicalize once: cwd and --cd share one absolute path so a relative
    // repoRoot can never resolve as repo/repo.
    const repoRoot = resolve(input.repoRoot)
    const command = [
      this.cliPath,
      'exec',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="max"',
      '--strict-config',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--color', 'never',
      '--cd', repoRoot,
      '--output-schema', schemaPath,
      '--json',
      '-',
    ]

    let lastError: PlannerError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const result = await this.executor.run({
        command,
        cwd: repoRoot,
        stdinText: prompt,
        timeoutMs: this.timeoutMs,
        signal: input.signal,
      })
      if (result.aborted === true) {
        throw new PlannerError('process-failed', 'aborted')
      }
      if (result.outputLimitExceeded === true) {
        throw new PlannerError('process-failed', 'output limit exceeded')
      }
      if (result.timedOut) {
        lastError = new PlannerError('timeout', `codex exec exceeded ${this.timeoutMs}ms`)
        continue
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim()
        throw new PlannerError('process-failed', `codex exec exited ${String(result.exitCode)}`, detail.slice(0, 2000))
      }
      const text = lastAssistantText(result.stdout)
      if (text === undefined) {
        throw new PlannerError('no-plan-output', 'no assistant message in codex event stream')
      }
      try {
        return parsePlanText(text)
      } catch (error) {
        throw new PlannerError('parse-failed', `planner output is not JSON: ${(error as Error).message}`)
      }
    }
    throw lastError ?? new PlannerError('process-failed', 'planner failed')
  }
}
