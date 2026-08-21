/**
 * P8.1 tests: persistent control metadata (automation mode, pause/resume,
 * retry, progress events) and run-level Git isolation (run-scoped
 * integration branch persisted on the run aggregate).
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import { handleProgress, handleRunDetail } from '../src/index.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService } from '../src/service.ts'
import type { GitRunner } from '../src/worktree.ts'

const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }

function harness(options: { automationEnabled?: boolean } = {}) {
  const repository = new MemoryRepository()
  const service = new TaskFlowService(
    repository,
    () => 1000,
    undefined,
    ['C:/repo'],
    undefined,
    undefined,
    { git: fakeGit, ...options },
  )
  return { repository, service }
}

function seedReady(repository: MemoryRepository, issues: PlannedIssue[], id = 'run-0001'): RunAggregate {
  const aggregate: RunAggregate = {
    id,
    status: 'READY',
    title: '任务',
    description: '描述',
    repoRoot: 'C:/repo',
    createdAt: 1,
    updatedAt: 3,
    issueCount: issues.length,
    issues,
    executions: [],
    transitions: [
      { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: `create:${id}`, at: 1 },
      { seq: 1, from: 'RECEIVED', to: 'PLANNING', reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 2 },
      { seq: 2, from: 'PLANNING', to: 'READY', reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:abc', at: 3 },
    ],
  }
  void repository.insertRun(aggregate)
  return aggregate
}

describe('P8.1 persistent control metadata', () => {
  it('submit initializes durable control metadata and an empty event log', async () => {
    const { repository, service } = harness()
    const run = await service.submit({ title: 'P8.1 控制元数据', repoRoot: 'C:/repo' })

    const aggregate = repository.getRun(run.id) as RunAggregate
    expect(aggregate.control).toEqual({
      automation: { enabled: false, mode: 'manual' },
      paused: false,
      takenOver: false,
      retryCount: 0,
    })
    expect(aggregate.events).toEqual([])
    expect(aggregate.runGit).toBeUndefined()
    expect(service.snapshot(run.id)?.control).toEqual(aggregate.control)
  })

  it('runDetail exposes automation mode, allowed actions, and recent events', async () => {
    const { service } = harness()
    const run = await service.submit({ title: 'P8.1 详情', repoRoot: 'C:/repo' })

    const detail = service.runDetail(run.id)
    expect(detail?.automation).toEqual({ enabled: false, mode: 'manual' })
    expect(detail?.allowedActions).toContain('cancel')
    expect(detail?.recentEvents).toEqual([])
    expect(detail?.currentIssue).toBeUndefined()
  })

  it('persists automated-executor progress onto the running issue and event log', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')

    const result = await service.recordProgress('run-0001', 'issue-001', {
      attemptId: 'attempt-1',
      phase: 'running',
      summary: '正在实现',
      at: 1234,
    })

    expect(result).toEqual({ ok: true, seq: 2 })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions[0]).toMatchObject({
      key: 'issue-001',
      status: 'running',
      attemptId: 'attempt-1',
      phase: 'running',
      heartbeatAt: 1234,
    })
    expect(run.events).toHaveLength(3)
    expect(run.events?.[2]).toMatchObject({
      seq: 2,
      runId: 'run-0001',
      kind: 'issue.progress',
      issueKey: 'issue-001',
      attemptId: 'attempt-1',
      phase: 'running',
      summary: '正在实现',
    })

    const detail = service.runDetail('run-0001')
    expect(detail?.currentIssue).toMatchObject({
      key: 'issue-001',
      attemptId: 'attempt-1',
      phase: 'running',
      heartbeatAt: 1234,
    })
    expect(detail?.recentEvents[2]).toMatchObject({ kind: 'issue.progress' })
  })
})

describe('P8.1 control actions', () => {
  it('pause and resume persist control state and whitelisted events', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')

    const paused = await service.command('run-0001', 'pause')
    expect(paused.ok).toBe(true)
    let run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('PAUSED')
    expect(run.control?.paused).toBe(true)
    expect(run.events?.at(-1)).toMatchObject({ kind: 'automation.paused' })
    expect(service.runDetail('run-0001')?.allowedActions).toContain('resume')

    const resumed = await service.command('run-0001', 'resume')
    expect(resumed.ok).toBe(true)
    run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.control?.paused).toBe(false)
    expect(run.events?.at(-1)).toMatchObject({ kind: 'automation.resumed' })
  })

  it('retry resets failed executions and increments the persisted retry count', async () => {
    const { repository, service } = harness()
    const base = seedReady(repository, [issueA, issueB])
    const executing: RunAggregate = {
      ...base,
      status: 'EXECUTING',
      control: {
        automation: { enabled: false, mode: 'manual' },
        paused: false,
        takenOver: false,
        retryCount: 0,
      },
      events: [],
      executions: [
        { key: 'issue-001', status: 'failed', error: '首次失败' },
        { key: 'issue-002', status: 'pending' },
      ],
      transitions: [
        ...base.transitions,
        { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 4 },
      ],
    }
    await repository.updateRun('run-0001', () => executing)

    const result = await service.command('run-0001', 'retry')
    expect(result.ok).toBe(true)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.control?.retryCount).toBe(1)
    expect(run.executions.find((execution) => execution.key === 'issue-001')?.status).toBe('pending')
    expect(run.events?.at(-1)).toMatchObject({ kind: 'run.updated', summary: 'retry' })
  })
})

describe('P8.1 run-level Git isolation', () => {
  it('persists a run-scoped integration branch when execution starts', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])

    await service.startExecution('run-0001')

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.runGit).toEqual({ integrationBranch: 'taskflow/integration/run-0001' })
    expect(service.snapshot('run-0001')?.runGit).toEqual({ integrationBranch: 'taskflow/integration/run-0001' })
    expect(service.runDetail('run-0001')?.currentIssue?.workDir).toContain('.dsh-taskflow-worktrees')
    expect(service.runDetail('run-0001')?.currentIssue?.branch).toBe('taskflow/run-0001/issue-001')
  })

  it('rework clears stale run-scoped Git isolation before replanning', async () => {
    const { repository, service } = harness()
    const base = seedReady(repository, [issueA])
    await repository.updateRun('run-0001', (current) => ({
      ...current,
      status: 'AWAITING_HUMAN' as const,
      runGit: { integrationBranch: 'taskflow/integration/run-0001' },
      executions: [{ key: 'issue-001', status: 'done' as const, summary: '完成' }],
      review: { verdict: 'PASS' as const, summary: '通过', reworkKeys: [], at: 5 },
      transitions: [
        ...current.transitions,
        { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 4 },
        { seq: 4, from: 'EXECUTING', to: 'INTEGRATION_REVIEW', reason: 'execution-completed', actor: 'host', idempotencyKey: 'exec:done:run-0001', at: 5 },
        { seq: 5, from: 'INTEGRATION_REVIEW', to: 'AWAITING_HUMAN', reason: 'review-passed', actor: 'host', idempotencyKey: 'review:pass:run-0001', at: 6 },
      ],
    }))

    const result = await service.decideHuman('run-0001', 'rework')
    expect(result.ok).toBe(true)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.runGit).toBeUndefined()
    expect(run.control).toEqual({
      automation: { enabled: false, mode: 'manual' },
      paused: false,
      takenOver: false,
      retryCount: 0,
    })
  })
})

function captureResponse() {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (code: number, head: Record<string, string>) => {
      status = code
      headers = head
    },
    end: (payload: string) => {
      body = payload
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    headers: () => headers,
    body: () => body,
  }
}

describe('handleRunDetail', () => {
  it('returns the P8.1 run-detail projection for a known run', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    const { res, status, body } = captureResponse()
    const req = { method: 'GET', url: '/plugins/taskflow/run?runId=run-0001' } as IncomingMessage

    handleRunDetail(service, req, res)

    expect(status()).toBe(200)
    const parsed = JSON.parse(body()) as { ok: boolean; run: { runId: string; status: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.run.runId).toBe('run-0001')
    expect(parsed.run.status).toBe('READY')
  })

  it('rejects missing runId, unknown runs, and non-GET requests', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])

    const missing = captureResponse()
    handleRunDetail(service, { method: 'GET', url: '/plugins/taskflow/run' } as IncomingMessage, missing.res)
    expect(missing.status()).toBe(400)

    const unknown = captureResponse()
    handleRunDetail(service, { method: 'GET', url: '/plugins/taskflow/run?runId=run-9999' } as IncomingMessage, unknown.res)
    expect(unknown.status()).toBe(404)

    const post = captureResponse()
    handleRunDetail(service, { method: 'POST', url: '/plugins/taskflow/run?runId=run-0001' } as IncomingMessage, post.res)
    expect(post.status()).toBe(405)
  })
})


function jsonRequest(method: string, payload: unknown): IncomingMessage {
  const text = JSON.stringify(payload)
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const req = {
    method,
    headers: {
      'content-type': 'application/json',
      host: 'localhost',
      origin: 'http://localhost',
    },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
    destroy() {},
    emit(event: string, value?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    },
  } as unknown as IncomingMessage & {
    emit(event: string, value?: unknown): void
  }
  queueMicrotask(() => {
    req.emit('data', Buffer.from(text))
    req.emit('end')
  })
  return req
}

describe('handleProgress', () => {
  it('persists a progress event through the HTTP route', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')
    const { res, status, body } = captureResponse()

    handleProgress(service, jsonRequest('POST', {
      runId: 'run-0001',
      issueKey: 'issue-001',
      attemptId: 'attempt-http',
      phase: 'running',
      summary: 'working',
    }), res)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))

    expect(status()).toBe(200)
    expect(JSON.parse(body())).toMatchObject({ ok: true, seq: expect.any(Number) })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions[0]?.attemptId).toBe('attempt-http')
  })

  it('rejects an invalid phase', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    const { res, status, body } = captureResponse()

    handleProgress(service, jsonRequest('POST', {
      runId: 'run-0001',
      issueKey: 'issue-001',
      phase: 'bogus',
    }), res)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))

    expect(status()).toBe(400)
    expect(JSON.parse(body()).error).toMatch(/valid phase/)
  })
})
