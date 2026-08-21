/**
 * P8.4 automatic-execution permission gate tests: WAITING_PERMISSION is used
 * as a pre-execution human release gate when requireExecutionPermission is
 * enabled, and takeover/release keep the existing manual control semantics.
 */

import { describe, expect, it } from 'vitest'
import type {
  AutomatedExecutionInput,
  AutomatedExecutionResult,
  AutomatedExecutor,
} from '../src/contracts.ts'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import { MemoryRepository } from '../src/repository.ts'
import type { PlanInput } from '../src/planner.ts'
import type { ReviewInput, Reviewer } from '../src/reviewer.ts'
import { TaskFlowService, type Planner } from '../src/service.ts'
import { canTransition } from '../src/state.ts'
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

  async plan(_input: PlanInput): Promise<unknown> {
    this.calls += 1
    return {
      issues: [
        { key: 'issue-001', acceptance: '验收 A' },
        { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] },
      ],
    }
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
  result: unknown = { verdict: 'PASS', nextAction: 'CONTINUE', summary: '通过', reworkKeys: [] }

  async review(_input: ReviewInput): Promise<unknown> {
    this.calls += 1
    return this.result
  }
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

describe('P8.4 state transitions', () => {
  it('allows READY → WAITING_PERMISSION → EXECUTING for the permission gate', () => {
    expect(canTransition('READY', 'WAITING_PERMISSION')).toBe(true)
    expect(canTransition('WAITING_PERMISSION', 'EXECUTING')).toBe(true)
  })
})

describe('P8.4 automatic execution permission gate', () => {
  it('waits in WAITING_PERMISSION after planning when requireExecutionPermission is enabled', async () => {
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
      { git: fakeGit, automationEnabled: true, autoPlan: true, autoReview: true, requireExecutionPermission: true },
    )

    const run = await service.submit({ title: '需要授权', repoRoot: 'C:/repo' })
    await waitForStatus(service, run.id, 'WAITING_PERMISSION')

    expect(planner.calls).toBe(1)
    expect(executor.calls).toHaveLength(0)
    expect(reviewer.calls).toBe(0)
    expect(service.runDetail(run.id)?.allowedActions).toContain('release')
    expect(service.runDetail(run.id)?.allowedActions).toContain('cancel')
  })

  it('continues automatically after human release', async () => {
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
      { git: fakeGit, automationEnabled: true, autoPlan: true, autoReview: true, requireExecutionPermission: true },
    )

    const run = await service.submit({ title: '授权后执行', repoRoot: 'C:/repo' })
    await waitForStatus(service, run.id, 'WAITING_PERMISSION')

    const released = await service.command(run.id, 'release')
    expect(released.ok).toBe(true)
    expect(service.snapshot(run.id)?.status).toBe('EXECUTING')

    await waitForStatus(service, run.id, 'AWAITING_HUMAN')
    expect(executor.calls.map((call) => call.issue.key)).toEqual(['issue-001', 'issue-002'])
    expect(reviewer.calls).toBe(3)
  })

  it('keeps unattended automation behavior when requireExecutionPermission is explicitly false', async () => {
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
      { git: fakeGit, automationEnabled: true, autoPlan: true, autoReview: true, requireExecutionPermission: false },
    )

    const run = await service.submit({ title: '无需授权', repoRoot: 'C:/repo' })
    await waitForStatus(service, run.id, 'AWAITING_HUMAN')
    expect(executor.calls).toHaveLength(2)
  })
})

describe('P8.4 manual takeover/release', () => {
  it('moves from EXECUTING to WAITING_PERMISSION on takeover and back on release', async () => {
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
    const aggregate: RunAggregate = {
      id: 'run-0001',
      status: 'EXECUTING',
      title: '任务',
      description: '描述',
      repoRoot: 'C:/repo',
      createdAt: 1,
      updatedAt: 4,
      issueCount: 1,
      issues: [issueA],
      executions: [],
      transitions: [
        { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: 'create:run-0001', at: 1 },
        { seq: 1, from: 'RECEIVED', to: 'PLANNING', reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 2 },
        { seq: 2, from: 'PLANNING', to: 'READY', reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:abc', at: 3 },
        { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 4 },
      ],
    }
    void repository.insertRun(aggregate)

    const takenOver = await service.command('run-0001', 'takeover')
    expect(takenOver.ok).toBe(true)
    let run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('WAITING_PERMISSION')
    expect(run.control?.takenOver).toBe(true)
    expect(service.runDetail('run-0001')?.allowedActions).toContain('release')

    const released = await service.command('run-0001', 'release')
    expect(released.ok).toBe(true)
    run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.control?.takenOver).toBe(false)
  })
})
