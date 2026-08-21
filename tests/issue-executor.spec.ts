/**
 * P8.2 Codex Issue Executor tests: the Codex CLI adapter contract — exact
 * argv, stdin prompt, schema file materialization, JSONL parsing, exit-code
 * handling, timeout retry, and parse failures — all driven through a fake
 * executor.
 */

import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomatedExecutionInput } from '../src/contracts.ts'
import type { ProcessExecutor, ProcessResult } from '../src/planner.ts'
import {
  CodexIssueExecutor,
  IssueExecutorError,
  buildIssuePrompt,
  parseIssueResult,
  writeIssueExecutionSchema,
} from '../src/issue-executor.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taskflow-issue-executor-'))
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

/** Fake executor that holds each run pending until the test releases it. */
class ControlledExecutor implements ProcessExecutor {
  readonly pending: Array<{
    request: {
      command: readonly string[]
      cwd: string
      stdinText: string
      timeoutMs: number
      signal?: AbortSignal
      maxOutputBytes?: number
    }
    resolve: (result: ProcessResult) => void
    reject: (error: Error) => void
  }> = []

  run(request: {
    command: readonly string[]
    cwd: string
    stdinText: string
    timeoutMs: number
    signal?: AbortSignal
    maxOutputBytes?: number
  }): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      this.pending.push({ request, resolve, reject })
    })
  }
}

/** Real `codex exec --json` event shape (verified against a live run). */
function agentMessageEvent(text: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text },
  })
}

const EXECUTION_JSON = JSON.stringify({
  summary: '完成 issue-001',
  changedFiles: ['src/a.ts'],
  error: null,
  blocker: null,
})

const INPUT: AutomatedExecutionInput = {
  runId: 'run-0001',
  issue: { key: 'issue-001', acceptance: '验收 A', deps: [], risk: null },
  repoRoot: 'C:/repo',
  workDir: '',
  attemptId: 'attempt-1',
}

describe('parseIssueResult', () => {
  it('parses a JSON object wrapped in prose', () => {
    expect(parseIssueResult(`说明\n${EXECUTION_JSON}\n结束`)).toEqual(JSON.parse(EXECUTION_JSON))
  })

  it('throws a stable parse error on non-JSON output', () => {
    expect(() => parseIssueResult('no braces here')).toThrow('no JSON object')
  })
})

describe('writeIssueExecutionSchema', () => {
  it('materializes the strict issue-execution schema', async () => {
    const root = await freshRoot()
    const path = await writeIssueExecutionSchema(join(root, 'spool'))
    const schema = JSON.parse(await readFile(path, 'utf8')) as {
      required?: string[]
      additionalProperties?: boolean
      properties?: { summary?: { type?: string }; changedFiles?: { type?: string } }
    }
    expect(schema.required).toEqual(['summary', 'changedFiles', 'error', 'blocker'])
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties?.summary?.type).toBe('string')
    expect(schema.properties?.changedFiles?.type).toBe('array')
  })
})

describe('CodexIssueExecutor', () => {
  it('runs codex exec with workspace-write argv, prompt on stdin, and returns the parsed result', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(EXECUTION_JSON), stderr: '', timedOut: false }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    const result = await issueExecutor.execute({ ...INPUT, workDir: join(root, 'spool') })

    expect(result).toMatchObject({ ok: true, summary: '完成 issue-001', attemptId: 'attempt-1' })
    expect(executor.requests).toHaveLength(1)
    const request = executor.requests[0]
    const cwd = resolve(join(root, 'spool'))
    expect(request.command).toEqual([
      expect.stringMatching(/codex\.js$/),
      'exec',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="high"',
      '--strict-config',
      '--sandbox', 'workspace-write',
      '--full-auto',
      '--ephemeral',
      '--color', 'never',
      '--cd', cwd,
      '--output-schema', join(root, 'spool', 'execution.schema.json'),
      '--json',
      '-',
    ])
    expect(request.cwd).toBe(cwd)
    expect(request.stdinText).toContain('issue-001')
    expect(request.stdinText).toContain('验收 A')
    expect(request.stdinText).toContain('workspace-write')
  })

  it('uses the same resolved workDir for cwd and --cd', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(EXECUTION_JSON), stderr: '', timedOut: false }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)
    const workDir = join(root, 'spool')

    await issueExecutor.execute({ ...INPUT, workDir })

    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0].cwd).toBe(resolve(workDir))
    const command = executor.requests[0].command
    const cdIndex = command.indexOf('--cd')
    expect(command[cdIndex + 1]).toBe(executor.requests[0].cwd)
  })

  it('passes the abort signal through to the process executor', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(EXECUTION_JSON), stderr: '', timedOut: false }]
    const controller = new AbortController()
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await issueExecutor.execute({ ...INPUT, workDir: join(root, 'spool'), signal: controller.signal })

    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0].signal).toBe(controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('treats an abort/timeout race as cancellation without retrying', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: null, stdout: '', stderr: '', timedOut: true, aborted: true }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 'spool') })).rejects.toMatchObject({
      code: 'process-failed',
      message: expect.stringContaining('aborted'),
    })
    expect(executor.requests).toHaveLength(1)
  })

  it('reports output-limit termination without retrying, ahead of timeout', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{
      exitCode: null,
      stdout: 'truncated',
      stderr: '',
      timedOut: true,
      outputLimitExceeded: true,
    }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'process-failed',
      message: expect.stringContaining('output limit exceeded'),
    })
    expect(executor.requests).toHaveLength(1)
  })

  it('rejects before starting a run when the signal is already aborted', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(EXECUTION_JSON), stderr: '', timedOut: false }]
    const controller = new AbortController()
    controller.abort()
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's'), signal: controller.signal })).rejects.toMatchObject({
      code: 'process-failed',
      message: /aborted before start/,
    })
    expect(executor.requests).toHaveLength(0)
  })

  it('rejects on a mid-run abort and cleans up the abort listener', async () => {
    const root = await freshRoot()
    const executor = new ControlledExecutor()
    const controller = new AbortController()
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)
    const pending = issueExecutor.execute({ ...INPUT, workDir: join(root, 's'), signal: controller.signal })

    await vi.waitFor(() => expect(executor.pending).toHaveLength(1))
    const entry = executor.pending[0]!
    expect(entry.request.signal).toBe(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      code: 'process-failed',
      message: /aborted/,
    })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('returns a failure result when the schema object has a non-empty error', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{
      exitCode: 0,
      stdout: agentMessageEvent(JSON.stringify({ summary: '', changedFiles: [], error: '无法完成', blocker: '缺少依赖' })),
      stderr: '',
      timedOut: false,
    }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    const result = await issueExecutor.execute({ ...INPUT, workDir: join(root, 'spool') })

    expect(result).toMatchObject({
      ok: false,
      error: '无法完成',
      attemptId: 'attempt-1',
      phase: 'blocked',
      blocker: '缺少依赖',
    })
  })

  it('throws process-failed with stderr detail on a non-zero exit', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 2, stdout: '', stderr: 'boom', timedOut: false }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      name: 'IssueExecutorError',
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
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(executor.requests).toHaveLength(2)
  })

  it('succeeds when the retry after a timeout returns an execution result', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
      { exitCode: 0, stdout: agentMessageEvent(EXECUTION_JSON), stderr: '', timedOut: false },
    ]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's') })).resolves.toMatchObject({
      ok: true,
      summary: '完成 issue-001',
    })
  })

  it('fails with no-execution-output when the stream has no assistant message', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: '{"type":"event_msg"}\n', stderr: '', timedOut: false }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'no-execution-output',
    })
  })

  it('fails with parse-failed when the assistant text is not JSON', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent('抱歉，无法完成'), stderr: '', timedOut: false }]
    const issueExecutor = new CodexIssueExecutor(executor, 60_000)

    await expect(issueExecutor.execute({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'parse-failed',
    })
  })
})

describe('buildIssuePrompt', () => {
  it('carries run context, acceptance criteria, and output requirements', () => {
    const prompt = buildIssuePrompt(INPUT)
    expect(prompt).toContain('run-0001')
    expect(prompt).toContain('issue-001')
    expect(prompt).toContain('验收 A')
    expect(prompt).toContain('--output-schema')
    expect(prompt).toContain('workspace-write')
  })
})

describe('IssueExecutorError', () => {
  it('carries a stable taskflow-prefixed message', () => {
    const error = new IssueExecutorError('timeout', 'took too long')
    expect(error.message).toBe('taskflow: issue-executor timeout: took too long')
    expect(error.code).toBe('timeout')
  })
})
