/**
 * P5 parallel execution + worktree tests: maxConcurrent claims multiple
 * schedulable issues, dependencies gate later waves, executor mode runs a
 * wave in parallel, and reportResult merges the worktree branch on success.
 */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import type { ExecutionInput, ExecutionResult, Executor } from '../src/executor.ts'
import { MemoryRepository } from '../src/repository.ts'
import type { ReviewInput, Reviewer } from '../src/reviewer.ts'
import { TaskFlowService } from '../src/service.ts'
import type { GitResult, GitRunner } from '../src/worktree.ts'

/** Scriptable fake git runner with call recording. */
class FakeGit implements GitRunner {
  calls: string[][] = []
  delayMergeMs = 0
  resultFor: (args: readonly string[]) => GitResult = () => ({ exitCode: 0, stdout: 'master\n', stderr: '' })

  async run(args: readonly string[], _cwd: string): Promise<GitResult> {
    this.calls.push([...args])
    if (args[0] === 'merge' && this.delayMergeMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMergeMs))
    }
    return this.resultFor(args)
  }
}

/** Executor that tracks the maximum number of simultaneous execute calls. */
class TrackingExecutor implements Executor {
  calls: string[] = []
  active = 0
  maxActive = 0
  delayMs = 10
  fail?: Error

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    if (this.fail !== undefined) throw this.fail
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.calls.push(input.issue.key)
    if (this.delayMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs))
    }
    this.active -= 1
    return { ok: true, summary: `完成 ${input.issue.key}` }
  }
}

/** Executor whose first wave fails issue-001 while a slow sibling succeeds. */
class DelayedFailExecutor implements Executor {
  calls: string[] = []
  failIssue001 = true

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    this.calls.push(input.issue.key)
    if (input.issue.key === 'issue-002') {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    if (this.failIssue001 && input.issue.key === 'issue-001') {
      return { ok: false, error: 'A 失败' }
    }
    return { ok: true, summary: `完成 ${input.issue.key}` }
  }
}

class RecordingPassReviewer implements Reviewer {
  readonly inputs: ReviewInput[] = []

  async review(input: ReviewInput): Promise<unknown> {
    this.inputs.push(input)
    return { verdict: 'PASS', nextAction: 'CONTINUE', summary: '通过', reworkKeys: [] }
  }
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B' }
const issueC: PlannedIssue = { key: 'issue-003', acceptance: '验收 C', deps: ['issue-001'] }

function harness(executor?: Executor, options: { maxConcurrent?: number; automationEnabled?: boolean } = {}) {
  const repository = new MemoryRepository()
  const git = new FakeGit()
  const service = new TaskFlowService(
    repository,
    () => 1000,
    undefined,
    ['C:/repo'],
    executor,
    undefined,
    { git, ...options },
  )
  return { repository, service, git }
}

async function waitFor(fn: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
  throw new Error('timed out waiting for condition')
}

/** Insert a READY aggregate (plan published) directly into the repository. */
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

describe('P5 parallel execution', () => {
  it('agent mode with maxConcurrent=2 claims two independent issues at once', async () => {
    const { repository, service } = harness(undefined, { maxConcurrent: 2 })
    seedReady(repository, [issueA, issueB])

    const result = await service.startExecution('run-0001')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.currentIssues?.map((issue) => issue.key)).toEqual(['issue-001', 'issue-002'])
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions.filter((execution) => execution.status === 'running')).toHaveLength(2)
    expect(run.executions.every((execution) => execution.workDir !== undefined && execution.branch !== undefined)).toBe(true)
  })

  it('does not claim dependent issues before their dependencies are done', async () => {
    const { repository, service } = harness(undefined, { maxConcurrent: 2 })
    seedReady(repository, [issueA, issueC])

    const result = await service.startExecution('run-0001')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.currentIssue).toBe('issue-001')
    expect(result.currentIssues).toHaveLength(1)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions.filter((execution) => execution.status === 'running')).toHaveLength(1)
  })

  it('executor mode runs independent issues in parallel up to maxConcurrent', async () => {
    const executor = new TrackingExecutor()
    const { repository, service } = harness(executor, { maxConcurrent: 2 })
    seedReady(repository, [issueA, issueB, { ...issueC, deps: [] }])

    await service.startExecution('run-0001', { wait: true })

    expect(executor.maxActive).toBe(2)
    expect(executor.calls.sort()).toEqual(['issue-001', 'issue-002', 'issue-003'])
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('INTEGRATION_REVIEW')
  })

  it('serializes slow sibling merges without stranding a running claim', async () => {
    const executor = new TrackingExecutor()
    executor.delayMs = 0
    const { repository, service, git } = harness(executor, { maxConcurrent: 2 })
    git.delayMergeMs = 1100
    seedReady(repository, [issueA, issueB])

    await service.startExecution('run-0001', { wait: true })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('INTEGRATION_REVIEW')
    expect(run.executions.every((execution) => execution.status === 'done')).toBe(true)
    expect(run.executions.filter((execution) => execution.status === 'running')).toHaveLength(0)
  })

  it('reportResult merges the worktree branch into the integration branch on success', async () => {
    const { repository, service, git } = harness(undefined, { maxConcurrent: 2 })
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')
    const run = repository.getRun('run-0001') as RunAggregate
    const running = run.executions.find((execution) => execution.status === 'running')
    expect(running?.branch).toBe('taskflow/run-0001/issue-001')

    await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '完成 A' })

    expect(git.calls.some((args) => args[0] === 'merge' && args.includes('taskflow/run-0001/issue-001'))).toBe(true)
    expect(git.calls.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(true)
    const after = repository.getRun('run-0001') as RunAggregate
    expect(after.executions.find((execution) => execution.key === 'issue-001')?.status).toBe('done')
  })

  it('keeps maxConcurrent=1 serial-compatible (one running at a time)', async () => {
    const executor = new TrackingExecutor()
    const { repository, service } = harness(executor, { maxConcurrent: 1 })
    seedReady(repository, [issueA, issueB])

    await service.startExecution('run-0001', { wait: true })

    expect(executor.maxActive).toBe(1)
    expect(executor.calls).toEqual(['issue-001', 'issue-002'])
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('INTEGRATION_REVIEW')
  })

  it('converges sibling claims to done when one issue in a wave fails', async () => {
    const executor = new DelayedFailExecutor()
    const { repository, service, git } = harness(executor, { maxConcurrent: 2 })
    seedReady(repository, [issueA, issueB])

    await service.startExecution('run-0001', { wait: true })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    const byKey = new Map(run.executions.map((execution) => [execution.key, execution]))
    expect(byKey.get('issue-001')?.status).toBe('failed')
    expect(byKey.get('issue-002')?.status).toBe('done')
    expect(run.executions.filter((execution) => execution.status === 'running')).toHaveLength(0)
    expect(git.calls.some((args) => (
      args[0] === 'worktree'
      && args[1] === 'remove'
      && args[args.length - 1]?.replaceAll('\\', '/').endsWith('/run-0001/issue-002')
    ))).toBe(true)
  })

  it('defers a successful sibling until CHECKPOINT when its wave has failed', async () => {
    const repository = new MemoryRepository()
    const git = new FakeGit()
    const executor = new DelayedFailExecutor()
    const reviewer = new RecordingPassReviewer()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      reviewer,
      { git, automationEnabled: true, autoReview: true, maxConcurrent: 2 },
    )
    seedReady(repository, [issueA, issueB])
    await repository.updateRun('run-0001', (current) => ({
      ...current,
      control: {
        automation: { enabled: true, mode: 'automatic' },
        paused: false,
        takenOver: false,
        retryCount: 0,
      },
    }))

    await service.startExecution('run-0001', { wait: true })

    let run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    expect(run.executions.find((execution) => execution.key === 'issue-001')?.status).toBe('failed')
    expect(run.executions.find((execution) => execution.key === 'issue-002')?.status).toBe('pending')
    expect(reviewer.inputs).toHaveLength(0)
    expect(git.calls.some((args) => args[0] === 'merge' && args.includes('taskflow/run-0001/issue-002'))).toBe(false)
    expect(git.calls.some((args) => (
      args[0] === 'worktree'
      && args[1] === 'remove'
      && args[args.length - 1]?.replaceAll('\\', '/').endsWith('/run-0001/issue-002')
    ))).toBe(false)

    executor.failIssue001 = false
    const retried = await service.command('run-0001', 'retry')
    expect(retried.ok).toBe(true)
    await waitFor(() => service.snapshot('run-0001')?.status === 'AWAITING_HUMAN')

    run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions.every((execution) => execution.status === 'done')).toBe(true)
    expect(reviewer.inputs.map((input) => [input.stage, input.issueKey])).toEqual([
      ['CHECKPOINT', 'issue-001'],
      ['CHECKPOINT', 'issue-002'],
      ['FINAL', undefined],
    ])
  })

  it('retry after a wave failure restarts only the failed issue with a fresh attempt', async () => {
    const repository = new MemoryRepository()
    const git = new FakeGit()
    const executor = new DelayedFailExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git, automationEnabled: true, maxConcurrent: 2, autoReview: false },
    )
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001', { wait: true })
    let run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    const failedAttempt = run.executions.find((execution) => execution.key === 'issue-001')?.attemptId
    const siblingAttempt = run.executions.find((execution) => execution.key === 'issue-002')?.attemptId

    executor.failIssue001 = false
    const retried = await service.command('run-0001', 'retry')
    expect(retried.ok).toBe(true)
    await waitFor(() => service.snapshot('run-0001')?.status === 'INTEGRATION_REVIEW')

    run = repository.getRun('run-0001') as RunAggregate
    const issueA2 = run.executions.find((execution) => execution.key === 'issue-001')
    const issueB2 = run.executions.find((execution) => execution.key === 'issue-002')
    expect(issueA2?.status).toBe('done')
    expect(issueA2?.attemptId).not.toBe(failedAttempt)
    expect(issueB2?.status).toBe('done')
    expect(issueB2?.attemptId).toBe(siblingAttempt)
    expect(executor.calls.filter((key) => key === 'issue-001')).toHaveLength(2)
    expect(executor.calls.filter((key) => key === 'issue-002')).toHaveLength(1)
  })
})
