/**
 * TaskFlowService — the host-side orchestration service skeleton (P0).
 *
 * P0 keeps the run ledger in memory and implements only the RECEIVED and
 * CANCELLED transitions; the full DAG-driven state machine, SQLite
 * persistence (P1), Codex planning (P2), DSH execution (P3), review/rework
 * (P4), and wave scheduling (P5) land in later phases. The service surface
 * is already the final one (submit / snapshot / list / command / subscribe)
 * so adapters and the client board never need to relearn it.
 */

/** Run lifecycle status; P0 implements RECEIVED and CANCELLED only. */
export type RunStatus =
  | 'RECEIVED'
  | 'PLANNING'
  | 'READY'
  | 'EXECUTING'
  | 'INTEGRATION_REVIEW'
  | 'AWAITING_HUMAN'
  | 'ACCEPTED'
  | 'CANCELLED'
  | 'FAILED'

/** Terminal statuses: no further transition is legal. */
const TERMINAL: ReadonlySet<RunStatus> = new Set(['ACCEPTED', 'CANCELLED', 'FAILED'])

/** A user-submitted workflow request (P0: title + description only). */
export interface SubmitRequest {
  /** Non-empty workflow title. */
  title: string
  /** Optional free-form goal/description. */
  description?: string
}

/** Read-only projection of one run, safe to hand to HTTP and the browser. */
export interface RunSnapshot {
  id: string
  status: RunStatus
  title: string
  description: string
  createdAt: number
  /** Number of planned issues; always 0 until the planner lands (P2). */
  issueCount: number
}

/** Commands the host accepts on a run (P0: cancel only). */
export type CommandAction = 'cancel'

/** Result of one command; ok:false carries a stable machine-readable error. */
export interface CommandResult {
  ok: boolean
  error?: string
}

/** Internal mutable run record. */
interface Run extends RunSnapshot {}

/** Validate a submit request; throws with a stable message on violation. */
export function validateSubmit(request: SubmitRequest): void {
  if (typeof request.title !== 'string' || request.title.trim() === '') {
    throw new Error('taskflow: submit requires a non-empty title')
  }
}

/**
 * The orchestration ledger. Single-writer within one host process; P1 moves
 * the ledger to a storage-domain SQLite aggregate and adds lease/epoch
 * recovery, at which point the constructor takes the repository.
 */
export class TaskFlowService {
  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Set<() => void>()
  private nextSequence = 1

  /** Submit a new workflow run; returns its RECEIVED snapshot. */
  submit(request: SubmitRequest): RunSnapshot {
    validateSubmit(request)
    const id = `run-${String(this.nextSequence).padStart(4, '0')}`
    this.nextSequence += 1
    const run: Run = {
      id,
      status: 'RECEIVED',
      title: request.title.trim(),
      description: request.description?.trim() ?? '',
      createdAt: Date.now(),
      issueCount: 0,
    }
    this.runs.set(id, run)
    this.notify()
    return this.snapshotOf(run)
  }

  /** Read one run projection; undefined when the id is unknown. */
  snapshot(runId: string): RunSnapshot | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : this.snapshotOf(run)
  }

  /** All runs in submission order (newest last). */
  list(): RunSnapshot[] {
    return [...this.runs.values()].map((run) => this.snapshotOf(run))
  }

  /**
   * Apply one command to a run. P0 supports cancel (RECEIVED/PLANNING →
   * CANCELLED); unknown ids, terminal runs, and unimplemented actions fail
   * with a stable error.
   */
  command(runId: string, action: CommandAction): CommandResult {
    const run = this.runs.get(runId)
    if (run === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    if (TERMINAL.has(run.status)) {
      return { ok: false, error: `taskflow: run ${runId} is already ${run.status}` }
    }
    if (action === 'cancel') {
      run.status = 'CANCELLED'
      this.notify()
      return { ok: true }
    }
    return { ok: false, error: `taskflow: action ${String(action)} is not implemented` }
  }

  /** Subscribe to ledger changes; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private snapshotOf(run: Run): RunSnapshot {
    return {
      id: run.id,
      status: run.status,
      title: run.title,
      description: run.description,
      createdAt: run.createdAt,
      issueCount: run.issueCount,
    }
  }
}
