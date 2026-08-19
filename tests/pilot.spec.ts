/**
 * P7 pilot-run test: one deterministic end-to-end pass through the whole
 * workflow — submit → plan → execute → review → human accept — using fakes
 * for the Codex planner, executor, and reviewer.
 */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { ExecutionInput, ExecutionResult, Executor } from '../src/executor.ts'
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

class FakePlanner implements Planner {
  async plan(_input: PlanInput): Promise<unknown> {
    return {
      issues: [
        { key: 'issue-001', acceptance: '验收 A' },
        { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] },
      ],
    }
  }
}

class FakeExecutor implements Executor {
  calls: string[] = []

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    this.calls.push(input.issue.key)
    return { ok: true, summary: `完成 ${input.issue.key}` }
  }
}

class FakeReviewer implements Reviewer {
  async review(_input: ReviewInput): Promise<unknown> {
    return { verdict: 'PASS', summary: '全部验收通过', reworkKeys: [] }
  }
}

describe('P7 end-to-end pilot', () => {
  it('runs submit → plan → execute → review → human accept to ACCEPTED', async () => {
    const repository = new MemoryRepository()
    const executor = new FakeExecutor()
    const reviewer = new FakeReviewer()
    const service = new TaskFlowService(
      repository,
      () => 1000,
      new FakePlanner(),
      ['C:/repo'],
      executor,
      reviewer,
      { git: fakeGit },
    )

    const submitted = await service.submit({
      title: 'P7 收口试运行',
      description: '完整跑通一次任务流闭环',
      repoRoot: 'C:/repo',
    })
    expect(submitted.status).toBe('RECEIVED')

    const planned = await service.plan(submitted.id, { wait: true })
    expect(planned.ok).toBe(true)
    expect(service.snapshot(submitted.id)?.status).toBe('READY')

    const executed = await service.startExecution(submitted.id, { wait: true })
    expect(executed.ok).toBe(true)
    expect(executor.calls).toEqual(['issue-001', 'issue-002'])
    expect(service.snapshot(submitted.id)?.status).toBe('INTEGRATION_REVIEW')

    const reviewed = await service.startReview(submitted.id, { wait: true })
    expect(reviewed.ok).toBe(true)
    expect(service.snapshot(submitted.id)?.status).toBe('AWAITING_HUMAN')

    const accepted = await service.decideHuman(submitted.id, 'accept')
    expect(accepted).toMatchObject({ ok: true, status: 'ACCEPTED' })
    expect(service.snapshot(submitted.id)?.status).toBe('ACCEPTED')

    const run = repository.getRun(submitted.id)
    expect(run?.transitions.map((transition) => transition.reason)).toEqual([
      'created',
      'planning-started',
      'planning-succeeded',
      'execution-started',
      'execution-completed',
      'review-passed',
      'human-accepted',
    ])
  })
})
