/**
 * P4 review-gate service tests: INTEGRATION_REVIEW → AWAITING_HUMAN (PASS) or
 * → EXECUTING with rework resets (REVISE), single-flight review flows, and
 * reviewer infrastructure failures. Uses the memory repository.
 */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import type { Executor } from '../src/executor.ts'
import { ReviewerError, type ReviewInput, type Reviewer } from '../src/reviewer.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService } from '../src/service.ts'
import type { GitRunner } from '../src/worktree.ts'

/** No-op git runner so service tests exercise orchestration, not real git. */
const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

/** Scriptable fake reviewer for service-level review-flow tests. */
class FakeReviewer implements Reviewer {
  calls = 0
  delayMs = 0
  result: unknown = { verdict: 'PASS', summary: '通过', reworkKeys: [] }
  error?: Error
  lastInput?: ReviewInput

  async review(input: ReviewInput): Promise<unknown> {
    this.calls += 1
    this.lastInput = input
    if (this.delayMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs))
    }
    if (this.error !== undefined) throw this.error
    return this.result
  }
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }
const issueC: PlannedIssue = { key: 'issue-003', acceptance: '验收 C', deps: ['issue-002'] }

function harness(reviewer = new FakeReviewer(), executor?: Executor, options: { maxConcurrent?: number } = {}) {
  const repository = new MemoryRepository()
  const service = new TaskFlowService(
    repository,
    () => 1000,
    undefined,
    ['C:/repo'],
    executor,
    reviewer,
    { git: fakeGit, ...options },
  )
  return { repository, service, reviewer }
}

async function waitForStatus(
  service: TaskFlowService,
  runId: string,
  status: string,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (service.snapshot(runId)?.status === status) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
  throw new Error(`timed out waiting for ${runId} to reach ${status}, got ${service.snapshot(runId)?.status}`)
}

async function waitFor(fn: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
  throw new Error('timed out waiting for condition')
}

/** Insert an INTEGRATION_REVIEW aggregate (all issues done) directly. */
function seedIntegrationReview(
  repository: MemoryRepository,
  issues: PlannedIssue[],
  id = 'run-0001',
): RunAggregate {
  const aggregate: RunAggregate = {
    id,
    status: 'INTEGRATION_REVIEW',
    title: '任务',
    description: '描述',
    repoRoot: 'C:/repo',
    createdAt: 1,
    updatedAt: 5,
    issueCount: issues.length,
    issues,
    executions: issues.map((issue) => ({
      key: issue.key,
      status: 'done' as const,
      startedAt: 1,
      finishedAt: 2,
      summary: `完成 ${issue.key}`,
    })),
    transitions: [
      { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: `create:${id}`, at: 1 },
      { seq: 1, from: 'RECEIVED', to: 'PLANNING', reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 2 },
      { seq: 2, from: 'PLANNING', to: 'READY', reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:abc', at: 3 },
      { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 4 },
      { seq: 4, from: 'EXECUTING', to: 'INTEGRATION_REVIEW', reason: 'execution-completed', actor: 'host', idempotencyKey: 'exec:done:run-0001', at: 5 },
    ],
  }
  void repository.insertRun(aggregate)
  return aggregate
}

describe('TaskFlowService.startReview', () => {
  it('PASS moves INTEGRATION_REVIEW → AWAITING_HUMAN and persists the review', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA, issueB])
    reviewer.result = { verdict: 'PASS', summary: '全部验收通过', reworkKeys: [] }

    const result = await service.startReview('run-0001', { wait: true })

    expect(result).toMatchObject({ ok: true, status: 'AWAITING_HUMAN', alreadyReviewing: false, verdict: 'PASS' })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('AWAITING_HUMAN')
    expect(run.executions.every((execution) => execution.status === 'done')).toBe(true)
    expect(run.review).toMatchObject({ verdict: 'PASS', summary: '全部验收通过', reworkKeys: [] })
    expect(run.transitions.at(-1)).toMatchObject({ from: 'INTEGRATION_REVIEW', to: 'AWAITING_HUMAN', reason: 'review-passed' })
    expect(service.snapshot('run-0001')?.review).toMatchObject({ verdict: 'PASS' })
  })

  it('REVISE moves INTEGRATION_REVIEW → EXECUTING and resets selected issues plus dependents', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA, issueB, issueC])
    reviewer.result = { verdict: 'REVISE', summary: 'B 需要返工', reworkKeys: ['issue-002'] }

    const result = await service.startReview('run-0001', { wait: true })

    expect(result).toMatchObject({ ok: true, status: 'EXECUTING', alreadyReviewing: false, verdict: 'REVISE' })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.map((execution) => [execution.key, execution.status])).toEqual([
      ['issue-001', 'done'],
      ['issue-002', 'pending'],
      ['issue-003', 'pending'],
    ])
    expect(run.review).toMatchObject({ verdict: 'REVISE', summary: 'B 需要返工', reworkKeys: ['issue-002', 'issue-003'] })
    expect(run.transitions.at(-1)).toMatchObject({ from: 'INTEGRATION_REVIEW', to: 'EXECUTING', reason: 'review-revise' })

    // The serial runner re-claims the first pending issue in dependency order.
    const claim = await service.startExecution('run-0001')
    expect(claim).toMatchObject({ ok: true, currentIssue: 'issue-002' })
  })

  it('REVISE with an empty rework list resets all issues to pending', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA, issueB])
    reviewer.result = { verdict: 'REVISE', summary: '全部返工', reworkKeys: [] }

    await service.startReview('run-0001', { wait: true })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.map((execution) => [execution.key, execution.status])).toEqual([
      ['issue-001', 'pending'],
      ['issue-002', 'pending'],
    ])
    expect(run.review?.reworkKeys).toEqual(['issue-001', 'issue-002'])
  })

  it('rejects review for unknown runs and runs not in INTEGRATION_REVIEW', async () => {
    const { repository, service } = harness()
    seedIntegrationReview(repository, [issueA])
    expect(await service.startReview('run-9999')).toMatchObject({ ok: false, error: expect.stringContaining('unknown run') })
    // A READY run cannot jump straight into the review gate.
    const ready: RunAggregate = {
      ...seedIntegrationReview(repository, [issueA], 'run-0002'),
      id: 'run-0002',
      status: 'READY',
      transitions: seedIntegrationReview(repository, [issueA], 'run-0002').transitions.slice(0, 3),
    }
    await repository.insertRun(ready)
    expect(await service.startReview('run-0002')).toMatchObject({ ok: false, error: expect.stringContaining('illegal transition') })
  })

  it('runs the reviewer exactly once under concurrent startReview calls', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA, issueB])
    reviewer.delayMs = 20
    reviewer.result = { verdict: 'PASS', summary: '通过', reworkKeys: [] }

    const results = await Promise.all([
      service.startReview('run-0001', { wait: true }),
      service.startReview('run-0001', { wait: true }),
    ])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.filter((result) => result.ok && result.alreadyReviewing)).toHaveLength(1)
    expect(reviewer.calls).toBe(1)
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('AWAITING_HUMAN')
  })

  it('fails the run when the reviewer infrastructure errors', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA, issueB])
    reviewer.error = new ReviewerError('timeout', 'exceeded')

    await service.startReview('run-0001', { wait: true })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    expect(run.transitions.at(-1)?.reason).toContain('review-failed')
  })

  it('retry after a reviewer infrastructure failure recovers through INTEGRATION_REVIEW', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA])
    reviewer.error = new ReviewerError('timeout', 'exceeded')
    await service.startReview('run-0001', { wait: true })
    expect(service.snapshot('run-0001')?.status).toBe('FAILED')
    expect(service.runDetail('run-0001')?.allowedActions).toContain('retry')

    const retry = await service.command('run-0001', 'retry')
    expect(retry.ok).toBe(true)
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('INTEGRATION_REVIEW')

    reviewer.error = undefined
    reviewer.result = { verdict: 'PASS', summary: '通过', reworkKeys: [] }
    const reviewed = await service.startReview('run-0001', { wait: true })
    expect(reviewed).toMatchObject({ ok: true, status: 'AWAITING_HUMAN', verdict: 'PASS' })
    expect(reviewer.calls).toBe(2)
  })

  it('automatic mode: retry after a review failure restarts the reviewer', async () => {
    const repository = new MemoryRepository()
    const reviewer = new FakeReviewer()
    reviewer.error = new ReviewerError('timeout', 'exceeded')
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      undefined,
      reviewer,
      { git: fakeGit, automationEnabled: true, autoReview: true },
    )
    seedIntegrationReview(repository, [issueA])
    await service.startReview('run-0001', { wait: true })
    expect(service.snapshot('run-0001')?.status).toBe('FAILED')

    reviewer.error = undefined
    const retry = await service.command('run-0001', 'retry')
    expect(retry.ok).toBe(true)
    await waitForStatus(service, 'run-0001', 'AWAITING_HUMAN')
    expect(reviewer.calls).toBe(2)
  })

  it('cancel aborts the in-flight reviewer and late results cannot rewrite the run', async () => {
    const { repository, service, reviewer } = harness()
    seedIntegrationReview(repository, [issueA])
    reviewer.delayMs = 30
    const reviewing = service.startReview('run-0001')
    await waitFor(() => reviewer.calls === 1)
    await service.command('run-0001', 'cancel')
    expect(reviewer.lastInput?.signal?.aborted).toBe(true)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
    const aggregate = repository.getRun('run-0001')
    expect(aggregate?.status).toBe('CANCELLED')
    expect(aggregate?.transitions.at(-1)?.to).toBe('CANCELLED')
    expect(reviewer.calls).toBe(1)
    await reviewing.catch(() => undefined)
  })
})
