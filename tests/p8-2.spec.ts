/**
 * P8.2 service integration tests: the built-in automated executor contract is
 * invoked with a durable attempt id and progress callbacks, and its result is
 * normalized back into the run ledger.
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
import { TaskFlowService } from '../src/service.ts'
import type { GitRunner } from '../src/worktree.ts'

const fakeGit: GitRunner = {
  async run() {
    return { exitCode: 0, stdout: 'master\n', stderr: '' }
  },
}

class FakeAutomatedExecutor implements AutomatedExecutor {
  calls: AutomatedExecutionInput[] = []
  result?: AutomatedExecutionResult

  async execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult> {
    this.calls.push(input)
    input.onProgress?.({ phase: 'running', summary: 'working', at: 2000 })
    if (this.result !== undefined) return this.result
    return {
      ok: true,
      summary: `完成 ${input.issue.key}`,
      attemptId: input.attemptId,
      phase: 'done',
      changedFiles: [`src/${input.issue.key}.ts`],
    }
  }
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }

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

describe('P8.2 built-in automated executor integration', () => {
  it('invokes the automated executor with attemptId/progress and completes the run', async () => {
    const repository = new MemoryRepository()
    const executor = new FakeAutomatedExecutor()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit },
    )
    seedReady(repository, [issueA, issueB])

    const result = await service.startExecution('run-0001', { wait: true })

    expect(result.ok).toBe(true)
    expect(executor.calls.map((call) => call.issue.key)).toEqual(['issue-001', 'issue-002'])
    expect(executor.calls.every((call) => typeof call.attemptId === 'string' && call.attemptId !== '')).toBe(true)
    expect(executor.calls.every((call) => call.signal instanceof AbortSignal)).toBe(true)

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('INTEGRATION_REVIEW')
    expect(run.executions.every((execution) => execution.status === 'done')).toBe(true)
    expect(run.executions.every((execution) => typeof execution.attemptId === 'string')).toBe(true)
    expect(run.events?.some((event) => event.kind === 'issue.progress' && event.summary === 'working')).toBe(true)
  })

  it('records a durable attemptId on runDetail while the automated issue is running', async () => {
    const repository = new MemoryRepository()
    let release!: () => void
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const executor: AutomatedExecutor = {
      async execute(input) {
        input.onProgress?.({ phase: 'running', summary: 'started', at: 1000 })
        await gate
        return { ok: true, summary: '完成', attemptId: input.attemptId, phase: 'done' }
      },
    }
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit },
    )
    seedReady(repository, [issueA])
    const started = service.startExecution('run-0001')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))

    const detail = service.runDetail('run-0001')
    expect(detail?.currentIssue?.attemptId).toBeTruthy()
    expect(detail?.currentIssue?.phase).toBe('running')

    release()
    await started
  })

  it('rejects a stale automated executor result and fails the run', async () => {
    const repository = new MemoryRepository()
    const executor = new FakeAutomatedExecutor()
    executor.result = {
      ok: true,
      summary: 'stale',
      attemptId: 'attempt-old',
      phase: 'done',
    }
    const service = new TaskFlowService(
      repository,
      () => 1000,
      undefined,
      ['C:/repo'],
      executor,
      undefined,
      { git: fakeGit },
    )
    seedReady(repository, [issueA])

    await service.startExecution('run-0001', { wait: true })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('FAILED')
    expect(run.executions.find((execution) => execution.key === 'issue-001')?.error).toContain('stale executor result')
  })
})
