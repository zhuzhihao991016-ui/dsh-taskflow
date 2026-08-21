/**
 * P3 serial-runner tests: READY → EXECUTING claims exactly one issue in
 * deterministic dependency order, reportResult/executor advance serially, a
 * failure fails the run, completion moves the run to INTEGRATION_REVIEW, and
 * resume re-claims crash-stuck issues. Uses the memory repository; domain
 * persistence/integrity is covered in repository.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import type { ExecutionInput, ExecutionResult, Executor } from '../src/executor.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService } from '../src/service.ts'
import type { GitRunner } from '../src/worktree.ts'

/** No-op git runner so service tests exercise orchestration, not real git. */
const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

/** Scriptable fake executor: records claim order, per-key results, optional
 * delay (concurrency) and an infrastructure error (throw). */
class FakeExecutor implements Executor {
  calls: string[] = []
  results = new Map<string, ExecutionResult>()
  delayMs = 0
  fail?: Error

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    if (this.fail !== undefined) throw this.fail
    this.calls.push(input.issue.key)
    if (this.delayMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs))
    }
    return this.results.get(input.issue.key) ?? { ok: true, summary: `完成 ${input.issue.key}` }
  }
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }
const issueC: PlannedIssue = { key: 'issue-003', acceptance: '验收 C', deps: ['issue-001'] }

function harness(executor?: Executor, options: { maxConcurrent?: number } = {}) {
  const repository = new MemoryRepository()
  const service = new TaskFlowService(
    repository,
    () => 1000,
    undefined,
    ['C:/repo'],
    executor,
    undefined,
    { git: fakeGit, ...options },
  )
  return { repository, service }
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

describe('TaskFlowService.startExecution', () => {
  it('agent mode: READY → EXECUTING and claims the first issue only', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    const result = await service.startExecution('run-0001')
    expect(result).toMatchObject({ ok: true, status: 'EXECUTING', currentIssue: 'issue-001', alreadyExecuting: false })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions[0]).toMatchObject({ key: 'issue-001', status: 'running', startedAt: 1000 })
    expect(run.executions[0].workDir).toContain('.dsh-taskflow-worktrees')
    expect(run.executions[0].branch).toBe('taskflow/run-0001/issue-001')
    expect(run.transitions.map((t) => t.reason)).toEqual([
      'created', 'planning-started', 'planning-succeeded', 'execution-started',
    ])
  })

  it('snapshot exposes the repo root and full issue payload to the agent', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    const snapshot = service.snapshot('run-0001')
    expect(snapshot?.repoRoot).toBe('C:/repo')
    expect(snapshot?.issues).toEqual([
      { key: 'issue-001', acceptance: '验收 A', deps: [], risk: null },
      { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'], risk: null },
    ])
    expect(snapshot?.executions[0]).toMatchObject({
      key: 'issue-001',
      status: 'running',
      startedAt: 1000,
      finishedAt: undefined,
      summary: undefined,
      error: undefined,
    })
    expect(snapshot?.executions[0].workDir).toContain('.dsh-taskflow-worktrees')
    expect(snapshot?.executions[0].branch).toBe('taskflow/run-0001/issue-001')
  })

  it('executor mode: runs issues serially in dependency order to INTEGRATION_REVIEW', async () => {
    const executor = new FakeExecutor()
    const { repository, service } = harness(executor)
    // Shuffled input order must not affect the deterministic claim order.
    seedReady(repository, [issueC, issueB, issueA])
    const result = await service.startExecution('run-0001', { wait: true })
    expect(result.ok).toBe(true)
    expect(executor.calls).toEqual(['issue-001', 'issue-002', 'issue-003'])
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('INTEGRATION_REVIEW')
    expect(run.executions.map((e) => e.status)).toEqual(['done', 'done', 'done'])
    expect(run.transitions.map((t) => t.reason)).toEqual([
      'created', 'planning-started', 'planning-succeeded', 'execution-started', 'execution-completed',
    ])
  })

  it('executor mode: a failed issue stops the run in FAILED', async () => {
    const executor = new FakeExecutor()
    executor.results.set('issue-002', { ok: false, error: '测试失败' })
    const { repository, service } = harness(executor)
    seedReady(repository, [issueA, issueB])
    const result = await service.startExecution('run-0001', { wait: true })
    expect(result.ok).toBe(true)
    expect(executor.calls).toEqual(['issue-001', 'issue-002'])
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    expect(run.executions.map((e) => [e.key, e.status])).toEqual([
      ['issue-001', 'done'],
      ['issue-002', 'failed'],
    ])
    expect(run.transitions.at(-1)?.reason).toContain('execution-failed: issue-002')
    expect(run.transitions.at(-1)?.idempotencyKey).toBe('exec:fail:run-0001')
  })

  it('executor mode: an executor infrastructure crash fails the run', async () => {
    const executor = new FakeExecutor()
    executor.fail = new Error('执行器崩溃')
    const { repository, service } = harness(executor)
    seedReady(repository, [issueA])
    await service.startExecution('run-0001', { wait: true })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    expect(run.executions.find((e) => e.key === 'issue-001')?.status).toBe('failed')
    expect(run.executions.find((e) => e.key === 'issue-001')?.error).toBe('执行器崩溃')
  })

  it('runs the executor exactly once under concurrent startExecution calls', async () => {
    const executor = new FakeExecutor()
    executor.delayMs = 20
    const { repository, service } = harness(executor)
    seedReady(repository, [issueA, issueB])
    const results = await Promise.all([
      service.startExecution('run-0001', { wait: true }),
      service.startExecution('run-0001', { wait: true }),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.filter((r) => r.ok && r.alreadyExecuting)).toHaveLength(1)
    expect(executor.calls).toEqual(['issue-001', 'issue-002'])
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('INTEGRATION_REVIEW')
  })

  it('rejects execution for unknown runs, runs without issues, and non-READY runs', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    expect(await service.startExecution('run-9999')).toMatchObject({ ok: false, error: expect.stringContaining('unknown run') })
    // A run whose plan published zero issues is not executable.
    const empty = seedReady(repository, [], 'run-0002')
    void empty
    expect(await service.startExecution('run-0002')).toMatchObject({ ok: false, error: expect.stringContaining('no issues') })
    // A still-RECEIVED run cannot jump straight to execution.
    const received: RunAggregate = {
      id: 'run-0003',
      status: 'RECEIVED',
      title: '未规划',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      issueCount: 0,
      issues: [issueA],
      executions: [],
      transitions: [
        { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: 'create:run-0003', at: 1 },
      ],
    }
    await repository.insertRun(received)
    expect(await service.startExecution('run-0003')).toMatchObject({ ok: false, error: expect.stringContaining('illegal transition') })
  })

  it('re-claims the next pending issue when executed again while EXECUTING', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    // The current claim is issue-001 (running); a repeated execute joins it.
    const again = await service.startExecution('run-0001')
    expect(again).toMatchObject({ ok: true, currentIssue: 'issue-001' })
    // Report issue-001, then a repeated execute claims the next issue.
    await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '完成 A' })
    const third = await service.startExecution('run-0001')
    expect(third).toMatchObject({ ok: true, currentIssue: 'issue-002' })
    expect((repository.getRun('run-0001') as RunAggregate).executions.filter((e) => e.status === 'running')).toHaveLength(1)
  })

  it('agent mode: retry from FAILED makes the pending issue claimable again', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')
    await service.reportResult('run-0001', 'issue-001', { ok: false, error: '失败' })

    const retry = await service.command('run-0001', 'retry')
    expect(retry.ok).toBe(true)
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.find((execution) => execution.key === issueA.key)?.status).toBe('pending')

    const claim = await service.startExecution('run-0001')
    expect(claim).toMatchObject({ ok: true, currentIssue: 'issue-001' })
    expect((repository.getRun('run-0001') as RunAggregate).executions.find((execution) => execution.key === issueA.key)?.status).toBe('running')
  })
})

describe('TaskFlowService.reportResult', () => {
  it('agent mode: report records, execute re-claims, completion moves to INTEGRATION_REVIEW', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    // Report issue-001 done; reportResult records only (single advancement
    // path) — the agent re-claims the next issue via execute.
    const report1 = await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '完成 A' })
    expect(report1).toEqual({ ok: true })
    let run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions.find((e) => e.key === 'issue-001')?.status).toBe('done')
    expect(run.executions.find((e) => e.key === 'issue-001')?.summary).toBe('完成 A')
    expect(run.executions.find((e) => e.key === 'issue-002')?.status).toBeUndefined()
    expect(run.status).toBe('EXECUTING')
    const claim2 = await service.startExecution('run-0001')
    expect(claim2).toMatchObject({ ok: true, currentIssue: 'issue-002' })
    run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions.find((e) => e.key === 'issue-002')?.status).toBe('running')
    const report2 = await service.reportResult('run-0001', 'issue-002', { ok: true, summary: '完成 B' })
    expect(report2).toEqual({ ok: true })
    run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('INTEGRATION_REVIEW')
    expect(run.executions.map((e) => e.status)).toEqual(['done', 'done'])
    expect(run.transitions.at(-1)?.reason).toBe('execution-completed')
    expect(run.transitions.at(-1)?.idempotencyKey).toBe('exec:done:run-0001')
  })

  it('rejects a result for an issue that is not the current running one', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    const report = await service.reportResult('run-0001', 'issue-002', { ok: true, summary: 'x' })
    expect(report).toMatchObject({ ok: false, error: expect.stringContaining('not currently running') })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.executions.find((e) => e.key === 'issue-001')?.status).toBe('running')
    expect(run.status).toBe('EXECUTING')
  })

  it('rejects a result when no issue is running', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    // Report the claimed issue; nothing is claimed next until execute again.
    await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '完成 A' })
    const report = await service.reportResult('run-0001', 'issue-002', { ok: true, summary: 'x' })
    expect(report).toMatchObject({ ok: false, error: expect.stringContaining('not currently running') })
  })

  it('rejects a result for a run that is not executing', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    const report = await service.reportResult('run-0001', 'issue-001', { ok: true, summary: 'x' })
    expect(report).toMatchObject({ ok: false, error: expect.stringContaining('status READY') })
  })

  it('agent mode: a failed result fails the run', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    const report = await service.reportResult('run-0001', 'issue-001', { ok: false, error: '没做出来' })
    expect(report).toEqual({ ok: true })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    expect(run.executions.find((e) => e.key === 'issue-001')?.error).toBe('没做出来')
    expect(run.transitions.at(-1)?.reason).toContain('execution-failed: issue-001')
  })

  it('clears the merge-in-progress marker after a successful report', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')
    const report = await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '完成 A' })
    expect(report).toEqual({ ok: true })
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.merging).toBe(false)
    expect(run.status).toBe('INTEGRATION_REVIEW')
  })

  it('rejects cancel while a merge is in progress', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA])
    await service.startExecution('run-0001')
    await repository.updateRun('run-0001', (current) => ({ ...current, merging: true }))
    const result = await service.command('run-0001', 'cancel')
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('merge is in progress') })
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('EXECUTING')
  })
})

describe('TaskFlowService.resumeExecution', () => {
  it('resets a crash-stuck running issue and re-claims it (agent mode)', async () => {
    const { repository, service } = harness()
    seedReady(repository, [issueA, issueB])
    await service.startExecution('run-0001')
    // Host crash mid-issue: issue-001 is still `running`; resume re-claims it.
    service.resumeExecution()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.filter((e) => e.status === 'running')).toHaveLength(1)
    expect(run.executions.find((e) => e.key === 'issue-001')?.status).toBe('running')
  })

  it('resumes a crashed run with an executor and completes it', async () => {
    const executor = new FakeExecutor()
    const { repository, service } = harness(executor)
    const run = seedReady(repository, [issueA, issueB])
    const mid: RunAggregate = {
      ...run,
      status: 'EXECUTING',
      executions: [{ key: 'issue-001', status: 'running', startedAt: 500 }],
      transitions: [
        ...run.transitions,
        { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 600 },
      ],
    }
    await repository.updateRun('run-0001', () => mid)
    service.resumeExecution()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    expect(executor.calls).toEqual(['issue-001', 'issue-002'])
    expect((repository.getRun('run-0001') as RunAggregate).status).toBe('INTEGRATION_REVIEW')
  })
})
