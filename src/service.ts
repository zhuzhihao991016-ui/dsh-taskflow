/**
 * TaskFlowService — the host-side orchestration service over a run-aggregate
 * repository. Every mutation is a repository atomic read-modify-write that
 * enforces the state machine inside the update, appends a transition, and
 * only then notifies listeners. The service surface is stable across phases:
 * submit / snapshot / list / command / subscribe.
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runAggregateSchema, type RunAggregate, type RunTransition } from './domain.ts'
import type { PlannedIssue } from './dag.ts'
import { validatePlan } from './dag.ts'
import { CodexPlanner, PlannerError, type PlanInput } from './planner.ts'
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
  /** Repo root the planner/executor work in; required for planning. */
  repoRoot?: string
  /** Optional client-supplied idempotency key; a repeated submit returns the existing run. */
  idempotencyKey?: string
}

/** Result of starting a plan; the flow continues in the background. */
export type PlanStartResult =
  | { ok: true; runId: string; status: RunStatus; alreadyPlanned: boolean }
  | { ok: false; error: string }

/** Planner abstraction (production: CodexPlanner; tests: fakes). */
export interface Planner {
  plan(input: PlanInput): Promise<unknown>
}

/** Commands the host accepts on a run (P1: cancel only). */
export type CommandAction = 'cancel'

/** Result of one command; ok:false carries a stable machine-readable error. */
export interface CommandResult {
  ok: boolean
  error?: string
}

/** Validate a submit request; throws a stable `taskflow:` error on violation. */
export function validateSubmit(request: SubmitRequest): void {
  if (typeof request.title !== 'string' || request.title.trim() === '') {
    throw new Error('taskflow: submit requires a non-empty title')
  }
  if (request.description !== undefined && typeof request.description !== 'string') {
    throw new Error('taskflow: description must be a string')
  }
  if (request.repoRoot !== undefined && typeof request.repoRoot !== 'string') {
    throw new Error('taskflow: repoRoot must be a string')
  }
  if (request.idempotencyKey !== undefined && typeof request.idempotencyKey !== 'string') {
    throw new Error('taskflow: idempotencyKey must be a string')
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
  private readonly planFlows = new Map<string, Promise<void>>()
  /** Runs whose PLANNING transition is in flight (single-flight gate at entry). */
  private readonly startingPlans = new Set<string>()
  /** Serializes submits: idempotency check, id allocation, and insertion run
   * on one chain so overlapping requests can never double-allocate or
   * overwrite each other (single-writer host assumption). */
  private submitTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: TaskFlowRepository,
    private readonly now: () => number = Date.now,
    private readonly planner: Planner = new CodexPlanner(),
    /** Canonical repo roots the planner may inspect; empty = planning disabled. */
    private readonly allowedRepoRoots: readonly string[] = [],
  ) {}

  /** Submit a new workflow run; returns its RECEIVED snapshot. An explicit
   * idempotencyKey deduplicates only when the normalized request (title,
   * description, and repoRoot) matches the existing run; a different request
   * under the same key is a stable conflict. Submits without a key always
   * create a fresh run (no title-based dedup). */
  submit(request: SubmitRequest): Promise<RunSnapshot> {
    validateSubmit(request)
    const explicitKey = request.idempotencyKey
    const normalizedRepoRoot = request.repoRoot?.trim() === '' ? undefined : request.repoRoot?.trim()
    const job = async (): Promise<RunSnapshot> => {
      if (explicitKey !== undefined) {
        const existing = this.findByExplicitKey(explicitKey)
        if (existing !== undefined) {
          if (
            existing.title === request.title.trim()
            && existing.description === (request.description?.trim() ?? '')
            && this.sameRepoRoot(existing.repoRoot, normalizedRepoRoot)
          ) {
            return this.snapshotOf(existing)
          }
          throw new Error(
            `taskflow: idempotencyKey '${explicitKey}' is already used by run ${existing.id} with a different request`,
          )
        }
      }

      const now = this.now()
      const id = this.nextRunId()
      const aggregate: RunAggregate = {
        id,
        status: 'RECEIVED',
        title: request.title.trim(),
        description: request.description?.trim() ?? '',
        repoRoot: normalizedRepoRoot,
        createdAt: now,
        updatedAt: now,
        issueCount: 0,
        issues: [],
        transitions: [creationTransition(now, explicitKey !== undefined ? `submit:${explicitKey}` : `create:${id}`)],
      }
      // Parse before persist: a malformed aggregate must never reach the
      // medium (KvTable.put does not schema-check; open-time validation would
      // then fail the whole plugin on the next restart).
      runAggregateSchema.parse(aggregate)
      await this.repository.insertRun(aggregate)
      this.notify()
      return this.snapshotOf(aggregate)
    }
    const result = this.submitTail.then(job)
    this.submitTail = result.then(() => undefined, () => undefined)
    return result
  }

  private sameRepoRoot(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined && b === undefined) return true
    if (a === undefined || b === undefined) return false
    return resolve(a) === resolve(b)
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
        const next: RunAggregate = {
          ...current,
          status: 'CANCELLED',
          updatedAt: transition.at,
          transitions: [...current.transitions, transition],
        }
        runAggregateSchema.parse(next)
        return next
      })
      this.notify()
      return { ok: true }
    } catch (error) {
      const message = (error as Error).message
      if (message.startsWith('taskflow:')) {
        return { ok: false, error: message }
      }
      // Repository/backend failures are not request conflicts: propagate so
      // the route can answer 5xx and the client may retry.
      throw error
    }
  }

  /** Subscribe to ledger changes; returns the unsubscribe disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Start planning for a run: RECEIVED → PLANNING immediately, then the
   * planner runs in the background (Codex CLI, read-only) and the run moves
   * to READY (issues persisted) or FAILED. Idempotent per input: a repeated
   * plan for the same run/input reports alreadyPlanned without re-running.
   * At most one planning flow runs per run: concurrent plan calls, repeated
   * resumePlanning, and recovery overlapping an HTTP trigger all share the
   * single in-flight flow (planFlows), so the planner never runs twice for
   * the same run and exactly one terminal transition is appended.
   * @param runId - the run to plan.
   * @param options - wait: await the background flow (tests/CLI) instead of
   * returning right after the PLANNING transition.
   */
  async plan(runId: string, options: { wait?: boolean } = {}): Promise<PlanStartResult> {
    const run = this.repository.getRun(runId)
    if (run === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    if (run.repoRoot === undefined || run.repoRoot === '') {
      return { ok: false, error: 'taskflow: run has no repoRoot; planning requires a repo root' }
    }
    if (!this.isAllowedRepoRoot(run.repoRoot)) {
      return { ok: false, error: `taskflow: repoRoot '${run.repoRoot}' is not in allowedRepoRoots` }
    }
    const inputHash = this.planInputHash(run)
    if (run.transitions.some((t) => t.idempotencyKey === `plan:done:${inputHash}`)) {
      return { ok: true, runId, status: run.status, alreadyPlanned: true }
    }
    if (run.status !== 'RECEIVED' && run.status !== 'PLANNING') {
      return { ok: false, error: `taskflow: illegal transition ${run.status} → PLANNING` }
    }
    // Single-flight at entry: the starting marker is set synchronously before
    // any await, so concurrent plan calls, repeated resumePlanning, and
    // recovery overlapping an HTTP trigger all observe it and never enter the
    // transition or start a second planner body.
    const inFlight = this.planFlows.get(runId)
    const starting = this.startingPlans.has(runId)
    if (inFlight !== undefined || starting) {
      if (options.wait === true && inFlight !== undefined) {
        await inFlight.catch(() => undefined)
      }
      return { ok: true, runId, status: run.status, alreadyPlanned: false }
    }
    if (run.status === 'RECEIVED') {
      // Await the durable PLANNING transition before acknowledging: the HTTP
      // route must never answer 202 for a run that is still RECEIVED or was
      // cancelled by a queued command. Only the planner body stays background.
      this.startingPlans.add(runId)
      try {
        await this.repository.updateRun(runId, (current) => {
          assertTransition(current.status, 'PLANNING')
          return this.withTransition(current, 'PLANNING', 'planning-started', `plan:start:${inputHash}`)
        })
        this.notify()
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('taskflow:')) {
          return { ok: false, error: message }
        }
        throw error
      } finally {
        this.startingPlans.delete(runId)
      }
    }
    const flow = this.runPlanningBody(runId, inputHash)
    this.planFlows.set(runId, flow)
    void flow.then(
      () => { this.planFlows.delete(runId) },
      () => { this.planFlows.delete(runId) },
    )
    if (options.wait === true) {
      await flow.catch(() => undefined)
    }
    return { ok: true, runId, status: 'PLANNING', alreadyPlanned: false }
  }

  /** Resume every persisted in-progress planning flow (called at host start). */
  resumePlanning(): void {
    for (const run of this.repository.listRuns()) {
      if (run.status === 'PLANNING') {
        void this.plan(run.id).catch(() => undefined)
      }
    }
  }

  private isAllowedRepoRoot(repoRoot: string): boolean {
    if (this.allowedRepoRoots.length === 0) return false
    const canonical = resolve(repoRoot)
    return this.allowedRepoRoots.some((root) => {
      const base = resolve(root)
      return canonical === base || canonical.startsWith(base + sep)
    })
  }

  private planInputHash(run: RunAggregate): string {
    return createHash('sha256').update(`${run.title}\n${run.description}`).digest('hex').slice(0, 16)
  }

  /** Background planning body: planner → validate → READY/FAILED (single-flight via planFlows). */
  private async runPlanningBody(runId: string, inputHash: string): Promise<void> {
    try {
      const run = this.repository.getRun(runId)
      if (run === undefined) return
      const planObject = await this.planner.plan({
        title: run.title,
        description: run.description,
        repoRoot: run.repoRoot ?? '',
        workDir: join(defaultPlanRoot(), runId),
      })
      const rawIssues = (planObject as { issues?: unknown } | null)?.issues
      const issues = Array.isArray(rawIssues) ? rawIssues as PlannedIssue[] : undefined
      const verdict = issues === undefined
        ? { ok: false as const, error: 'taskflow: planner output has no issues array' }
        : validatePlan(issues)
      if (!verdict.ok) {
        await this.transitionTo(runId, 'FAILED', `planning-rejected: ${verdict.error}`, `plan:reject:${inputHash}`)
        return
      }
      await this.repository.updateRun(runId, (current) => {
        assertTransition(current.status, 'READY')
        return this.withTransition(current, 'READY', 'planning-succeeded', `plan:done:${inputHash}`, {
          issueCount: verdict.issues.length,
          issues: [...verdict.issues],
        })
      })
      this.notify()
    } catch (error) {
      const message = error instanceof PlannerError
        ? error.message
        : (error as Error).message
      try {
        await this.transitionTo(runId, 'FAILED', `planning-failed: ${message}`, `plan:fail:${inputHash}`)
      } catch {
        // The run is already terminal; the first transition attempt recorded the failure.
      }
    }
  }

  /** Atomically move a run to `to` with one new transition (state machine enforced inside). */
  private async transitionTo(runId: string, to: RunStatus, reason: string, idempotencyKey: string): Promise<void> {
    await this.repository.updateRun(runId, (current) => {
      assertTransition(current.status, to)
      return this.withTransition(current, to, reason, idempotencyKey)
    })
    this.notify()
  }

  /** Build the next aggregate: append one transition, stamp updatedAt, parse-before-persist. */
  private withTransition(
    current: RunAggregate,
    to: RunStatus,
    reason: string,
    idempotencyKey: string,
    patch: Partial<Pick<RunAggregate, 'issueCount' | 'issues'>> = {},
  ): RunAggregate {
    const seq = current.transitions.length
    const transition: RunTransition = {
      seq,
      from: current.status,
      to,
      reason,
      actor: 'host',
      idempotencyKey,
      at: this.now(),
    }
    const next: RunAggregate = {
      ...current,
      ...patch,
      status: to,
      updatedAt: transition.at,
      transitions: [...current.transitions, transition],
    }
    runAggregateSchema.parse(next)
    return next
  }

  /** Find the run created under an explicit idempotency key. Recognizes the
   * current encoding (`submit:<key>` on the creation transition) and the
   * legacy encoding (the bare key verbatim, stored by versions before the
   * encoding change), so retries of legacy explicit keys stay idempotent. */
  private findByExplicitKey(idempotencyKey: string): RunAggregate | undefined {
    const target = `submit:${idempotencyKey}`
    return this.repository.listRuns().find((run) => {
      const creation = run.transitions[0]
      return creation !== undefined
        && (creation.idempotencyKey === target || creation.idempotencyKey === idempotencyKey)
    })
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

/** Spool root for planner artifacts: <DSH_HOME>/taskflow/plans/<runId>/. */
function defaultPlanRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'taskflow', 'plans')
}
