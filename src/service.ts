/**
 * TaskFlowService — the host-side orchestration service over a run-aggregate
 * repository. Every mutation is a repository atomic read-modify-write that
 * enforces the state machine inside the update, appends a transition, and
 * only then notifies listeners. The service surface is stable across phases:
 * submit / snapshot / list / command / subscribe.
 */

import type { RunAggregate, RunTransition } from './domain.ts'
import type { TaskFlowRepository } from './repository.ts'
import { assertTransition, isTerminal, type RunStatus } from './state.ts'

/** Read-only projection of one run, safe to hand to HTTP and the browser. */
export interface RunSnapshot {
  id: string
  status: RunStatus
  title: string
  description: string
  createdAt: number
  updatedAt: number
  issueCount: number
  transitionCount: number
}

/** A user-submitted workflow request. */
export interface SubmitRequest {
  /** Non-empty workflow title. */
  title: string
  /** Optional free-form goal/description. */
  description?: string
  /** Optional client-supplied idempotency key; a repeated submit returns the existing run. */
  idempotencyKey?: string
}

/** Commands the host accepts on a run (P1: cancel only). */
export type CommandAction = 'cancel'

/** Result of one command; ok:false carries a stable machine-readable error. */
export interface CommandResult {
  ok: boolean
  error?: string
}

/** Validate a submit request; throws with a stable message on violation. */
export function validateSubmit(request: SubmitRequest): void {
  if (typeof request.title !== 'string' || request.title.trim() === '') {
    throw new Error('taskflow: submit requires a non-empty title')
  }
}

/** Creation transition: seq 0, from == to == RECEIVED. */
function creationTransition(createdAt: number, idempotencyKey: string): RunTransition {
  return {
    seq: 0,
    from: 'RECEIVED',
    to: 'RECEIVED',
    reason: 'created',
    actor: 'host',
    idempotencyKey,
    at: createdAt,
  }
}

/**
 * The orchestration service. Construct with a repository (domain-backed in
 * production, memory-backed in tests); the repository's stored state is
 * authoritative and survives restarts via the storage domain.
 */
export class TaskFlowService {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly repository: TaskFlowRepository,
    private readonly now: () => number = Date.now,
  ) {}

  /** Submit a new workflow run; returns its RECEIVED snapshot. */
  async submit(request: SubmitRequest): Promise<RunSnapshot> {
    validateSubmit(request)
    const idempotencyKey = request.idempotencyKey ?? `submit:${request.title.trim()}`
    const existing = this.findByIdempotency(idempotencyKey)
    if (existing !== undefined) {
      return this.snapshotOf(existing)
    }

    const now = this.now()
    const id = this.nextRunId()
    const aggregate: RunAggregate = {
      id,
      status: 'RECEIVED',
      title: request.title.trim(),
      description: request.description?.trim() ?? '',
      createdAt: now,
      updatedAt: now,
      issueCount: 0,
      transitions: [creationTransition(now, idempotencyKey)],
    }
    await this.repository.insertRun(aggregate)
    this.notify()
    return this.snapshotOf(aggregate)
  }

  /** Read one run projection; undefined when the id is unknown. */
  snapshot(runId: string): RunSnapshot | undefined {
    const run = this.repository.getRun(runId)
    return run === undefined ? undefined : this.snapshotOf(run)
  }

  /** All runs in submission order (newest last). */
  list(): RunSnapshot[] {
    return this.repository.listRuns()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((run) => this.snapshotOf(run))
  }

  /**
   * Apply one command to a run. P1 supports cancel (any non-terminal status →
   * CANCELLED); unknown ids, terminal runs, and unimplemented actions fail
   * with a stable error. The transition check runs inside the repository's
   * atomic update, so a concurrent status change cannot be overwritten.
   */
  async command(runId: string, action: CommandAction, actor = 'host'): Promise<CommandResult> {
    if (action !== 'cancel') {
      return { ok: false, error: `taskflow: unsupported action '${String(action)}'` }
    }
    if (this.repository.getRun(runId) === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    try {
      await this.repository.updateRun(runId, (current) => {
        assertTransition(current.status, 'CANCELLED')
        const seq = current.transitions.length
        const transition: RunTransition = {
          seq,
          from: current.status,
          to: 'CANCELLED',
          reason: 'cancelled',
          actor,
          idempotencyKey: `command:cancel:${runId}:${seq}`,
          at: this.now(),
        }
        return {
          ...current,
          status: 'CANCELLED',
          updatedAt: transition.at,
          transitions: [...current.transitions, transition],
        }
      })
      this.notify()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  /** Subscribe to ledger changes; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private findByIdempotency(idempotencyKey: string): RunAggregate | undefined {
    return this.repository.listRuns().find((run) =>
      run.transitions.some((transition) => transition.idempotencyKey === idempotencyKey),
    )
  }

  private nextRunId(): string {
    let max = 0
    for (const run of this.repository.listRuns()) {
      const match = /^run-(\d+)$/.exec(run.id)
      if (match !== null) {
        max = Math.max(max, Number(match[1]))
      }
    }
    return `run-${String(max + 1).padStart(4, '0')}`
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private snapshotOf(run: RunAggregate): RunSnapshot {
    return {
      id: run.id,
      status: run.status,
      title: run.title,
      description: run.description,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      issueCount: run.issueCount,
      transitionCount: run.transitions.length,
    }
  }
}

/** Whether a status is terminal (exported for route/host convenience). */
export { isTerminal }
