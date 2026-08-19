/**
 * P2 Planner adapter: drives the Codex CLI (`codex exec`) in a read-only,
 * ephemeral, schema-constrained run to produce the Issue plan for a run,
 * then parses the JSONL event stream back into issue objects. The process
 * executor is injectable so contract tests drive the adapter with fakes;
 * the production executor spawns the npm-global Codex CLI directly (node
 * entry, no shell).
 */

import { spawn } from 'node:child_process'
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
}

/** Executor contract; production uses {@link spawnCodexProcess}, tests use fakes. */
export interface ProcessExecutor {
  run(request: {
    command: readonly string[]
    cwd: string
    stdinText: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<ProcessResult>
}

/**
 * Production executor: spawns the Codex CLI node entry with the given argv,
 * writes the prompt to stdin, collects stdout/stderr, and kills the process
 * (then waits for exit) on timeout or abort signal.
 */
export const spawnCodexProcess: ProcessExecutor = {
  async run(request) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...request.command], {
        cwd: request.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, request.timeoutMs)
      const onAbort = (): void => {
        child.kill()
      }
      if (request.signal?.aborted === true) {
        child.kill()
      } else {
        request.signal?.addEventListener('abort', onAbort, { once: true })
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => {
        cleanup()
        resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
      })
      child.on('close', (code) => {
        cleanup()
        resolve({ exitCode: code, stdout, stderr, timedOut })
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
    '- `issues` 数组，每项含：`key`（唯一，如 issue-001）、`acceptance`（非空验收标准）、`deps`（依赖的 issue key 数组，可省略）、`risk`（L1/L2/L3，可省略）',
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
 * `codex` executable (Unix PATH lookup by the spawned node process).
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
      })
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
