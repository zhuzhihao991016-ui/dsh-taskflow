/**
 * Optional team-board integration tests: taskflow board cards are mirrored
 * into the external `ctx.teamBoard` service, statuses stay in sync, and the
 * mirror is idempotent across repeated syncs.
 */

import { describe, expect, it, vi } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import type { IssueExecution, RunAggregate, RunTransition } from '../src/domain.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService } from '../src/service.ts'
import type { RunStatus } from '../src/state.ts'
import {
  createTeamBoardSync,
  DEFAULT_TEAM_BOARD_PREFIX,
  parseTaskSubject,
  syncTaskflowToTeamBoard,
  teamBoardStatus,
  taskSubject,
  type TeamBoardService,
  type TeamBoardStatus,
  type TeamBoardTask,
} from '../src/team-board-sync.ts'

const issueA: PlannedIssue = { key: 'issue-001', acceptance: '验收 A' }
const issueB: PlannedIssue = { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] }

/** Seed a run at the requested status with a realistic transition chain. */
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

/** In-memory fake of the external team-board service contract. */
class FakeTeamBoard implements TeamBoardService {
  tasks: TeamBoardTask[] = []
  private nextId = 1

  async listTasks(): Promise<TeamBoardTask[]> {
    return this.tasks.map((task) => ({ ...task, deps: [...task.deps] }))
  }

  async createTask(input: { subject: string; owner?: string; deps?: string[] }): Promise<TeamBoardTask> {
    const task: TeamBoardTask = {
      id: `task-${this.nextId++}`,
      subject: input.subject,
      status: 'todo',
      owner: input.owner,
      deps: [...(input.deps ?? [])],
      createdAt: 1,
      updatedAt: 1,
    }
    this.tasks.push(task)
    return { ...task, deps: [...task.deps] }
  }

  async updateTask(
    id: string,
    patch: { subject?: string; status?: TeamBoardStatus; owner?: string; deps?: string[] },
  ): Promise<TeamBoardTask> {
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index < 0) throw new Error(`unknown task ${id}`)
    const current = this.tasks[index]!
    const next: TeamBoardTask = {
      ...current,
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
      ...(patch.deps !== undefined ? { deps: [...patch.deps] } : {}),
      updatedAt: 2,
    }
    this.tasks[index] = next
    return { ...next, deps: [...next.deps] }
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks = this.tasks.filter((task) => task.id !== id)
  }
}

describe('team-board sync mapping', () => {
  it('maps board columns to team-board statuses', () => {
    expect(teamBoardStatus('todo')).toBe('todo')
    expect(teamBoardStatus('doing')).toBe('doing')
    expect(teamBoardStatus('review')).toBe('doing')
    expect(teamBoardStatus('done')).toBe('done')
    expect(teamBoardStatus('failed')).toBe('todo')
  })

  it('encodes and parses the taskflow identity in subjects', () => {
    const subject = taskSubject(DEFAULT_TEAM_BOARD_PREFIX, 'run-0001', 'issue-001', '验收 A')
    expect(subject).toBe('[taskflow] run-0001/issue-001: 验收 A')
    expect(parseTaskSubject(subject, DEFAULT_TEAM_BOARD_PREFIX)).toEqual({
      runId: 'run-0001',
      issueKey: 'issue-001',
    })
    expect(parseTaskSubject('普通任务', DEFAULT_TEAM_BOARD_PREFIX)).toBeNull()
  })
})

describe('syncTaskflowToTeamBoard', () => {
  it('creates todo cards as team-board tasks and resolves dependency ids', async () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA, issueB], executions: [] })
    const teamBoard = new FakeTeamBoard()

    await syncTaskflowToTeamBoard(service, teamBoard)

    expect(teamBoard.tasks).toHaveLength(2)
    const first = teamBoard.tasks.find((task) => task.subject.includes('issue-001'))
    const second = teamBoard.tasks.find((task) => task.subject.includes('issue-002'))
    expect(first?.status).toBe('todo')
    expect(second?.status).toBe('todo')
    expect(second?.deps).toEqual([first?.id])
  })

  it('updates mirrored statuses as issues move through the board', async () => {
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
    const teamBoard = new FakeTeamBoard()

    await syncTaskflowToTeamBoard(service, teamBoard)

    const running = teamBoard.tasks.find((task) => task.subject.includes('issue-001'))
    const done = teamBoard.tasks.find((task) => task.subject.includes('issue-002'))
    expect(running?.status).toBe('doing')
    expect(done?.status).toBe('done')

    // Move the running issue to pending (e.g. pause) and re-sync.
    await service.command('run-0001', 'pause')
    await syncTaskflowToTeamBoard(service, teamBoard)

    expect(teamBoard.tasks.find((task) => task.subject.includes('issue-001'))?.status).toBe('todo')
    expect(teamBoard.tasks.find((task) => task.subject.includes('issue-002'))?.status).toBe('done')
  })

  it('is idempotent and does not duplicate mirrored tasks', async () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA], executions: [] })
    const teamBoard = new FakeTeamBoard()

    await syncTaskflowToTeamBoard(service, teamBoard)
    await syncTaskflowToTeamBoard(service, teamBoard)

    expect(teamBoard.tasks).toHaveLength(1)
    expect(teamBoard.tasks[0]?.subject).toContain('issue-001')
  })

  it('updates an edited subject in place instead of recreating the task', async () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA], executions: [] })
    const teamBoard = new FakeTeamBoard()

    await syncTaskflowToTeamBoard(service, teamBoard)
    const originalId = teamBoard.tasks[0]?.id

    await repository.updateRun('run-0001', (current) => ({
      ...current,
      issues: [{ key: 'issue-001', acceptance: '验收 A（修改后）' }],
    }))
    await syncTaskflowToTeamBoard(service, teamBoard)

    expect(teamBoard.tasks).toHaveLength(1)
    expect(teamBoard.tasks[0]?.id).toBe(originalId)
    expect(teamBoard.tasks[0]?.subject).toContain('验收 A（修改后）')
  })

  it('removes mirrored tasks that disappear after replanning', async () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA], executions: [] })
    const teamBoard = new FakeTeamBoard()

    await syncTaskflowToTeamBoard(service, teamBoard)
    expect(teamBoard.tasks).toHaveLength(1)

    await repository.updateRun('run-0001', (current) => ({
      ...current,
      issues: [issueB],
      executions: [],
      issueCount: 1,
    }))
    await syncTaskflowToTeamBoard(service, teamBoard)

    expect(teamBoard.tasks).toHaveLength(1)
    expect(teamBoard.tasks[0]?.subject).toContain('issue-002')
    expect(teamBoard.tasks[0]?.subject).not.toContain('issue-001')
  })
})

describe('createTeamBoardSync', () => {
  it('mirrors the initial board and follows ledger changes', async () => {
    const { repository, service } = harness()
    seedRun(repository, {
      id: 'run-0001',
      status: 'EXECUTING',
      issues: [issueA],
      executions: [{ key: 'issue-001', status: 'running', startedAt: 2 }],
    })
    const teamBoard = new FakeTeamBoard()
    const dispose = createTeamBoardSync(service, teamBoard)
    try {
      await vi.waitFor(() => {
        expect(teamBoard.tasks).toHaveLength(1)
        expect(teamBoard.tasks[0]?.status).toBe('doing')
      })

      await service.command('run-0001', 'pause')
      await vi.waitFor(() => {
        expect(teamBoard.tasks[0]?.status).toBe('todo')
      })
    } finally {
      dispose()
    }
  })

  it('matches a user-edited subject that lost the marker via runtime-known task ids', async () => {
    const { repository, service } = harness()
    seedRun(repository, {
      id: 'run-0001',
      status: 'READY',
      issues: [issueA],
      executions: [],
    })
    const teamBoard = new FakeTeamBoard()
    const dispose = createTeamBoardSync(service, teamBoard)
    try {
      await vi.waitFor(() => {
        expect(teamBoard.tasks).toHaveLength(1)
      })
      const originalId = teamBoard.tasks[0]?.id
      teamBoard.tasks[0] = { ...teamBoard.tasks[0]!, subject: '用户改标题' }

      await service.command('run-0001', 'cancel')
      await vi.waitFor(() => {
        expect(teamBoard.tasks).toHaveLength(1)
        expect(teamBoard.tasks[0]?.id).toBe(originalId)
        expect(teamBoard.tasks[0]?.subject).toContain('[taskflow]')
      })
    } finally {
      dispose()
    }
  })

  it('coalesces a dense burst of notifications into one trailing sync', async () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA], executions: [] })
    const teamBoard = new FakeTeamBoard()

    let notify: (() => void) | undefined
    vi.spyOn(service, 'subscribe').mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    const listSpy = vi.spyOn(teamBoard, 'listTasks')
    let releaseFirst: (() => void) | undefined
    listSpy.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      return []
    })

    const dispose = createTeamBoardSync(service, teamBoard)
    expect(listSpy).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 25; i += 1) notify?.()
    expect(listSpy).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await vi.waitFor(() => {
      expect(listSpy).toHaveBeenCalledTimes(2)
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    expect(listSpy).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('does not queue further syncs after disposal while one is in flight', async () => {
    const { repository, service } = harness()
    seedRun(repository, { id: 'run-0001', status: 'READY', issues: [issueA], executions: [] })
    const teamBoard = new FakeTeamBoard()

    let notify: (() => void) | undefined
    vi.spyOn(service, 'subscribe').mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    const listSpy = vi.spyOn(teamBoard, 'listTasks')
    let releaseFirst: (() => void) | undefined
    listSpy.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      return []
    })

    const dispose = createTeamBoardSync(service, teamBoard)
    for (let i = 0; i < 10; i += 1) notify?.()
    dispose()

    releaseFirst?.()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    expect(listSpy).toHaveBeenCalledTimes(1)
  })
})
