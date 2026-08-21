/** Merge-checkpoint orchestration: medium review gates every successful Issue. */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { RunAggregate } from '../src/domain.ts'
import type { PlanInput } from '../src/planner.ts'
import type { ReviewInput, Reviewer } from '../src/reviewer.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService, type Planner } from '../src/service.ts'
import type { GitResult, GitRunner } from '../src/worktree.ts'

class FakeGit implements GitRunner {
  readonly calls: string[][] = []

  async run(args: readonly string[], _cwd: string): Promise<GitResult> {
    this.calls.push([...args])
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = args[2] ?? ''
      return { exitCode: 0, stdout: ref.includes('/issue-001') ? 'issue-head\n' : 'integration-head\n', stderr: '' }
    }
    if (args[0] === 'status') {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

class QueueReviewer implements Reviewer {
  readonly inputs: ReviewInput[] = []
  results: unknown[] = []

  async review(input: ReviewInput): Promise<unknown> {
    this.inputs.push(input)
    const result = this.results.shift()
    if (result === undefined) throw new Error('missing review result')
    return result
  }
}

class RecordingPlanner implements Planner {
  readonly inputs: PlanInput[] = []

  async plan(input: PlanInput): Promise<unknown> {
    this.inputs.push(input)
    return { issues: [{ key: 'issue-new', acceptance: '采用修正后的路线', deps: [], risk: null }] }
  }
}

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '完成第一步', deps: [] }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '完成第二步', deps: ['issue-001'] }

function seedExecuting(repository: MemoryRepository): void {
  const run: RunAggregate = {
    id: 'run-0001',
    status: 'EXECUTING',
    title: '实现任务流',
    description: '逐步执行并审查方向',
    repoRoot: 'C:/repo',
    createdAt: 1,
    updatedAt: 4,
    issueCount: 2,
    issues: [issueA, issueB],
    executions: [
      {
        key: 'issue-001',
        status: 'running',
        startedAt: 4,
        workDir: 'C:/worktrees/run-0001/issue-001',
        branch: 'taskflow/run-0001/issue-001',
        branchBaseSha: 'branch-base',
        attemptId: 'attempt-issue-001-1',
      },
      { key: 'issue-002', status: 'pending' },
    ],
    baseSha: 'run-base',
    runGit: { integrationBranch: 'taskflow/integration/run-0001' },
    control: {
      automation: { enabled: true, mode: 'automatic' },
      paused: false,
      takenOver: false,
      retryCount: 0,
      reviewCycles: 0,
    },
    transitions: [
      { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: 'create', at: 1 },
      { seq: 1, from: 'RECEIVED', to: 'PLANNING', reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:old', at: 2 },
      { seq: 2, from: 'PLANNING', to: 'READY', reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:old', at: 3 },
      { seq: 3, from: 'READY', to: 'EXECUTING', reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start', at: 4 },
    ],
  }
  void repository.insertRun(run)
}

function harness(planner: Planner = new RecordingPlanner()) {
  const repository = new MemoryRepository()
  const git = new FakeGit()
  const reviewer = new QueueReviewer()
  const service = new TaskFlowService(
    repository,
    () => 1000,
    planner,
    ['C:/repo'],
    undefined,
    reviewer,
    {
      git,
      automationEnabled: true,
      autoPlan: false,
      autoReview: true,
      maxReviewCycles: 3,
    },
  )
  seedExecuting(repository)
  return { git, planner, repository, reviewer, service }
}

describe('TaskFlowService CHECKPOINT review', () => {
  it('PASS reviews the issue branch before merge and then records it done', async () => {
    const { git, repository, reviewer, service } = harness()
    reviewer.results = [{ verdict: 'PASS', nextAction: 'CONTINUE', summary: '方向正确', reworkKeys: [] }]

    await expect(service.reportResult('run-0001', 'issue-001', { ok: true, summary: '第一步完成' })).resolves.toEqual({ ok: true })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.find((execution) => execution.key === 'issue-001')?.status).toBe('done')
    expect(run.review).toMatchObject({
      verdict: 'PASS',
      stage: 'CHECKPOINT',
      issueKey: 'issue-001',
      nextAction: 'CONTINUE',
    })
    expect(reviewer.inputs).toHaveLength(1)
    expect(reviewer.inputs[0]).toMatchObject({
      stage: 'CHECKPOINT',
      issueKey: 'issue-001',
      reviewRoot: 'C:/worktrees/run-0001/issue-001',
      reviewBaseSha: 'branch-base',
      reviewTargetHeadSha: 'issue-head',
    })
    const reviewIndex = git.calls.findIndex((args) => args[0] === 'rev-parse' && args[2]?.includes('/issue-001'))
    const mergeIndex = git.calls.findIndex((args) => args[0] === 'merge')
    expect(reviewIndex).toBeGreaterThanOrEqual(0)
    expect(mergeIndex).toBeGreaterThan(reviewIndex)
  })

  it('FIX keeps the issue worktree and requeues the same Issue without merging', async () => {
    const { git, repository, reviewer, service } = harness()
    reviewer.results = [{
      verdict: 'REVISE',
      nextAction: 'FIX',
      summary: '实现局部偏离验收',
      reworkKeys: ['issue-001'],
      findings: [{ issueKey: 'issue-001', problem: '接口语义错误', evidenceNeeded: ['回归测试'], acceptance: '完成第一步' }],
    }]

    await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '第一步完成' })

    const run = repository.getRun('run-0001') as RunAggregate
    expect(run.status).toBe('EXECUTING')
    expect(run.executions.find((execution) => execution.key === 'issue-001')).toMatchObject({
      status: 'pending',
      workDir: 'C:/worktrees/run-0001/issue-001',
      branch: 'taskflow/run-0001/issue-001',
      branchBaseSha: 'branch-base',
    })
    expect(run.review).toMatchObject({ stage: 'CHECKPOINT', nextAction: 'FIX' })
    expect(git.calls.some((args) => args[0] === 'merge')).toBe(false)
  })

  it('REPLAN returns to planning and supplies the review findings to the planner', async () => {
    const planner = new RecordingPlanner()
    const { git, repository, reviewer, service } = harness(planner)
    reviewer.results = [{
      verdict: 'REVISE',
      nextAction: 'REPLAN',
      summary: '技术路线会让后续步骤建立在错误前提上',
      reworkKeys: [],
      findings: [{ issueKey: 'issue-001', problem: '应先建立共享契约', evidenceNeeded: [], acceptance: '完成第一步' }],
    }]

    await service.reportResult('run-0001', 'issue-001', { ok: true, summary: '第一步完成' })

    expect(repository.getRun('run-0001')?.status).toBe('PLANNING')
    expect(git.calls.some((args) => args[0] === 'merge')).toBe(false)
    await service.plan('run-0001', { wait: true })
    expect(planner.inputs).toHaveLength(1)
    expect(planner.inputs[0].replanFeedback).toContain('技术路线会让后续步骤建立在错误前提上')
    expect(planner.inputs[0].replanFeedback).toContain('应先建立共享契约')
    const replanned = repository.getRun('run-0001') as RunAggregate
    expect(replanned.status).toBe('READY')
    expect(replanned.issues.map((issue) => issue.key)).toEqual(['issue-003'])
    expect(replanned.issues[0]?.taskId).toBe('issue-new')
    expect(replanned.executions).toEqual([])
    expect(replanned.review).toBeUndefined()
  })
})
