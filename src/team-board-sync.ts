/**
 * Optional one-way integration with `@dsh-suite/plugin-team-board`.
 *
 * When the external team-board service is present, taskflow mirrors its
 * kanban board into team-board tasks so users of the non-taskflow board can
 * see and track taskflow issues without opening the taskflow popover.
 * Taskflow remains the authoritative workflow engine; this module only
 * publishes taskflow state outward.
 */

import type { TaskFlowService } from './service.ts'

/** Team-board task status vocabulary (external plugin contract). */
export type TeamBoardStatus = 'todo' | 'doing' | 'done'

/** Minimal structural view of a team-board task. */
export interface TeamBoardTask {
  id: string
  subject: string
  status: TeamBoardStatus
  owner?: string
  deps: string[]
  createdAt: number
  updatedAt: number
}

/** Minimal structural view of the `ctx.teamBoard` service. */
export interface TeamBoardService {
  createTask(input: { subject: string; owner?: string; deps?: string[] }): Promise<TeamBoardTask> | TeamBoardTask
  updateTask(id: string, patch: { subject?: string; status?: TeamBoardStatus; owner?: string; deps?: string[] }): Promise<TeamBoardTask> | TeamBoardTask
  listTasks(filter?: { status?: TeamBoardStatus; owner?: string }): Promise<TeamBoardTask[]> | TeamBoardTask[]
  /** Optional deletion support; used to remove mirrored tasks that no longer exist on the taskflow board. */
  deleteTask?(id: string): Promise<unknown> | unknown
}

/** Options for the taskflow -> team-board mirror. */
export interface TeamBoardSyncOptions {
  /** Subject marker used to recognize taskflow-created team-board tasks. */
  prefix?: string
  /** Optional owner assigned to mirrored tasks. */
  owner?: string
  /** Runtime-only identity map (`runId:issueKey` → team-board task id)
   * retained by `createTeamBoardSync` so a user-edited subject that loses the
   * parseable marker is still matched in-process. Explicitly NOT durable:
   * after a restart only subject-based rediscovery applies. */
  knownTaskIds?: Map<string, string>
}

/** Default subject marker; stable so restarts can rediscover mirrored tasks. */
export const DEFAULT_TEAM_BOARD_PREFIX = '[taskflow]'

/** Map a taskflow board column to the coarser team-board status vocabulary. */
export function teamBoardStatus(columnId: string): TeamBoardStatus {
  switch (columnId) {
    case 'todo':
      return 'todo'
    case 'doing':
    case 'review':
      return 'doing'
    case 'done':
      return 'done'
    case 'failed':
      return 'todo'
    default:
      return 'todo'
  }
}

/** Build the human-readable subject that carries a stable taskflow identity. */
export function taskSubject(prefix: string, runId: string, issueKey: string, acceptance: string): string {
  return `${prefix} ${runId}/${issueKey}: ${acceptance}`
}

/** Parse a taskflow-created subject back into its run/issue identity. */
export function parseTaskSubject(subject: string, prefix: string): { runId: string; issueKey: string } | null {
  const marker = `${prefix} `
  if (!subject.startsWith(marker)) return null
  const match = /^([^\s/]+)\/([^\s/:]+):/.exec(subject.slice(marker.length))
  if (match === null) return null
  return { runId: match[1]!, issueKey: match[2]! }
}

/**
 * Mirror the current taskflow board into the team-board service.
 * The operation is idempotent: existing mirrored tasks are updated in place,
 * and no task is created twice for the same run/issue pair.
 */
export async function syncTaskflowToTeamBoard(
  service: TaskFlowService,
  teamBoard: TeamBoardService,
  options: TeamBoardSyncOptions = {},
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_TEAM_BOARD_PREFIX
  const owner = options.owner

  const existing = await teamBoard.listTasks()
  const tasksByKey = new Map<string, TeamBoardTask>()
  const tasksById = new Map<string, TeamBoardTask>()
  for (const task of existing) {
    tasksById.set(task.id, task)
    const parsed = parseTaskSubject(task.subject, prefix)
    if (parsed !== null) {
      const key = `${parsed.runId}:${parsed.issueKey}`
      tasksByKey.set(key, task)
      options.knownTaskIds?.set(key, task.id)
    }
  }
  // Re-bind runtime-known ids to keys even when the user edited the subject
  // and removed the marker. This only works while this process is alive; a
  // task that no longer exists externally falls back to re-creation.
  if (options.knownTaskIds !== undefined) {
    for (const [key, id] of options.knownTaskIds) {
      if (tasksByKey.has(key)) continue
      const task = tasksById.get(id)
      if (task !== undefined) {
        const parsed = parseTaskSubject(task.subject, prefix)
        if (parsed !== null && `${parsed.runId}:${parsed.issueKey}` !== key) {
          // The task now claims a different taskflow identity; the old
          // runtime mapping is stale and must not double-bind one task.
          options.knownTaskIds.delete(key)
          continue
        }
        tasksByKey.set(key, task)
      } else {
        options.knownTaskIds.delete(key)
      }
    }
  }

  const board = service.board()
  const cards = board.columns.flatMap((column) => (
    column.cards.map((card) => ({ card, columnId: column.id }))
  ))

  // First pass: create every missing mirrored task. Dependencies are filled in
  // the second pass so cross-references between cards can be resolved even
  // when the planner emitted a dependency after its dependent.
  for (const { card } of cards) {
    const key = `${card.runId}:${card.issueKey}`
    if (tasksByKey.has(key)) continue
    const created = await teamBoard.createTask({
      subject: taskSubject(prefix, card.runId, card.issueKey, card.acceptance),
      owner,
      deps: [],
    })
    tasksByKey.set(key, created)
    options.knownTaskIds?.set(key, created.id)
  }

  // Second pass: reconcile status, subject, owner, and dependency IDs.
  for (const { card, columnId } of cards) {
    const key = `${card.runId}:${card.issueKey}`
    const task = tasksByKey.get(key)
    if (task === undefined) continue
    const subject = taskSubject(prefix, card.runId, card.issueKey, card.acceptance)
    const status = teamBoardStatus(columnId)
    const deps = card.deps
      .map((dependency) => tasksByKey.get(`${card.runId}:${dependency}`)?.id)
      .filter((id): id is string => id !== undefined)
    if (
      task.subject !== subject
      || task.status !== status
      || (owner !== undefined && task.owner !== owner)
      || task.deps.join('\u0000') !== deps.join('\u0000')
    ) {
      await teamBoard.updateTask(task.id, { subject, status, owner, deps })
    }
  }

  // Remove mirrored tasks whose run/issue pair no longer exists on the
  // taskflow board (e.g. after a rework plan replaces the issue set).
  const currentKeys = new Set(cards.map(({ card }) => `${card.runId}:${card.issueKey}`))
  for (const [key, task] of tasksByKey) {
    if (currentKeys.has(key)) continue
    options.knownTaskIds?.delete(key)
    if (teamBoard.deleteTask !== undefined) {
      await teamBoard.deleteTask(task.id)
    }
  }
}

/**
 * Subscribe to taskflow ledger changes and mirror every change to team-board.
 * Returns a disposer that stops both the subscription and queued mirrors.
 */
export function createTeamBoardSync(
  service: TaskFlowService,
  teamBoard: TeamBoardService,
  options: TeamBoardSyncOptions = {},
): () => void {
  const knownTaskIds = new Map<string, string>()
  const syncOptions: TeamBoardSyncOptions = { ...options, knownTaskIds }
  let running = false
  let pending = false
  let disposed = false

  const run = (): void => {
    if (disposed) return
    if (running) {
      // Coalesce dense ledger bursts: at most one trailing sync runs after
      // the in-flight one, so notifications cannot pile up an unbounded
      // serial queue.
      pending = true
      return
    }
    running = true
    void syncTaskflowToTeamBoard(service, teamBoard, syncOptions)
      .catch((error: unknown) => {
        // A board mirror must never break the taskflow ledger or its routes.
        console.error('[taskflow] team-board sync failed', error)
      })
      .finally(() => {
        running = false
        if (pending && !disposed) {
          pending = false
          run()
        }
      })
  }

  run()
  const unsubscribe = service.subscribe(run)
  return () => {
    disposed = true
    unsubscribe()
  }
}
