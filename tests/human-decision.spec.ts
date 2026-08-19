/**
 * P7 final human acceptance gate tests: AWAITING_HUMAN → ACCEPTED (accept)
 * or → PLANNING with executions cleared (rework), plus the HTTP route
 * contract for /plugins/taskflow/human-decision.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import { handleHumanDecision } from '../src/index.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService } from '../src/service.ts'
import type { GitRunner } from '../src/worktree.ts'

/** No-op git runner so service tests exercise orchestration, not real git. */
const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }

function harness() {
  const repository = new MemoryRepository()
  const service = new TaskFlowService(
    repository,
    () => 1000,
    undefined,
    ['C:/repo'],
    undefined,
    undefined,
    { git: fakeGit },
  )
  return { repository, service }
}

/** Insert an AWAITING_HUMAN aggregate (all issues done, review PASSed). */
function seedAwaitingHuman(
  repository: MemoryRepository,
  issues: PlannedIssue[],
  id = 'run-0001',
): RunAggregate {
  const aggregate: RunAggregate = {
    id,
    status: 'AWAITING_HUMAN',
    title: '任务',
    description: '描述',
    repoRoot: 'C:/repo',
    createdAt: 1,
    updatedAt: 6,
    issueCount: issues.length,
    issues,
    executions: issues.map((issue) => ({
      key: issue.key,
      status: 'done' as const,
      startedAt: 1,
      finishedAt: 2,
      summary: `完成 ${issue.key}`,
    })),
    review: { verdict: 'PASS', summary: '通过', reworkKeys: [], at: 5 },
    transitions: [
      { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: `create:${id}`, at: 1 },
      { seq: 1, from: 'RECEIVED', to: 'PLANNING', reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 2 },
      { seq: 2, from: 'PLANNING', to: 'READY', reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:abc', at: 3 },
      { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 4 },
      { seq: 4, from: 'EXECUTING', to: 'INTEGRATION_REVIEW', reason: 'execution-completed', actor: 'host', idempotencyKey: 'exec:done:run-0001', at: 5 },
      { seq: 5, from: 'INTEGRATION_REVIEW', to: 'AWAITING_HUMAN', reason: 'review-passed', actor: 'host', idempotencyKey: 'review:pass:run-0001', at: 6 },
    ],
  }
  void repository.insertRun(aggregate)
  return aggregate
}

describe('TaskFlowService.decideHuman', () => {
  it('accept moves AWAITING_HUMAN → ACCEPTED and keeps executions', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA, issueB])

    const result = await service.decideHuman('run-0001', 'accept')

    expect(result).toMatchObject({ ok: true, runId: 'run-0001', status: 'ACCEPTED' })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('ACCEPTED')
    expect(run.executions.map((execution) => [execution.key, execution.status])).toEqual([
      ['issue-001', 'done'],
      ['issue-002', 'done'],
    ])
    expect(run.transitions.at(-1)).toMatchObject({ from: 'AWAITING_HUMAN', to: 'ACCEPTED', reason: 'human-accepted' })
    expect(service.snapshot('run-0001')?.status).toBe('ACCEPTED')
  })

  it('rework moves AWAITING_HUMAN → PLANNING and clears executions', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA, issueB])

    const result = await service.decideHuman('run-0001', 'rework')

    expect(result).toMatchObject({ ok: true, runId: 'run-0001', status: 'PLANNING' })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('PLANNING')
    expect(run.executions).toEqual([])
    expect(run.transitions.at(-1)).toMatchObject({ from: 'AWAITING_HUMAN', to: 'PLANNING', reason: 'human-rework' })
  })

  it('rejects unknown runs, unsupported decisions, and non-AWAITING_HUMAN runs', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA])

    expect(await service.decideHuman('run-9999', 'accept')).toMatchObject({
      ok: false,
      error: expect.stringContaining('unknown run'),
    })
    expect(await service.decideHuman('run-0001', 'pause' as never)).toMatchObject({
      ok: false,
      error: expect.stringContaining('unsupported human decision'),
    })

    const ready: RunAggregate = {
      ...seedAwaitingHuman(repository, [issueA], 'run-0002'),
      id: 'run-0002',
      status: 'READY',
      review: undefined,
      executions: [],
      transitions: seedAwaitingHuman(repository, [issueA], 'run-0002').transitions.slice(0, 3),
    }
    await repository.insertRun(ready)
    expect(await service.decideHuman('run-0002', 'accept')).toMatchObject({
      ok: false,
      error: expect.stringContaining('illegal transition'),
    })
  })

  it('does not accept an already accepted run twice', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA])
    await service.decideHuman('run-0001', 'accept')

    const again = await service.decideHuman('run-0001', 'accept')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toMatch(/illegal transition/)
  })
})

/** Minimal request/response capture for the HTTP handler. */
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

/** Build a fake IncomingMessage that emits one JSON body. */
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
  // Simulate the stream: data chunks then end.
  queueMicrotask(() => {
    req.emit('data', Buffer.from(text))
    req.emit('end')
  })
  return req
}

describe('handleHumanDecision', () => {
  it('accepts a valid human accept decision and returns the new status', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA])
    const { res, status, body } = captureResponse()

    handleHumanDecision(service, jsonRequest('POST', { runId: 'run-0001', decision: 'accept' }), res)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))

    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual({ ok: true, runId: 'run-0001', status: 'ACCEPTED' })
  })

  it('returns 400 when runId or decision is missing/invalid', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA])

    for (const payload of [
      { runId: 'run-0001' },
      { decision: 'accept' },
      { runId: 'run-0001', decision: 'pause' },
    ]) {
      const { res, status, body } = captureResponse()
      handleHumanDecision(service, jsonRequest('POST', payload), res)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(status()).toBe(400)
      expect(JSON.parse(body()).error).toMatch(/human-decision requires/)
    }
  })

  it('rejects non-POST requests with 403', async () => {
    const { repository, service } = harness()
    seedAwaitingHuman(repository, [issueA])
    const { res, status, body } = captureResponse()

    handleHumanDecision(service, jsonRequest('GET', { runId: 'run-0001', decision: 'accept' }), res)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))

    expect(status()).toBe(403)
    expect(JSON.parse(body()).error).toMatch(/require POST/)
  })
})
