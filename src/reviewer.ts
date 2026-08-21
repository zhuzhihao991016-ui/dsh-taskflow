/**
 * P4 Reviewer adapter: drives the Codex CLI review subcommand in a read-only,
 * ephemeral, schema-constrained run to decide whether an executed run may move
 * to human acceptance (PASS) or must be sent back for rework (REVISE). The
 * process executor is injectable so contract tests drive the adapter with
 * fakes; the production executor reuses the planner's Codex process spawner.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PlannedIssue } from './dag.ts'
import type { IssueExecution, ReviewNextAction, ReviewStage } from './domain.ts'
import { DEFAULT_CODEX_PROFILES, type CodexInvocationProfile } from './codex-profile.ts'
import {
  lastAssistantText,
  resolveCodexCli,
  spawnCodexProcess,
  type ProcessExecutor,
} from './planner.ts'

/** Stable error code for reviewer failures (surfaced in run transitions). */
export type ReviewerErrorCode =
  | 'timeout'
  | 'process-failed'
  | 'parse-failed'
  | 'no-review-output'

/** Stable reviewer error. */
export class ReviewerError extends Error {
  constructor(
    readonly code: ReviewerErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(`taskflow: reviewer ${code}: ${message}`)
    this.name = 'ReviewerError'
  }
}

/** Everything a reviewer needs to audit one completed run. */
export interface ReviewInput {
  /** Review kind; omitted by legacy callers and treated as FINAL. */
  stage?: ReviewStage
  /** Issue under review during a CHECKPOINT review. */
  issueKey?: string
  /** Owning run id, e.g. `run-0001`. */
  runId: string
  /** Run title (the original task goal). */
  title: string
  /** Run description when present. */
  description: string
  /** Repo root the executed changes live in (already allowlisted at planning). */
  repoRoot: string
  /** The validated planned issues (acceptance criteria drive the review). */
  issues: readonly PlannedIssue[]
  /** Per-issue execution outcomes (summaries/errors) to review. */
  executions: readonly IssueExecution[]
  /** Spool directory for this run's review artifacts. */
  workDir: string
  /** Optional worktree in which Codex should inspect the comparison. */
  reviewRoot?: string
  /** Optional cancellation signal forwarded to the process executor. */
  signal?: AbortSignal
  /** Neutral comparison range used by CHECKPOINT reviews. */
  reviewBaseSha?: string
  reviewTargetBranch?: string
  reviewTargetHeadSha?: string
  /** P5: base commit SHA the execution started from; when present the review
   * inspects the integration-branch diff against this SHA instead of
   * uncommitted changes. */
  baseSha?: string
  /** P5: persistent integration branch that successful issue worktrees merge into. */
  integrationBranch?: string
  /** P5: immutable head SHA of the integration branch at review time. */
  integrationHeadSha?: string
}

/** One structured review finding. */
export interface ReviewFinding {
  issueKey: string
  problem: string
  evidenceNeeded: readonly string[]
  acceptance: string
}

/** Review outcome plus the orchestration action selected by Codex. */
export type ReviewResult =
  | { verdict: 'PASS'; nextAction: Extract<ReviewNextAction, 'CONTINUE'>; summary: string; reworkKeys: readonly string[]; findings?: readonly ReviewFinding[]; evidenceChecklist?: readonly string[] }
  | { verdict: 'REVISE'; nextAction: Extract<ReviewNextAction, 'FIX' | 'REPLAN'>; summary: string; reworkKeys: readonly string[]; findings?: readonly ReviewFinding[]; evidenceChecklist?: readonly string[] }

export type { ReviewNextAction, ReviewStage } from './domain.ts'

/** Reviewer contract; production uses CodexReviewer, tests use fakes. The
 * adapter returns the raw parsed object; service-level validation converts it
 * to a typed ReviewResult. */
export interface Reviewer {
  review(input: ReviewInput): Promise<unknown>
}

/** The review prompt template (Chinese, task-pack style). */
export function buildReviewPrompt(input: ReviewInput): string {
  const stage = input.stage ?? 'FINAL'
  const reviewBaseSha = input.reviewBaseSha ?? input.baseSha
  const reviewTargetBranch = input.reviewTargetBranch ?? input.integrationBranch
  const reviewTargetHeadSha = input.reviewTargetHeadSha ?? input.integrationHeadSha
  const issueLines = input.issues.map((issue) => {
    const deps = (issue.deps ?? []).length > 0 ? `，依赖 ${(issue.deps ?? []).join(', ')}` : ''
    const risk = issue.risk != null ? `，风险 ${issue.risk}` : ''
    return `- ${issue.key}：${issue.acceptance}${deps}${risk}`
  }).join('\n')
  const executionLines = input.executions.map((execution) => {
    const outcome = execution.status === 'done'
      ? `完成：${execution.summary ?? ''}`
      : execution.status === 'failed'
        ? `失败：${execution.error ?? ''}`
        : execution.status
    return `- ${execution.key}：${outcome}`
  }).join('\n')
  return [
    stage === 'CHECKPOINT'
      ? '你是只读方向审查员。请审查刚完成的单个 Issue，确认实现方向、范围和架构没有偏离任务与计划。'
      : '你是只读终审员。请对全部已执行 Issue 及其集成结果进行完整终审，并给出最终结论。',
    '',
    '## 审查阶段',
    stage === 'CHECKPOINT'
      ? `CHECKPOINT（聚焦 ${input.issueKey ?? '当前 Issue'}，仅做合并前方向检查）`
      : 'FINAL（全部步骤完成后的最终审查）',
    '',
    '## 任务',
    input.title,
    input.description !== '' ? input.description : '（无附加描述）',
    '',
    '## 仓库根',
    input.repoRoot,
    input.reviewRoot !== undefined ? `审查工作树：${input.reviewRoot}` : '',
    '',
    '## Issue 与验收标准',
    issueLines,
    '',
    '## 执行结果',
    executionLines === '' ? '（无）' : executionLines,
    '',
    '## 审查要求',
    reviewBaseSha !== undefined && reviewTargetHeadSha !== undefined
      ? `- 只读审查基准 ${reviewBaseSha} 到目标分支 ${reviewTargetBranch ?? '当前目标分支'} 头 ${reviewTargetHeadSha} 的改动，用 git diff/range 审查该区间，不得修改任何文件`
      : reviewBaseSha !== undefined
        ? `- 只读审查当前仓库相对基准 ${reviewBaseSha} 的改动，不得修改任何文件`
        : '- 只读审查当前仓库的未提交改动（uncommitted changes），不得修改任何文件',
    stage === 'CHECKPOINT'
      ? '- 重点判断当前 Issue 是否沿着正确方向推进：是否偏离目标、越界扩张、采用错误架构、破坏既定依赖或使后续步骤建立在错误前提上；不要把非必要润色当成阻断项'
      : '- 完整判断全部 Issue 是否满足验收标准、集成行为是否正确、整体是否可进入人工验收',
    '- 输出必须符合 --output-schema 给定的 JSON Schema，只输出 JSON',
    '- `verdict` 为 PASS 表示通过；REVISE 表示需要打回返工',
    '- `nextAction`：PASS 时必须为 CONTINUE；REVISE 且问题可在当前计划内局部修复时为 FIX；若任务拆分、技术路线、核心假设或跨 Issue 方向错误时为 REPLAN',
    '- `reworkKeys` 为需要返工的 Issue key 数组；PASS 时必须为空数组，REVISE 时列出需要返工的 key（空数组表示全部返工）',
    '- 当 REVISE 时，`findings` 必须给出结构化问题清单：每项含 `issueKey`、`problem`、`evidenceNeeded`（待补证据清单）、`acceptance`（对应验收标准）',
    '- `evidenceChecklist` 为所有 findings 的 evidenceNeeded 汇总清单，便于后续执行/验收映射',
  ].join('\n')
}

/** The JSON Schema handed to `codex exec review --output-schema`. Strict
 * Structured Outputs: every object must set `additionalProperties: false` and
 * every declared property must be required. */
export const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'nextAction', 'summary', 'reworkKeys'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'REVISE'] },
    nextAction: { type: 'string', enum: ['CONTINUE', 'FIX', 'REPLAN'] },
    summary: { type: 'string' },
    reworkKeys: { type: 'array', items: { type: 'string' } },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['issueKey', 'problem', 'evidenceNeeded', 'acceptance'],
          properties: {
            issueKey: { type: 'string' },
            problem: { type: 'string' },
            evidenceNeeded: { type: 'array', items: { type: 'string' } },
            acceptance: { type: 'string' },
          },
        },
      },
      evidenceChecklist: { type: 'array', items: { type: 'string' } },
  },
}

/** Write the review schema file into the spool work dir. */
export async function writeReviewSchema(workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true })
  const path = join(workDir, 'review.schema.json')
  await writeFile(path, JSON.stringify(REVIEW_OUTPUT_SCHEMA, null, 2), 'utf8')
  return path
}

/** Parse the review object out of the final assistant text. */
export function parseReviewText(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new ReviewerError('parse-failed', 'no JSON object in reviewer output')
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown
}

/** Default reviewer timeout: 15 minutes (the phase gate for Codex runs). */
export const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60 * 1000

/** Default reviewer retries for infrastructure failures (timeout/process). */
export const DEFAULT_REVIEW_MAX_RETRIES = 1

/**
 * The Codex reviewer adapter: runs `codex exec review` read-only + ephemeral
 * with a strict output schema, parses the final assistant message, and returns
 * the raw review object. Service-level validation (verdict/rework keys) stays
 * in the service; this adapter only guarantees a parseable review object.
 */
export class CodexReviewer {
  constructor(
    private readonly executor: ProcessExecutor = spawnCodexProcess,
    private readonly timeoutMs: number = DEFAULT_REVIEW_TIMEOUT_MS,
    private readonly maxRetries: number = DEFAULT_REVIEW_MAX_RETRIES,
    private readonly cliPath: string = resolveCodexCli(),
    private readonly profile?: (stage: ReviewStage) => CodexInvocationProfile,
  ) {}

  /** Produce a review object for one completed run; never mutates the repo
   * (read-only + ephemeral). */
  async review(input: ReviewInput): Promise<unknown> {
    const schemaPath = await writeReviewSchema(input.workDir)
    const prompt = buildReviewPrompt(input)
    const stage = input.stage ?? 'FINAL'
    const profile = this.profile?.(stage) ?? {
      ...(stage === 'CHECKPOINT' ? DEFAULT_CODEX_PROFILES.checkpoint : DEFAULT_CODEX_PROFILES.final),
    }
    const cliPath = profile.cliPath?.trim() || this.cliPath
    const comparisonBaseSha = input.reviewBaseSha ?? input.baseSha
    // Canonicalize once: checkpoint reviews run inside the issue worktree;
    // final reviews run against the owning repository root.
    const repoRoot = resolve(input.reviewRoot ?? input.repoRoot)
    // With a base SHA (P5 integration-branch review) the `codex exec review
    // --base` form cannot carry a custom prompt in Codex 0.146.0, so use the
    // generic `codex exec` read-only form with --cd and include the base in
    // the prompt. Without a base SHA keep the P4 `review --uncommitted` form.
    const command = comparisonBaseSha !== undefined
      ? [
          cliPath,
          'exec',
          '--model', profile.model,
          '--config', 'model_reasoning_effort=' + JSON.stringify(profile.reasoningEffort),
          '--config', 'sandbox_mode="read-only"',
          '--strict-config',
          '--ephemeral',
          '--color', 'never',
          '--cd', repoRoot,
          '--output-schema', schemaPath,
          '--json',
          '-',
        ]
      : [
          cliPath,
          'exec',
          'review',
          '--model', profile.model,
          '--config', 'model_reasoning_effort=' + JSON.stringify(profile.reasoningEffort),
          '--config', 'sandbox_mode="read-only"',
          '--strict-config',
          '--ephemeral',
          '--uncommitted',
          '--output-schema', schemaPath,
          '--json',
          '-',
        ]

    let lastError: ReviewerError | undefined
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const result = await this.executor.run({
        command,
        cwd: repoRoot,
        stdinText: prompt,
        timeoutMs: this.timeoutMs,
        signal: input.signal,
      })
      if (result.aborted === true) {
        throw new ReviewerError('process-failed', 'aborted')
      }
      if (result.outputLimitExceeded === true) {
        throw new ReviewerError('process-failed', 'output limit exceeded')
      }
      if (result.timedOut) {
        lastError = new ReviewerError('timeout', `codex exec review exceeded ${this.timeoutMs}ms`)
        continue
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim()
        throw new ReviewerError('process-failed', `codex exec review exited ${String(result.exitCode)}`, detail.slice(0, 2000))
      }
      const text = lastAssistantText(result.stdout)
      if (text === undefined) {
        throw new ReviewerError('no-review-output', 'no assistant message in codex review event stream')
      }
      try {
        return parseReviewText(text)
      } catch (error) {
        throw new ReviewerError('parse-failed', `reviewer output is not JSON: ${(error as Error).message}`)
      }
    }
    throw lastError ?? new ReviewerError('process-failed', 'reviewer failed')
  }
}
