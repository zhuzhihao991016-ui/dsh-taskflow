/**
 * P8 remediation tests: control actions abort active executors, manual runs
 * are not auto-taken-over, maxExecutorProcesses is enforced globally, and
 * retry is reachable from FAILED.
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
import type { GitRunner } from '../src/worktree.ts'

const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B' }

class FakePlanner implements Planner {
  async plan(_input: PlanInput): Promise<unknown> {
    return { issues: [issueA, issueB] }
  }
}

class FakeReviewer implements Reviewer {
  async review(_input: ReviewInput): Promise<unknown> {
    return { verdict: 'PASS', summary: '通过', reworkKeys: [] }
  }
}

class BlockingExecutor implements AutomatedExecutor {
  calls: Array<{ input: AutomatedExecutionInput; resolve: (r: AutomatedExecutionResult) => void; reject: (e: Error) => void }> = []

  execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult> {
    return new Promise((resolve, reject) => {
      input.signal?.addEventListener('abort', () => {
        reject(new Error('aborted by control action'))
      }, { once: true })
      this.calls.push({ input, resolve, reject })
    })
  }
}

class TrackingExecutor implements AutomatedExecutor {
  active = 0
  maxActive = 0
  calls = 0

  async execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.calls += 1
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    this.active -= 1
    return { ok: true, summary: `完成 ${input.issue.key}`, attemptId: input.attemptId, phase: 'done' }
  }
}

/** Executor with a per-issue failure switch; returns the service attemptId. */
class ResultMapExecutor implements AutomatedExecutor {
  calls: string[] = []
  failures = new Set<string>()

  async execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult> {
    this.calls.push(input.issue.key)
    if (this.failures.has(input.issue.key)) {
      return { ok: false, error: `失败 ${input.issue.key}`, attemptId: input.attemptId, phase: 'failed' }
    }
    return { ok: true, summary: `完成 ${input.issue.key}`, attemptId: input.attemptId, phase: 'done' }
  }
}

/** Git runner that blocks worktree creation until released. */
class GatedGit implements GitRunner {
  worktreeAdds = 0
  release!: () => void
  readonly gate = new Promise<void>((resolvePromise) => { this.release = resolvePromise })

  async run(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (args[0] === 'worktree' && args[1] === 'add' && args[2] === '-b') {
      this.worktreeAdds += 1
      await this.gate
    }
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  }
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

function seedExecuting(repository: MemoryRepository, issues: PlannedIssue[], id = 'run-0001'): RunAggregate {
  const base = seedReady(repository, issues, id)
  const aggregate: RunAggregate = {
    ...base,
    status: 'EXECUTING',
    executions: issues.map((issue) => ({
      key: issue.key,
      status: 'running' as const,
      startedAt: 4,
      attemptId: `attempt-${issue.key}-1`,
    })),
    transitions: [
      ...base.transitions,
      { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: `exec:start:${id}`, at: 4 },
    ],
  }
  void repository.insertRun(aggregate)
  return aggregate
}

async function waitFor(fn: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
  throw new Error('timed out waiting for condition')
}

describe('P8 remediation', () => {
  it('pause aborts the active automated executor and resets running issues to pending', async () => {
    const repository = new MemoryRepository()
    const executor = new BlockingExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit, automationEnabled: true, maxConcurrent: 1, autoReview: false },
    )
    seedReady(repository, [issueA])

    const started = service.startExecution('run-0001')
    await waitFor(() => executor.calls.length === 1)

    const paused = await service.command('run-0001', 'pause')
    expect(paused.ok).toBe(true)
    expect(executor.calls[0]?.input.signal?.aborted).toBe(true)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('PAUSED')
    expect(run.executions.find((execution) => execution.key === issueA.key)?.status).toBe('pending')

    await started.catch(() => undefined)
  })

  it('rejects pause while merging without aborting the active executor', async () => {
    const repository = new MemoryRepository()
    const executor = new BlockingExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit, automationEnabled: true, maxConcurrent: 1, autoReview: false },
    )
    seedReady(repository, [issueA])
    const started = service.startExecution('run-0001')
    await waitFor(() => executor.calls.length === 1)
    await repository.updateRun('run-0001', (current) => ({ ...current, merging: true }))

    const result = await service.command('run-0001', 'pause')
    expect(result.ok).toBe(false)
    expect(executor.calls[0]?.input.signal?.aborted).toBe(false)

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions[0]?.status).toBe('running')

    executor.calls[0]?.reject(new Error('test teardown'))
    await started.catch(() => undefined)
  })

  it('does not auto-resume manual EXECUTING runs when global automation is enabled', async () => {
    const repository = new MemoryRepository()
    const executor = new TrackingExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit, automationEnabled: true, autoReview: false },
    )
    const run = seedExecuting(repository, [issueA])
    run.control = {
      automation: { enabled: false, mode: 'manual' },
      paused: false,
      takenOver: false,
      retryCount: 0,
    }
    void repository.updateRun('run-0001', () => run)

    service.resumeExecution()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))

    expect(executor.calls).toBe(0)
  })

  it('resumes automatic READY runs through resumeAutomation without touching manual runs', async () => {
    const repository = new MemoryRepository()
    const executor = new TrackingExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      new FakePlanner(),
      ['C:/repo'],
      executor,
      new FakeReviewer(),
      { git: fakeGit, automationEnabled: true, autoReview: false, requireExecutionPermission: false },
    )
    const automatic = seedReady(repository, [issueA])
    automatic.control = {
      automation: { enabled: true, mode: 'automatic' },
      paused: false,
      takenOver: false,
      retryCount: 0,
    }
    await repository.updateRun('run-0001', () => automatic)
    const manual = seedReady(repository, [issueB], 'run-0002')
    manual.control = {
      automation: { enabled: false, mode: 'manual' },
      paused: false,
      takenOver: false,
      retryCount: 0,
    }
    await repository.updateRun('run-0002', () => manual)

    service.resumeAutomation()
    await waitFor(() => service.snapshot('run-0001')?.status === 'INTEGRATION_REVIEW')

    expect(executor.calls).toBe(1)
    expect(service.snapshot('run-0002')?.status).toBe('READY')
  })

  it('enforces maxExecutorProcesses globally across a parallel run', async () => {
    const repository = new MemoryRepository()
    const executor = new TrackingExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit, automationEnabled: true, maxConcurrent: 2, maxExecutorProcesses: 1, autoReview: false },
    )
    seedReady(repository, [issueA, issueB])

    await service.startExecution('run-0001', { wait: true })

    expect(executor.calls).toBe(2)
    expect(executor.maxActive).toBe(1)
  })

  it('allows retry from FAILED and moves the run back to EXECUTING', async () => {
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
    const base = seedReady(repository, [issueA])
    const failed: RunAggregate = {
      ...base,
      status: 'FAILED',
      executions: [{ key: issueA.key, status: 'failed', error: '失败' }],
      transitions: [
        ...base.transitions,
        { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 4 },
        { seq: 4, from: 'EXECUTING', to: 'FAILED', reason: 'execution-failed', actor: 'host', idempotencyKey: 'exec:fail:run-0001', at: 5 },
      ],
    }
    await repository.updateRun('run-0001', () => failed)

    expect(service.runDetail('run-0001')?.allowedActions).toContain('retry')
    const result = await service.command('run-0001', 'retry')
    expect(result.ok).toBe(true)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.find((execution) => execution.key === issueA.key)?.status).toBe('pending')
  })

  it('automatic mode: retry from FAILED restarts the executor with a fresh attempt', async () => {
    const repository = new MemoryRepository()
    const executor = new ResultMapExecutor()
    executor.failures.add('issue-001')
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit, automationEnabled: true, maxConcurrent: 1, autoReview: false },
    )
    seedReady(repository, [issueA])
    await service.startExecution('run-0001', { wait: true })
    expect(service.snapshot('run-0001')?.status).toBe('FAILED')
    expect(service.runDetail('run-0001')?.allowedActions).toContain('retry')
    const firstAttempt = (repository.getRun('run-0001') as RunAggregate).executions[0]?.attemptId

    executor.failures.delete('issue-001')
    const retried = await service.command('run-0001', 'retry')
    expect(retried.ok).toBe(true)
    await waitFor(() => service.snapshot('run-0001')?.status === 'INTEGRATION_REVIEW')

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('INTEGRATION_REVIEW')
    expect(executor.calls).toEqual(['issue-001', 'issue-001'])
    const done = run.executions.find((execution) => execution.key === 'issue-001')
    expect(done?.status).toBe('done')
    expect(done?.attemptId).not.toBe(firstAttempt)
    expect(done?.summary).toBe('完成 issue-001')
  })

  it('pause during worktree preparation does not start a new executor', async () => {
    const repository = new MemoryRepository()
    const executor = new BlockingExecutor()
    const git = new GatedGit()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git, automationEnabled: true, maxConcurrent: 1, autoReview: false },
    )
    seedReady(repository, [issueA])
    const started = service.startExecution('run-0001', { wait: true })
    await waitFor(() => git.worktreeAdds === 1)
    // The claim is durable (running) while the worktree is still prepared.
    expect((repository.getRun('run-0001') as RunAggregate).executions[0]?.status).toBe('running')

    const paused = await service.command('run-0001', 'pause')
    expect(paused.ok).toBe(true)
    git.release()
    await started.catch(() => undefined)

    expect(executor.calls).toHaveLength(0)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('PAUSED')
    expect(run.executions[0]?.status).toBe('pending')
  })

  it('cancel during worktree preparation resets the claim and starts no executor', async () => {
    const repository = new MemoryRepository()
    const executor = new BlockingExecutor()
    const git = new GatedGit()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git, automationEnabled: true, maxConcurrent: 1, autoReview: false },
    )
    seedReady(repository, [issueA])
    const started = service.startExecution('run-0001', { wait: true })
    await waitFor(() => git.worktreeAdds === 1)

    const cancelled = await service.command('run-0001', 'cancel')
    expect(cancelled.ok).toBe(true)
    git.release()
    await started.catch(() => undefined)

    expect(executor.calls).toHaveLength(0)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('CANCELLED')
    expect(run.executions[0]?.status).toBe('pending')
  })

  it('cancel aborts an active automated executor and resets running issues to pending', async () => {
    const repository = new MemoryRepository()
    const executor = new BlockingExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit, automationEnabled: true, maxConcurrent: 1, autoReview: false },
    )
    seedReady(repository, [issueA])
    const started = service.startExecution('run-0001')
    await waitFor(() => executor.calls.length === 1)

    const cancelled = await service.command('run-0001', 'cancel')
    expect(cancelled.ok).toBe(true)
    expect(executor.calls[0]?.input.signal?.aborted).toBe(true)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('CANCELLED')
    expect(run.executions[0]?.status).toBe('pending')
    await started.catch(() => undefined)
  })
})
