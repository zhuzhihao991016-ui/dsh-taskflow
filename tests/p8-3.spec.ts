/**
 * P8.3 auto-coordinator and SSE tests: automatic planning after submit,
 * automatic execution/review chaining, review-cycle human window, and the
 * /plugins/taskflow/events SSE channel.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AutomatedExecutionInput,
  AutomatedExecutionResult,
  AutomatedExecutor,
} from '../src/contracts.ts'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import { handleEvents } from '../src/index.ts'
import type { PlanInput } from '../src/planner.ts'
import { MemoryRepository } from '../src/repository.ts'
import type { ReviewInput, Reviewer } from '../src/reviewer.ts'
import { TaskFlowService, type Planner } from '../src/service.ts'
import type { GitRunner } from '../src/worktree.ts'

const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }

class FakePlanner implements Planner {
  calls = 0
  result: unknown = {
    issues: [
      { key: 'issue-001', acceptance: '验收 A' },
      { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] },
    ],
  }

  async plan(_input: PlanInput): Promise<unknown> {
    this.calls += 1
    return this.result
  }
}

class FakeAutomatedExecutor implements AutomatedExecutor {
  calls: AutomatedExecutionInput[] = []

  async execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult> {
    this.calls.push(input)
    return { ok: true, summary: `完成 ${input.issue.key}`, attemptId: input.attemptId, phase: 'done' }
  }
}

class FakeReviewer implements Reviewer {
  calls = 0
  result: unknown = { verdict: 'PASS', summary: '通过', reworkKeys: [] }

  async review(_input: ReviewInput): Promise<unknown> {
    this.calls += 1
    return this.result
  }
}

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

describe('P8.3 auto coordinator', () => {
  it('autoPlans a submitted run when automation is enabled', async () => {
    const repository = new MemoryRepository()
    const planner = new FakePlanner()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      planner,
      ['C:/repo'],
      undefined,
      undefined,
      { git: fakeGit, automationEnabled: true, autoPlan: true },
    )

    const run = await service.submit({ title: '自动规划', repoRoot: 'C:/repo' })
    await waitForStatus(service, run.id, 'READY')

    expect(planner.calls).toBe(1)
    expect(service.snapshot(run.id)?.issueCount).toBe(2)
  })

  it('chains submit → autoPlan → autoExecute → autoReview → AWAITING_HUMAN', async () => {
    const repository = new MemoryRepository()
    const planner = new FakePlanner()
    const executor = new FakeAutomatedExecutor()
    const reviewer = new FakeReviewer()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      planner,
      ['C:/repo'],
      executor,
      reviewer,
      { git: fakeGit, automationEnabled: true, autoPlan: true, autoReview: true },
    )

    const run = await service.submit({ title: '全自动', repoRoot: 'C:/repo' })
    await waitForStatus(service, run.id, 'AWAITING_HUMAN')

    expect(executor.calls.map((call) => call.issue.key)).toEqual(['issue-001', 'issue-002'])
    expect(reviewer.calls).toBe(1)
    expect(service.snapshot(run.id)?.review).toMatchObject({ verdict: 'PASS' })
  })

  it('moves to WAITING_DECISION when maxReviewCycles is reached and allows resume', async () => {
    const repository = new MemoryRepository()
    const reviewer = new FakeReviewer()
    reviewer.result = { verdict: 'REVISE', summary: '需要返工', reworkKeys: ['issue-001'] }
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      undefined,
      reviewer,
      { git: fakeGit, automationEnabled: true, maxReviewCycles: 1 },
    )
    seedIntegrationReview(repository, [issueA])

    const result = await service.startReview('run-0001', { wait: true })

    expect(result).toMatchObject({ ok: true, status: 'WAITING_DECISION' })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.control?.reviewCycles).toBe(1)
    expect(run.executions[0]?.status).toBe('pending')
    expect(service.runDetail('run-0001')?.allowedActions).toContain('resume')

    const resumed = await service.command('run-0001', 'resume')
    expect(resumed.ok).toBe(true)
    expect(service.snapshot('run-0001')?.status).toBe('EXECUTING')
  })
})

describe('P8.3 SSE channel', () => {
  it('replays recent events and streams new durable events', async () => {
    const repository = new MemoryRepository()
    const service = new TaskFlowService(repository, () => 1000)
    const first = await service.submit({ title: '已有事件' })
    await service.command(first.id, 'cancel')

    let status = 0
    let headers: Record<string, string> = {}
    const chunks: string[] = []
    const res = {
      writeHead: (code: number, head: Record<string, string>) => {
        status = code
        headers = head
      },
      write: (chunk: string) => {
        chunks.push(chunk)
        return true
      },
      on: () => undefined,
    } as unknown as ServerResponse

    handleEvents(service, { method: 'GET', url: '/plugins/taskflow/events' } as IncomingMessage, res)

    expect(status).toBe(200)
    expect(headers['content-type']).toBe('text/event-stream')
    expect(chunks.join('')).toContain('event: run.updated')

    const second = await service.submit({ title: '流式事件' })
    await service.command(second.id, 'cancel')

    expect(chunks.join('')).toContain('event: run.updated')
    expect(chunks.join('')).toContain(second.id)
  })
})
