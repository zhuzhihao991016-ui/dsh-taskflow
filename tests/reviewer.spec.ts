/**
 * P4 reviewer tests: the Codex CLI review adapter contract — exact argv,
 * stdin prompt, schema file materialization, JSONL parsing, exit-code handling,
 * timeout retry, and parse failures — all driven through a fake executor.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { IssueExecution } from '../src/domain.ts'
import type { ProcessExecutor, ProcessResult } from '../src/planner.ts'
import {
  CodexReviewer,
  ReviewerError,
  buildReviewPrompt,
  parseReviewText,
  writeReviewSchema,
  type ReviewInput,
} from '../src/reviewer.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taskflow-review-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

/** Fake executor recording requests and returning scripted results. */
class FakeExecutor implements ProcessExecutor {
  readonly requests: Array<{
    command: readonly string[]
    cwd: string
    stdinText: string
    signal?: AbortSignal
    maxOutputBytes?: number
  }> = []
  results: ProcessResult[] = []

  run(request: {
    command: readonly string[]
    cwd: string
    stdinText: string
    timeoutMs: number
    signal?: AbortSignal
    maxOutputBytes?: number
  }): Promise<ProcessResult> {
    this.requests.push({
      command: request.command,
      cwd: request.cwd,
      stdinText: request.stdinText,
      signal: request.signal,
      maxOutputBytes: request.maxOutputBytes,
    })
    const result = this.results.shift()
    if (result === undefined) {
      return Promise.reject(new Error('fake executor: no scripted result'))
    }
    return Promise.resolve(result)
  }
}

/** Real `codex exec --json` event shape (verified against a live run). */
function agentMessageEvent(text: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text },
  })
}

const REVIEW_JSON = JSON.stringify({
  verdict: 'PASS',
  nextAction: 'CONTINUE',
  summary: '全部验收通过',
  reworkKeys: [],
})

const ISSUES: PlannedIssue[] = [
  { key: 'issue-001', acceptance: '验收 A', deps: [], risk: null },
  { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'], risk: 'L2' },
]

const EXECUTIONS: IssueExecution[] = [
  { key: 'issue-001', status: 'done', startedAt: 1, finishedAt: 2, summary: '完成 A' },
  { key: 'issue-002', status: 'done', startedAt: 3, finishedAt: 4, summary: '完成 B' },
]

const INPUT: ReviewInput = {
  runId: 'run-0001',
  title: '升级后端',
  description: 'agtscp2.0',
  repoRoot: 'C:/repo',
  issues: ISSUES,
  executions: EXECUTIONS,
  workDir: '',
}

describe('parseReviewText', () => {
  it('parses a JSON object wrapped in prose', () => {
    expect(parseReviewText(`说明\n${REVIEW_JSON}\n结束`)).toEqual(JSON.parse(REVIEW_JSON))
  })

  it('throws a stable parse error on non-JSON output', () => {
    expect(() => parseReviewText('no braces here')).toThrow('no JSON object')
  })
})

describe('writeReviewSchema', () => {
  it('materializes the strict review schema', async () => {
    const root = await freshRoot()
    const path = await writeReviewSchema(join(root, 'spool'))
    const schema = JSON.parse(await readFile(path, 'utf8')) as {
      required?: string[]
      additionalProperties?: boolean
      properties?: { verdict?: { enum?: string[] }; nextAction?: { enum?: string[] }; reworkKeys?: { type?: string } }
    }
    expect(schema.required).toEqual(['verdict', 'nextAction', 'summary', 'reworkKeys'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties?.verdict?.enum).toEqual(['PASS', 'REVISE'])
    expect(schema.properties?.nextAction?.enum).toEqual(['CONTINUE', 'FIX', 'REPLAN'])
    expect(schema.properties?.reworkKeys?.type).toBe('array')
  })
})

describe('CodexReviewer', () => {
  it('runs codex exec review with the gated argv, prompt on stdin, and returns the parsed review', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(REVIEW_JSON), stderr: '', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)

    const review = await reviewer.review({ ...INPUT, workDir: join(root, 'spool') })

    expect(review).toEqual(JSON.parse(REVIEW_JSON))
    expect(executor.requests).toHaveLength(1)
    const request = executor.requests[0]
    const repoRoot = resolve(INPUT.repoRoot)
    expect(request.command).toEqual([
      expect.stringMatching(/codex\.js$/),
      'exec',
      'review',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="max"',
      '--config', 'sandbox_mode="read-only"',
      '--strict-config',
      '--ephemeral',
      '--uncommitted',
      '--output-schema', join(root, 'spool', 'review.schema.json'),
      '--json',
      '-',
    ])
    expect(request.cwd).toBe(repoRoot)
    expect(request.stdinText).toContain('升级后端')
    expect(request.stdinText).toContain('验收 A')
    expect(request.stdinText).toContain('完成 B')
    expect(request.stdinText).toContain('REVISE')
    expect(request.stdinText).toContain('FINAL')
  })

  it('uses medium reasoning and the issue worktree for a CHECKPOINT review', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(REVIEW_JSON), stderr: '', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)
    const reviewRoot = join(root, 'issue-worktree')

    await reviewer.review({
      ...INPUT,
      stage: 'CHECKPOINT',
      issueKey: 'issue-001',
      reviewRoot,
      reviewBaseSha: 'base123',
      reviewTargetBranch: 'taskflow/run-0001/issue-001',
      reviewTargetHeadSha: 'head456',
      workDir: join(root, 'checkpoint-spool'),
    })

    const request = executor.requests[0]
    expect(request.command).toContain('model_reasoning_effort="medium"')
    expect(request.cwd).toBe(resolve(reviewRoot))
    expect(request.stdinText).toContain('CHECKPOINT')
    expect(request.stdinText).toContain('issue-001')
    expect(request.stdinText).toContain('方向')
    expect(request.stdinText).toContain('REPLAN')
  })

  it('forwards an optional abort signal to the process executor', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(REVIEW_JSON), stderr: '', timedOut: false }]
    const controller = new AbortController()
    const reviewer = new CodexReviewer(executor, 60_000)

    await reviewer.review({ ...INPUT, workDir: join(root, 'spool'), signal: controller.signal })

    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0].signal).toBe(controller.signal)
  })

  it('treats an abort/timeout race as cancellation without retrying', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: null, stdout: '', stderr: '', timedOut: true, aborted: true }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 'spool') })).rejects.toMatchObject({
      code: 'process-failed',
      message: expect.stringContaining('aborted'),
    })
    expect(executor.requests).toHaveLength(1)
  })

  it('reports output-limit termination without retrying', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{
      exitCode: null,
      stdout: 'truncated',
      stderr: '',
      timedOut: false,
      outputLimitExceeded: true,
    }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 'spool') })).rejects.toMatchObject({
      code: 'process-failed',
      message: expect.stringContaining('output limit exceeded'),
    })
    expect(executor.requests).toHaveLength(1)
  })

  it('canonicalizes a relative repoRoot once for cwd', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(REVIEW_JSON), stderr: '', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await reviewer.review({ ...INPUT, repoRoot: './repo', workDir: join(root, 's') })

    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0].cwd).toBe(resolve('./repo'))
  })

  it('uses generic codex exec with --cd and baseSha when reviewing an integration diff', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(REVIEW_JSON), stderr: '', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await reviewer.review({
      ...INPUT,
      baseSha: 'abc123',
      integrationBranch: 'taskflow/integration',
      integrationHeadSha: 'def456',
      workDir: join(root, 's'),
    })

    expect(executor.requests).toHaveLength(1)
    const request = executor.requests[0]
    expect(request.command).not.toContain('review')
    expect(request.command).toContain('--cd')
    expect(request.command).toContain('--output-schema')
    expect(request.command).not.toContain('--uncommitted')
    expect(request.stdinText).toContain('abc123')
    expect(request.stdinText).toContain('def456')
    expect(request.stdinText).toContain('taskflow/integration')
    expect(request.cwd).toBe(resolve(INPUT.repoRoot))
  })

  it('throws process-failed with stderr detail on a non-zero exit', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 2, stdout: '', stderr: 'boom', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      name: 'ReviewerError',
      code: 'process-failed',
    })
  })

  it('retries once on timeout and fails with a stable timeout error after both attempts', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
    ]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(executor.requests).toHaveLength(2)
  })

  it('succeeds when the retry after a timeout returns a review', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
      { exitCode: 0, stdout: agentMessageEvent(REVIEW_JSON), stderr: '', timedOut: false },
    ]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 's') })).resolves.toEqual(JSON.parse(REVIEW_JSON))
  })

  it('fails with no-review-output when the stream has no assistant message', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: '{"type":"event_msg"}\n', stderr: '', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'no-review-output',
    })
  })

  it('fails with parse-failed when the assistant text is not JSON', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent('抱歉，无法完成'), stderr: '', timedOut: false }]
    const reviewer = new CodexReviewer(executor, 60_000)

    await expect(reviewer.review({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'parse-failed',
    })
  })
})

describe('buildReviewPrompt', () => {
  it('carries title, description, acceptance criteria, and review requirements', () => {
    const prompt = buildReviewPrompt(INPUT)
    expect(prompt).toContain('升级后端')
    expect(prompt).toContain('agtscp2.0')
    expect(prompt).toContain('验收 A')
    expect(prompt).toContain('--output-schema')
    expect(prompt).toContain('REVISE')
  })
})

describe('ReviewerError', () => {
  it('carries a stable taskflow-prefixed message', () => {
    const error = new ReviewerError('timeout', 'took too long')
    expect(error.message).toBe('taskflow: reviewer timeout: took too long')
    expect(error.code).toBe('timeout')
  })
})
