/**
 * P6 board projection tests: the pure buildBoard grouping and the service's
 * board() surface. Seeds the memory repository directly so each column
 * transition can be asserted without running the full workflow.
 */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { IssueExecution, RunAggregate, RunTransition } from '../src/domain.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService } from '../src/service.ts'
import type { RunStatus } from '../src/state.ts'

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }

/** Insert a valid aggregate at the requested run status with a realistic transition chain. */
function seedRun(
  repository: MemoryRepository,
  overrides: {
    id: string
    status: RunStatus
    issues: PlannedIssue[]
    executions: IssueExecution[]
    title?: string
  },
): void {
  const { id, status, issues, executions } = overrides
  const transitions: RunTransition[] = [{
    seq: 0,
    from: 'RECEIVED',
    to: 'RECEIVED',
    reason: 'created',
    actor: 'host',
    idempotencyKey: `create:${id}`,
    at: 1,
  }]
  const path: RunStatus[] = []
  if (status === 'PLANNING') {
    path.push('PLANNING')
  } else if (status === 'READY') {
    path.push('PLANNING', 'READY')
  } else if (status === 'EXECUTING') {
    path.push('PLANNING', 'READY', 'EXECUTING')
  } else if (status === 'INTEGRATION_REVIEW') {
    path.push('PLANNING', 'READY', 'EXECUTING', 'INTEGRATION_REVIEW')
  } else if (status === 'AWAITING_HUMAN') {
    path.push('PLANNING', 'READY', 'EXECUTING', 'INTEGRATION_REVIEW', 'AWAITING_HUMAN')
  } else if (status === 'ACCEPTED') {
    path.push('PLANNING', 'READY', 'EXECUTING', 'INTEGRATION_REVIEW', 'AWAITING_HUMAN', 'ACCEPTED')
  } else if (status === 'FAILED') {
    path.push('PLANNING', 'READY', 'EXECUTING', 'FAILED')
  } else if (status === 'CANCELLED') {
    path.push('PLANNING', 'READY', 'EXECUTING', 'CANCELLED')
  }
  let from: RunStatus = 'RECEIVED'
  for (const to of path) {
    transitions.push({
      seq: transitions.length,
      from,
      to,
      reason: 'seed',
      actor: 'host',
      idempotencyKey: `seed:${transitions.length}`,
      at: 1,
    })
    from = to
  }
  const aggregate: RunAggregate = {
    id,
    status,
    title: overrides.title ?? `任务 ${id}`,
    description: '',
    repoRoot: 'C:/repo',
    createdAt: 1,
    updatedAt: 1,
    issueCount: issues.length,
    issues,
    executions,
    transitions,
  }
  void repository.insertRun(aggregate)
}

function harness() {
  const repository = new MemoryRepository()
  const service = new TaskFlowService(repository, () => 1000, undefined, ['C:/repo'])
  return { repository, service }
}

describe('TaskFlowService.board', () => {
  it('groups unstarted issues into the todo column', () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA, issueB], executions: [] })

    const board = service.board()
    const todo = board.columns.find((column) => column.id === 'todo')
    expect(todo?.cards.map((card) => card.issueKey)).toEqual(['issue-001', 'issue-002'])
    expect(board.columns.every((column) => column.cards.length === 0 || column.id === 'todo')).toBe(true)
    for (const card of todo?.cards ?? []) {
      expect(card).not.toHaveProperty('workDir')
      expect(card).not.toHaveProperty('branch')
      expect(card).not.toHaveProperty('error')
    }
  })

  it('moves running issues to doing and finished issues to review/done/failed', () => {
    const { repository, service } = harness()
    seedRun(repository, {
      id: 'run-0001',
      status: 'EXECUTING',
      issues: [issueA, issueB],
      executions: [
        { key: 'issue-001', status: 'running', startedAt: 2 },
        { key: 'issue-002', status: 'done', startedAt: 2, finishedAt: 3, summary: '完成 B' },
      ],
    })
    seedRun(repository, {
      id: 'run-0002',
      status: 'INTEGRATION_REVIEW',
      issues: [issueA],
      executions: [{ key: 'issue-001', status: 'done', startedAt: 2, finishedAt: 3, summary: '完成 A' }],
    })
    seedRun(repository, {
      id: 'run-0003',
      status: 'FAILED',
      issues: [issueA],
      executions: [{ key: 'issue-001', status: 'failed', startedAt: 2, finishedAt: 3, error: '失败' }],
    })

    const board = service.board()
    const byColumn = new Map(board.columns.map((column) => [column.id, column.cards]))
    expect(byColumn.get('doing')?.map((card) => card.issueKey)).toEqual(['issue-001'])
    expect(byColumn.get('done')?.map((card) => card.issueKey)).toEqual(['issue-002'])
    expect(byColumn.get('review')?.map((card) => card.issueKey)).toEqual(['issue-001'])
    expect(byColumn.get('failed')?.map((card) => card.issueKey)).toEqual(['issue-001'])
  })

  it('keeps accepted runs in the done column and unplanned runs out of the board', () => {
    const { repository, service } = harness()
    seedRun(repository, {
      id: 'run-0001',
      status: 'ACCEPTED',
      issues: [issueA],
      executions: [{ key: 'issue-001', status: 'done', startedAt: 2, finishedAt: 3, summary: '完成 A' }],
    })
    seedRun(repository, { id: 'run-0002', status: 'RECEIVED', issues: [], executions: [] })

    const board = service.board()
    const done = board.columns.find((column) => column.id === 'done')
    expect(done?.cards.map((card) => card.issueKey)).toEqual(['issue-001'])
    expect(board.columns.flatMap((column) => column.cards)).toHaveLength(1)
  })

  it('maps cancelled runs with unfinished issues to failed and completed issues to done', () => {
    const { repository, service } = harness()
    seedRun(repository, {
      id: 'run-0001',
      status: 'CANCELLED',
      issues: [issueA, issueB],
      executions: [
        { key: 'issue-001', status: 'running', startedAt: 2 },
        { key: 'issue-002', status: 'done', startedAt: 2, finishedAt: 3, summary: '完成 B' },
      ],
    })

    const board = service.board()
    const byColumn = new Map(board.columns.map((column) => [column.id, column.cards]))
    expect(byColumn.get('failed')?.map((card) => card.issueKey)).toEqual(['issue-001'])
    expect(byColumn.get('done')?.map((card) => card.issueKey)).toEqual(['issue-002'])
  })

  it('returns a fixed column order for the browser UI', () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA], executions: [] })

    expect(service.board().columns.map((column) => column.id)).toEqual([
      'todo',
      'doing',
      'review',
      'done',
      'failed',
    ])
  })
})
