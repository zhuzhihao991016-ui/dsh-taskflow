/**
 * P8.2 Codex Issue Executor: drives the Codex CLI (`codex exec`) in a
 * workspace-write, non-interactive run to implement one planned Issue inside
 * its isolated Git worktree, then parses the JSONL event stream into the
 * automated executor result contract. The process executor is injectable so
 * contract tests drive the adapter with fakes; the production executor reuses
 * the planner's Codex process spawner.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  AutomatedExecutionInput,
  AutomatedExecutionResult,
  AutomatedExecutor,
} from './contracts.ts'
import {
  lastAssistantText,
  resolveCodexCli,
  spawnCodexProcess,
  type ProcessExecutor,
} from './planner.ts'

/** Stable error code for issue-executor failures (surfaced in run transitions). */
export type IssueExecutorErrorCode =
  | 'timeout'
  | 'process-failed'
  | 'parse-failed'
  | 'no-execution-output'

/** Stable issue-executor error. */
export class IssueExecutorError extends Error {
  constructor(
    readonly code: IssueExecutorErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(`taskflow: issue-executor ${code}: ${message}`)
    this.name = 'IssueExecutorError'
  }
}

/** The issue-execution prompt template (Chinese, task-pack style). */
export function buildIssuePrompt(input: AutomatedExecutionInput): string {
  const deps = (input.issue.deps ?? []).length > 0
    ? `，依赖 ${(input.issue.deps ?? []).join(', ')}`
    : ''
  const risk = input.issue.risk != null ? `，风险 ${input.issue.risk}` : ''
  return [
    '你是 Codex Issue Executor。请在当前工作目录中完成下面这个 Issue，并只输出符合 --output-schema 的 JSON。',
    '',
    '## 运行上下文',
    `- runId: ${input.runId}`,
    `- issueKey: ${input.issue.key}`,
    `- 仓库根: ${input.repoRoot}`,
    `- Issue 工作目录: ${input.workDir}`,
    '',
    '## 当前 Issue 与验收标准',
    `- ${input.issue.key}：${input.issue.acceptance}${deps}${risk}`,
    '',
    '## 执行要求',
    '- 当前 Codex 以 workspace-write 沙箱运行，可以修改工作目录内的文件',
    '- 只修改当前工作目录（Issue 独立 Git worktree）内的文件，不要修改工作目录之外的路径',
    '- 实现 Issue 并满足验收标准；可运行测试/构建验证',
    '- 完成后输出 JSON：`summary` 为简短的人工可读完成说明，`changedFiles` 为本次修改的文件列表',
    '- 如果无法完成，`error` 必须是非空字符串并简要说明原因，`blocker` 可补充阻塞信息',
    '- 只输出 JSON，不要输出其他说明文字',
  ].join('\n')
}

/** The JSON Schema handed to `codex exec --output-schema`. Strict Structured
 * Outputs: every object must set `additionalProperties: false` and every
 * declared property must be required (optional values are modeled as
 * nullable). */
export const ISSUE_EXECUTION_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changedFiles', 'error', 'blocker'],
  properties: {
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    error: { type: ['string', 'null'] },
    blocker: { type: ['string', 'null'] },
  },
}

/** Write the execution schema file into the issue worktree. */
export async function writeIssueExecutionSchema(workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true })
  const path = join(workDir, 'execution.schema.json')
  await writeFile(path, JSON.stringify(ISSUE_EXECUTION_OUTPUT_SCHEMA, null, 2), 'utf8')
  return path
}

/** Parse the issue-execution object out of the final assistant text. */
export function parseIssueResult(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new IssueExecutorError('parse-failed', 'no JSON object in issue executor output')
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown
}

/** Default issue-executor timeout: 15 minutes (the phase gate for Codex runs). */
export const DEFAULT_ISSUE_EXECUTOR_TIMEOUT_MS = 15 * 60 * 1000

/** Default issue-executor retries for infrastructure failures (timeout/process). */
export const DEFAULT_ISSUE_EXECUTOR_MAX_RETRIES = 1

/**
 * The Codex issue executor adapter: runs `codex exec` in the issue worktree
 * with a workspace-write sandbox and a strict output schema, parses the final
 * assistant message, and returns the automated executor result. The service
 * remains responsible for progress persistence and stale-attempt protection.
 */
export class CodexIssueExecutor implements AutomatedExecutor {
  constructor(
    private readonly executor: ProcessExecutor = spawnCodexProcess,
    private readonly timeoutMs: number = DEFAULT_ISSUE_EXECUTOR_TIMEOUT_MS,
    private readonly maxRetries: number = DEFAULT_ISSUE_EXECUTOR_MAX_RETRIES,
    private readonly cliPath: string = resolveCodexCli(),
  ) {}

  /** Implement one issue; never escapes the issue worktree (workspace-write sandbox). */
  async execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult> {
    const schemaPath = await writeIssueExecutionSchema(input.workDir)
    const prompt = buildIssuePrompt(input)
    // Canonicalize once: cwd and --cd share one absolute path so a relative
    // workDir can never resolve as repo/repo.
    const cwd = resolve(input.workDir)
    const command = [
      this.cliPath,
      'exec',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="high"',
      '--strict-config',
      '--sandbox', 'workspace-write',
      '--ask-for-approval', 'never',
      '--ephemeral',
      '--color', 'never',
      '--cd', cwd,
      '--output-schema', schemaPath,
      '--json',
      '-',
    ]

    const abortPromise = input.signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          if (input.signal?.aborted === true) {
            reject(new IssueExecutorError('process-failed', 'aborted before start'))
            return
          }
          input.signal?.addEventListener('abort', () => {
            reject(new IssueExecutorError('process-failed', 'aborted'))
          }, { once: true })
        })

    let lastError: IssueExecutorError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      input.onProgress?.({ phase: 'preparing', summary: `开始执行 ${input.issue.key}`, at: Date.now() })
      input.onProgress?.({ phase: 'running', summary: `正在执行 ${input.issue.key}`, at: Date.now() })
      const result = abortPromise === undefined
        ? await this.executor.run({
            command,
            cwd,
            stdinText: prompt,
            timeoutMs: this.timeoutMs,
          })
        : await Promise.race([
            this.executor.run({
              command,
              cwd,
              stdinText: prompt,
              timeoutMs: this.timeoutMs,
            }),
            abortPromise,
          ])
      if (result.timedOut) {
        lastError = new IssueExecutorError('timeout', `codex exec exceeded ${this.timeoutMs}ms`)
        continue
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim()
        throw new IssueExecutorError('process-failed', `codex exec exited ${String(result.exitCode)}`, detail.slice(0, 2000))
      }
      const text = lastAssistantText(result.stdout)
      if (text === undefined) {
        throw new IssueExecutorError('no-execution-output', 'no assistant message in codex exec event stream')
      }
      try {
        const result = this.normalizeResult(input, parseIssueResult(text))
        if (result.ok) {
          input.onProgress?.({ phase: 'done', summary: result.summary, at: Date.now() })
        } else {
          input.onProgress?.({ phase: 'failed', summary: result.error, at: Date.now() })
        }
        return result
      } catch (error) {
        if (error instanceof IssueExecutorError) throw error
        throw new IssueExecutorError('parse-failed', `executor output is not JSON: ${(error as Error).message}`)
      }
    }
    throw lastError ?? new IssueExecutorError('process-failed', 'issue executor failed')
  }

  private normalizeResult(input: AutomatedExecutionInput, raw: unknown): AutomatedExecutionResult {
    const object = (raw ?? {}) as {
      summary?: unknown
      changedFiles?: unknown
      error?: unknown
      blocker?: unknown
    }
    const error = typeof object.error === 'string' && object.error !== '' ? object.error : undefined
    if (error !== undefined) {
      const blocker = typeof object.blocker === 'string' && object.blocker !== '' ? object.blocker : undefined
      return {
        ok: false,
        error,
        attemptId: input.attemptId,
        phase: blocker === undefined ? 'failed' : 'blocked',
        blocker,
      }
    }
    if (typeof object.summary !== 'string' || object.summary === '') {
      throw new IssueExecutorError('parse-failed', 'executor output has no summary')
    }
    return {
      ok: true,
      summary: object.summary,
      attemptId: input.attemptId,
      phase: 'done',
      changedFiles: Array.isArray(object.changedFiles)
        ? object.changedFiles.filter((file): file is string => typeof file === 'string')
        : undefined,
    }
  }
}

/** Compatibility alias for consumers that use the shorter `CodexExecutor` name. */
export const CodexExecutor = CodexIssueExecutor
