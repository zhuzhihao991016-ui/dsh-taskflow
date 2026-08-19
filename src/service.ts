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
import { runAggregateSchema, type IssueExecution, type ReviewVerdict, type RunAggregate, type RunTransition } from './domain.ts'
import type { PlannedIssue, RiskLevel } from './dag.ts'
import { validatePlan } from './dag.ts'
import type { ExecutionResult, Executor } from './executor.ts'
import { CodexPlanner, PlannerError, type PlanInput } from './planner.ts'
import { CodexReviewer, ReviewerError, type Reviewer, type ReviewResult } from './reviewer.ts'
import type { TaskFlowRepository } from './repository.ts'
import { assertTransition, isTerminal, type RunStatus } from './state.ts'
import { WorktreeError, WorktreeManager, type GitRunner } from './worktree.ts'

/** Read-only projection of one run, safe to hand to HTTP and the browser. */
export interface RunSnapshot {
  id: string
  status: RunStatus
  title: string
  description: string
  /** Repo root the executor works in (agent-driven execution needs it). */
  repoRoot?: string
  createdAt: number
  updatedAt: number
  issueCount: number
  transitionCount: number
  /** Validated planned issues (P2); empty until a plan succeeds. */
  issues: IssueSnapshot[]
  /** Per-issue execution state (P3); empty until execution starts. */
  executions: IssueExecutionSnapshot[]
  /** Latest Codex review result (P4); absent until a review completes. */
  review?: {
    verdict: ReviewVerdict
    summary: string
    reworkKeys: string[]
    at: number
  }
  /** P5: base commit SHA captured when execution started. */
  baseSha?: string
}

/** Projected planned issue (agent needs acceptance/deps to execute). */
export interface IssueSnapshot {
  key: string
  acceptance: string
  deps: string[]
  risk?: RiskLevel | null
}

/** Projected per-issue execution state (no internal fields). */
export interface IssueExecutionSnapshot {
  key: string
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt?: number
  finishedAt?: number
  summary?: string
  error?: string
  /** P5: worktree path when this issue runs in an isolated worktree. */
  workDir?: string
  /** P5: per-issue branch created for the worktree. */
  branch?: string
}

/** Board column identifiers; each maps to a kanban lane in the browser UI. */
export type BoardColumnId = 'todo' | 'doing' | 'review' | 'done' | 'failed'

/** One card on the taskflow board: a planned issue projected with its run context. */
export interface BoardCard {
  runId: string
  runTitle: string
  runStatus: RunStatus
  issueKey: string
  acceptance: string
  deps: string[]
  risk?: RiskLevel | null
  status: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
}

/** One kanban column: a stable id, a user-facing title, and ordered cards. */
export interface BoardColumn {
  id: BoardColumnId
  title: string
  cards: BoardCard[]
}

/** Read-only board snapshot derived from the run ledger. */
export interface BoardSnapshot {
  columns: BoardColumn[]
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

/** Result of starting execution; currentIssue is the first claimed issue and
 * currentIssues lists every currently running issue (P5 parallel). */
export type ExecutionStartResult =
  | {
      ok: true
      runId: string
      status: RunStatus
      alreadyExecuting: boolean
      currentIssue?: string
      currentIssues?: Array<{ key: string; workDir?: string; branch?: string }>
    }
  | { ok: false; error: string }

/** Result of reporting one issue outcome. */
export type ExecutionReport = { ok: true } | { ok: false; error: string }

/** Result of starting the P4 review gate. */
export type ReviewStartResult =
  | { ok: true; runId: string; status: RunStatus; alreadyReviewing: boolean; verdict?: ReviewVerdict }
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

/** P5 execution/worktree options. */
export interface TaskFlowOptions {
  /** Maximum number of issues that may run concurrently (default 1 = serial). */
  maxConcurrent?: number
  /** Persistent branch where successful issue worktrees are merged. */
  integrationBranch?: string
  /** Directory under the repo root that holds per-issue worktrees. */
  worktreesRoot?: string
  /** Git runner override (tests). */
  git?: GitRunner
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
  /** Runs whose PLANNING transition is in flight: runId → the durable
   * transition promise. Set synchronously at plan() entry (before any await)
   * so overlapping callers await the SAME promise instead of acknowledging a
   * not-yet-durable transition; the map entry is removed when the transition
   * settles. */
  private readonly startingTransitions = new Map<string, Promise<void>>()
  /** Runs whose serial execution flow is in flight (single-flight gate). */
  private readonly executionFlows = new Map<string, Promise<void>>()
  /** Runs whose READY → EXECUTING transition is in flight: runId → the durable
   * transition promise, shared by overlapping execute calls (same pattern as
   * startingTransitions for planning). */
  private readonly startingExecutions = new Map<string, Promise<void>>()
  /** Runs whose P4 review flow is in flight (single-flight gate). */
  private readonly reviewFlows = new Map<string, Promise<void>>()
  /** Per-repository merge serialization: repoRoot → tail promise. */
  private readonly mergeTails = new Map<string, Promise<void>>()
  /** Serializes submits: idempotency check, id allocation, and insertion run
   * on one chain so overlapping requests can never double-allocate or
   * overwrite each other (single-writer host assumption). */
  private submitTail: Promise<void> = Promise.resolve()
  private readonly maxConcurrent: number
  private readonly integrationBranch: string
  private readonly worktrees: WorktreeManager

  constructor(
    private readonly repository: TaskFlowRepository,
    private readonly now: () => number = Date.now,
    private readonly planner: Planner = new CodexPlanner(),
    /** Canonical repo roots the planner may inspect; empty = planning disabled. */
    private readonly allowedRepoRoots: readonly string[] = [],
    /** Optional automated executor; unset = agent-driven mode (a DSH session
     * claims the current issue and reports via exec-result). */
    private readonly executor?: Executor,
    /** Optional Codex reviewer; default is the production CodexReviewer. */
    private readonly reviewer: Reviewer = new CodexReviewer(),
    /** P5 execution/worktree options. */
    options: TaskFlowOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1))
    this.integrationBranch = options.integrationBranch ?? 'taskflow/integration'
    this.worktrees = new WorktreeManager(options.git, options.worktreesRoot ?? '.taskflow/worktrees')
  }

  /** Submit a new workflow run; returns its RECEIVED snapshot. An explicit
   * idempotencyKey deduplicates only when the normalized request (title,
   * description, and repoRoot) matches the existing run; a different request
   * under the same key is a stable conflict. Submits without a key always
   * create a fresh run (no title-based dedup). */
  submit(request: SubmitRequest): Promise<RunSnapshot> {
    validateSubmit(request)
    const explicitKey = request.idempotencyKey
    // Canonicalize at submit: the ledger always stores the absolute root the
    // planner resolves against (host cwd), so snapshots handed to executing
    // DSH sessions identify the same repository regardless of their cwd.
    const normalizedRepoRoot = request.repoRoot === undefined || request.repoRoot.trim() === ''
      ? undefined
      : resolve(request.repoRoot.trim())
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
        executions: [],
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

  /** P6 board projection: the run ledger grouped into kanban columns. */
  board(): BoardSnapshot {
    return buildBoard(this.list())
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
    const starting = this.startingTransitions.get(runId)
    if (inFlight !== undefined || starting !== undefined) {
      if (starting !== undefined) {
        // A sibling is making the PLANNING transition durable. Await the same
        // promise so our ack is never a false 202 while the run is still
        // RECEIVED; a failed transition propagates to every overlapping
        // caller instead of being acknowledged.
        try {
          await starting
        } catch (error) {
          const message = (error as Error).message
          if (message.startsWith('taskflow:')) {
            return { ok: false, error: message }
          }
          throw error
        }
        // The sibling registers its flow in the continuation that ran before
        // ours (microtask FIFO), so re-read the map instead of using the
        // pre-transition capture: wait:true must await the flow, not just the
        // transition.
        const flow = this.planFlows.get(runId)
        if (options.wait === true && flow !== undefined) {
          await flow.catch(() => undefined)
        }
        return { ok: true, runId, status: 'PLANNING', alreadyPlanned: false }
      }
      if (options.wait === true && inFlight !== undefined) {
        await inFlight.catch(() => undefined)
      }
      return { ok: true, runId, status: 'PLANNING', alreadyPlanned: false }
    }
    if (run.status === 'RECEIVED') {
      // Await the durable PLANNING transition before acknowledging: the HTTP
      // route must never answer 202 for a run that is still RECEIVED or was
      // cancelled by a queued command. Only the planner body stays background.
      let transition: Promise<void>
      try {
        transition = this.repository.updateRun(runId, (current) => {
          assertTransition(current.status, 'PLANNING')
          return this.withTransition(current, 'PLANNING', 'planning-started', `plan:start:${inputHash}`)
        }).then(() => { this.notify() })
        this.startingTransitions.set(runId, transition)
        void transition.then(
          () => { this.startingTransitions.delete(runId) },
          () => { this.startingTransitions.delete(runId) },
        )
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('taskflow:')) {
          return { ok: false, error: message }
        }
        throw error
      }
      try {
        await transition
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('taskflow:')) {
          return { ok: false, error: message }
        }
        throw error
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

  /**
   * Start execution of a READY run: READY → EXECUTING (durable, awaited before
   * any ack), then up to maxConcurrent schedulable issues are claimed and
   * isolated in worktrees. With an executor installed the wave loop runs in
   * the background (claim → execute → report → next wave); without one the DSH
   * session claims issues, performs them, reports outcomes via reportResult,
   * and calls execute again to claim more. Single-flight: overlapping calls,
   * resume overlaps, and recovery share one flow per run. Completing every
   * issue moves the run to INTEGRATION_REVIEW (the P4 review gate); a failed
   * issue moves it to FAILED.
   * @param runId - the run to execute.
   * @param options - wait: await the background flow (tests/CLI) instead of
   * returning right after the EXECUTING transition and first claim.
   */
  async startExecution(runId: string, options: { wait?: boolean } = {}): Promise<ExecutionStartResult> {
    const run = this.repository.getRun(runId)
    if (run === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    if (run.issues.length === 0) {
      return { ok: false, error: 'taskflow: run has no issues; execution requires a published plan' }
    }
    if (run.status !== 'READY' && run.status !== 'EXECUTING') {
      return { ok: false, error: `taskflow: illegal transition ${run.status} → EXECUTING` }
    }
    // Single-flight at entry (synchronous, before any await).
    const inFlight = this.executionFlows.get(runId)
    const starting = this.startingExecutions.get(runId)
    if (inFlight !== undefined || starting !== undefined) {
      if (starting !== undefined) {
        try {
          await starting
        } catch (error) {
          const message = (error as Error).message
          if (message.startsWith('taskflow:')) {
            return { ok: false, error: message }
          }
          throw error
        }
        const flow = this.executionFlows.get(runId)
        if (options.wait === true && flow !== undefined) {
          await flow.catch(() => undefined)
        }
      } else if (options.wait === true && inFlight !== undefined) {
        await inFlight.catch(() => undefined)
      }
      const current = this.currentRunningIssues(runId)
      return {
        ok: true,
        runId,
        status: 'EXECUTING',
        alreadyExecuting: true,
        currentIssue: current[0]?.key,
        currentIssues: current.map((execution) => ({
          key: execution.key,
          workDir: execution.workDir,
          branch: execution.branch,
        })),
      }
    }
    if (run.status === 'READY') {
      // Await the durable EXECUTING transition before acknowledging; a failed
      // write propagates to every overlapping caller (no false 202). The
      // starting marker is set synchronously before the async base-SHA capture
      // so concurrent startExecution calls share the same transition promise.
      let transition: Promise<void>
      try {
        transition = (async () => {
          // Capture the base SHA before any worktree is created so the P4
          // reviewer can later inspect the integration-branch diff.
          let baseSha = run.baseSha
          if (baseSha === undefined && run.repoRoot !== undefined) {
            baseSha = await this.worktrees.getHeadSha(run.repoRoot)
          }
          await this.repository.updateRun(runId, (current) => {
            assertTransition(current.status, 'EXECUTING')
            return this.withTransition(current, 'EXECUTING', 'execution-started', `exec:start:${runId}`, {
              baseSha,
            })
          })
          this.notify()
        })()
        this.startingExecutions.set(runId, transition)
        void transition.then(
          () => { this.startingExecutions.delete(runId) },
          () => { this.startingExecutions.delete(runId) },
        )
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('taskflow:')) {
          return { ok: false, error: message }
        }
        throw error
      }
      try {
        await transition
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('taskflow:')) {
          return { ok: false, error: message }
        }
        throw error
      }
    }
    if (this.executor === undefined) {
      // Agent-driven mode: claim up to maxConcurrent schedulable issues and
      // hand them to the DSH session; each reportResult records the outcome
      // and the agent calls execute again to claim more.
      await this.claimSchedulableIssues(runId, this.maxConcurrent)
      const current = this.currentRunningIssues(runId)
      return {
        ok: true,
        runId,
        status: 'EXECUTING',
        alreadyExecuting: false,
        currentIssue: current[0]?.key,
        currentIssues: current.map((execution) => ({
          key: execution.key,
          workDir: execution.workDir,
          branch: execution.branch,
        })),
      }
    }
    const flow = this.runExecutionBody(runId)
    this.executionFlows.set(runId, flow)
    void flow.then(
      () => { this.executionFlows.delete(runId) },
      () => { this.executionFlows.delete(runId) },
    )
    if (options.wait === true) {
      await flow.catch(() => undefined)
    }
    const current = this.currentRunningIssues(runId)
    return {
      ok: true,
      runId,
      status: 'EXECUTING',
      alreadyExecuting: false,
      currentIssue: current[0]?.key,
      currentIssues: current.map((execution) => ({
        key: execution.key,
        workDir: execution.workDir,
        branch: execution.branch,
      })),
    }
  }

  /**
   * Report one issue's outcome to the runner. The issue must be one of the
   * currently `running` issues. A success is first merged from its worktree
   * branch into the integration branch, then recorded as `done`; the last
   * success moves the run to INTEGRATION_REVIEW. A failure is recorded as
   * `failed` and moves the run to FAILED. All checks re-run inside the
   * repository's atomic RMW.
   */
  async reportResult(runId: string, issueKey: string, result: ExecutionResult): Promise<ExecutionReport> {
    const run = this.repository.getRun(runId)
    if (run === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    if (run.status !== 'EXECUTING') {
      return { ok: false, error: `taskflow: cannot report a result for run ${runId} in status ${run.status}` }
    }
    const running = (run.executions ?? []).find((execution) => execution.status === 'running' && execution.key === issueKey)
    if (running === undefined) {
      return { ok: false, error: `taskflow: issue '${issueKey}' is not currently running` }
    }
    const repoRoot = run.repoRoot
    const workDir = running.workDir
    const branch = running.branch
    let effectiveResult = result
    if (result.ok && repoRoot !== undefined && workDir !== undefined && branch !== undefined) {
      try {
        // Ensure uncommitted worktree edits are on the issue branch before the
        // integration merge; otherwise merge would be a no-op and cleanup would
        // silently discard the executor's work.
        await this.worktrees.commitWorktreeEdits(workDir, `taskflow ${runId} ${issueKey}`)
        await this.withMergeLock(repoRoot, () => this.worktrees.mergeIssueWorktree(
          repoRoot,
          branch,
          `taskflow ${runId} ${issueKey}`,
          this.integrationBranch,
        ))
      } catch (error) {
        effectiveResult = { ok: false, error: `worktree merge failed: ${(error as Error).message}` }
      }
    }
    try {
      await this.repository.updateRun(runId, (current) => {
        const currentExecutions = current.executions ?? []
        const currentRunning = currentExecutions.find((execution) => execution.status === 'running' && execution.key === issueKey)
        if (currentRunning === undefined) {
          throw new Error(`taskflow: issue '${issueKey}' is not currently running`)
        }
        const now = this.now()
        const finished: IssueExecution = effectiveResult.ok
          ? {
              key: issueKey,
              status: 'done',
              startedAt: currentRunning.startedAt,
              finishedAt: now,
              summary: effectiveResult.summary,
              workDir: currentRunning.workDir,
              branch: currentRunning.branch,
            }
          : {
              key: issueKey,
              status: 'failed',
              startedAt: currentRunning.startedAt,
              finishedAt: now,
              error: effectiveResult.error,
              workDir: currentRunning.workDir,
              branch: currentRunning.branch,
            }
        const executionsNext = [
          ...currentExecutions.filter((execution) => execution.key !== issueKey),
          finished,
        ]
        if (!effectiveResult.ok) {
          assertTransition(current.status, 'FAILED')
          return this.withTransition(current, 'FAILED', `execution-failed: ${issueKey}: ${effectiveResult.error}`, `exec:fail:${runId}`, {
            executions: executionsNext,
          })
        }
        const doneKeys = new Set(executionsNext.filter((execution) => execution.status === 'done').map((execution) => execution.key))
        const allDone = current.issues.every((issue) => doneKeys.has(issue.key))
        if (allDone) {
          assertTransition(current.status, 'INTEGRATION_REVIEW')
          return this.withTransition(current, 'INTEGRATION_REVIEW', 'execution-completed', `exec:done:${runId}`, {
            executions: executionsNext,
          })
        }
        const next: RunAggregate = {
          ...current,
          updatedAt: now,
          executions: executionsNext,
        }
        runAggregateSchema.parse(next)
        return next
      })
      this.notify()
      if (effectiveResult.ok && run.repoRoot !== undefined && running.workDir !== undefined && running.branch !== undefined) {
        // Best-effort cleanup after the durable success record; a failure here
        // must not fail an already-merged issue.
        await this.worktrees.removeIssueWorktree(run.repoRoot, running.workDir, running.branch).catch(() => undefined)
      }
      return { ok: true }
    } catch (error) {
      const message = (error as Error).message
      if (message.startsWith('taskflow:')) {
        return { ok: false, error: message }
      }
      throw error
    }
  }

  /** Resume every persisted EXECUTING run (called at host start): a `running`
   * issue stuck by a crash is reset to pending (deterministic re-claim) and
   * the serial flow restarts (with an executor) or the first schedulable
   * issue is claimed (agent-driven mode). */
  resumeExecution(): void {
    for (const run of this.repository.listRuns()) {
      if (run.status === 'EXECUTING') {
        void this.resetStuckExecutions(run.id)
          .then(() => this.startExecution(run.id))
          .catch(() => undefined)
      }
    }
  }

  /**
   * Start the P4 review gate for an INTEGRATION_REVIEW run. The review runs in
   * the background (Codex CLI, read-only); PASS moves the run to
   * AWAITING_HUMAN, REVISE moves it back to EXECUTING and resets the selected
   * (or all) issue executions to pending so the serial runner re-claims them.
   * Single-flight: overlapping calls share one flow per run.
   * @param runId - the run to review.
   * @param options - wait: await the background flow (tests/CLI) instead of
   * returning right after the review flow starts.
   */
  async startReview(runId: string, options: { wait?: boolean } = {}): Promise<ReviewStartResult> {
    const run = this.repository.getRun(runId)
    if (run === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    if (run.status !== 'INTEGRATION_REVIEW') {
      return { ok: false, error: `taskflow: illegal transition ${run.status} → INTEGRATION_REVIEW` }
    }
    const inFlight = this.reviewFlows.get(runId)
    if (inFlight !== undefined) {
      if (options.wait === true) {
        await inFlight.catch(() => undefined)
      }
      const current = this.repository.getRun(runId)
      return {
        ok: true,
        runId,
        status: current?.status ?? 'INTEGRATION_REVIEW',
        alreadyReviewing: true,
        verdict: current?.review?.verdict,
      }
    }
    const flow = this.runReviewBody(runId)
    this.reviewFlows.set(runId, flow)
    void flow.then(
      () => { this.reviewFlows.delete(runId) },
      () => { this.reviewFlows.delete(runId) },
    )
    if (options.wait === true) {
      await flow.catch(() => undefined)
    }
    const current = this.repository.getRun(runId)
    return {
      ok: true,
      runId,
      status: current?.status ?? 'INTEGRATION_REVIEW',
      alreadyReviewing: false,
      verdict: current?.review?.verdict,
    }
  }

  /**
   * Durable claim of up to `limit` schedulable issues: no issue may be claimed
   * twice, candidates must be pending with all dependencies done, chosen in
   * deterministic topological order (stable by issue key). Re-checks inside
   * the atomic RMW so concurrent claims can never double-claim. After the
   * atomic RMW, each claimed issue gets an isolated worktree (or reuses a
   * persisted one from a crash).
   * @returns claimed issues with their worktree info.
   */
  private async claimSchedulableIssues(
    runId: string,
    limit: number,
  ): Promise<Array<{ key: string; issue: PlannedIssue; workDir?: string; branch?: string }>> {
    const claimed: Array<{ key: string; issue: PlannedIssue; existing?: IssueExecution }> = []
    await this.repository.updateRun(runId, (current) => {
      if (current.status !== 'EXECUTING') return current
      const executions = current.executions ?? []
      const runningCount = executions.filter((execution) => execution.status === 'running').length
      const doneKeys = new Set(executions.filter((execution) => execution.status === 'done').map((execution) => execution.key))
      const runningKeys = new Set(executions.filter((execution) => execution.status === 'running').map((execution) => execution.key))
      const available = limit - runningCount
      if (available <= 0) return current
      const candidates = this.topologicalOrder(current).filter((issue) =>
        !doneKeys.has(issue.key)
        && !runningKeys.has(issue.key)
        && (issue.deps ?? []).every((dependency) => doneKeys.has(dependency)),
      )
      const nextExecutions = [...executions]
      for (const candidate of candidates.slice(0, available)) {
        const existing = executions.find((execution) => execution.key === candidate.key)
        claimed.push({ key: candidate.key, issue: candidate, existing })
        const running: IssueExecution = existing !== undefined
          ? { ...existing, status: 'running', startedAt: existing.startedAt ?? this.now() }
          : { key: candidate.key, status: 'running', startedAt: this.now() }
        const index = nextExecutions.findIndex((execution) => execution.key === candidate.key)
        if (index >= 0) nextExecutions[index] = running
        else nextExecutions.push(running)
      }
      const next: RunAggregate = {
        ...current,
        updatedAt: this.now(),
        executions: nextExecutions,
      }
      runAggregateSchema.parse(next)
      return next
    })
    if (claimed.length > 0) this.notify()

    const result: Array<{ key: string; issue: PlannedIssue; workDir?: string; branch?: string }> = []
    for (const claim of claimed) {
      if (claim.existing?.workDir !== undefined && claim.existing.branch !== undefined) {
        result.push({ key: claim.key, issue: claim.issue, workDir: claim.existing.workDir, branch: claim.existing.branch })
        continue
      }
      const run = this.repository.getRun(runId)
      if (run?.repoRoot === undefined) {
        await this.failRunningIssue(runId, claim.key, 'taskflow: run has no repoRoot')
        break
      }
      try {
        const worktree = await this.worktrees.createIssueWorktree(run.repoRoot, runId, claim.key, this.integrationBranch)
        await this.repository.updateRun(runId, (current) => {
          const executions = current.executions ?? []
          const index = executions.findIndex((execution) => execution.key === claim.key)
          if (index < 0) return current
          const nextExecutions = [...executions]
          nextExecutions[index] = { ...executions[index], workDir: worktree.workDir, branch: worktree.branch }
          const next: RunAggregate = { ...current, updatedAt: this.now(), executions: nextExecutions }
          runAggregateSchema.parse(next)
          return next
        })
        result.push({ key: claim.key, issue: claim.issue, workDir: worktree.workDir, branch: worktree.branch })
      } catch (error) {
        await this.failRunningIssue(runId, claim.key, `worktree create failed: ${(error as Error).message}`)
        break
      }
    }
    return result
  }

  /** Mark a claimed issue failed (and the run FAILED) after an infrastructure error. */
  private async failRunningIssue(runId: string, issueKey: string, error: string): Promise<void> {
    await this.reportResult(runId, issueKey, { ok: false, error })
  }

  /** Serialize integration-branch merges per repository so concurrent
   * reportResult calls cannot race checkout/merge/restore on the same repo. */
  private async withMergeLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeTails.get(repoRoot) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
    this.mergeTails.set(repoRoot, prev.then(() => current))
    await prev.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** Reset a crash-stuck `running` issue back to pending (host-start resume). */
  private async resetStuckExecutions(runId: string): Promise<void> {
    await this.repository.updateRun(runId, (current) => {
      if ((current.executions ?? []).every((execution) => execution.status !== 'running')) return current
      const next: RunAggregate = {
        ...current,
        updatedAt: this.now(),
        executions: (current.executions ?? []).map((execution) => (
          execution.status === 'running' ? { ...execution, status: 'pending' as const } : execution
        )),
      }
      runAggregateSchema.parse(next)
      return next
    })
    this.notify()
  }

  /** The P5 wave executor loop: claim up to maxConcurrent issues, run them in
   * parallel, report each, then advance to the next wave. */
  private async runExecutionBody(runId: string): Promise<void> {
    const executor = this.executor
    if (executor === undefined) return
    while (true) {
      const claims = await this.claimSchedulableIssues(runId, this.maxConcurrent)
      if (claims.length === 0) return
      const run = this.repository.getRun(runId)
      if (run === undefined || run.repoRoot === undefined) return
      const repoRoot = run.repoRoot
      const outcomes = await Promise.all(claims.map(async (claim) => {
        let result: ExecutionResult
        try {
          result = await executor.execute({
            runId,
            issue: claim.issue,
            repoRoot,
            workDir: claim.workDir ?? join(defaultPlanRoot(), runId, claim.issue.key),
          })
        } catch (error) {
          // An executor infrastructure crash is a run failure, not a client
          // conflict: strip any taskflow: prefix so the record lands as FAILED.
          result = { ok: false, error: (error as Error).message.replace(/^taskflow:\s*/, '') }
        }
        const report = await this.reportResult(runId, claim.key, result)
        return report.ok && result.ok
      }))
      if (outcomes.some((ok) => !ok)) return
    }
  }

  /** Background P4 review body: reviewer → PASS/REVISE transition
   * (single-flight via reviewFlows). */
  private async runReviewBody(runId: string): Promise<void> {
    try {
      const run = this.repository.getRun(runId)
      if (run === undefined) return
      if (run.repoRoot === undefined || run.repoRoot === '') {
        await this.transitionTo(runId, 'FAILED', 'review-failed: run has no repoRoot', `review:fail:${runId}`)
        return
      }
      const raw = await this.reviewer.review({
        runId,
        title: run.title,
        description: run.description,
        repoRoot: run.repoRoot,
        issues: run.issues,
        executions: run.executions ?? [],
        workDir: join(defaultPlanRoot(), runId),
        baseSha: run.baseSha,
      })
      const result = this.normalizeReviewResult(run, raw)
      if (result.verdict === 'PASS') {
        await this.repository.updateRun(runId, (current) => {
          assertTransition(current.status, 'AWAITING_HUMAN')
          return this.withTransition(current, 'AWAITING_HUMAN', 'review-passed', `review:pass:${runId}`, {
            review: { verdict: 'PASS', summary: result.summary, reworkKeys: [], at: this.now() },
          })
        })
        this.notify()
        return
      }
      const reworkKeys = this.reworkClosure(run, result.reworkKeys)
      await this.repository.updateRun(runId, (current) => {
        assertTransition(current.status, 'EXECUTING')
        return this.withTransition(current, 'EXECUTING', 'review-revise', `review:revise:${runId}`, {
          executions: this.resetReworkExecutions(current.executions ?? [], reworkKeys),
          review: { verdict: 'REVISE', summary: result.summary, reworkKeys: [...reworkKeys], at: this.now() },
        })
      })
      this.notify()
    } catch (error) {
      const message = error instanceof ReviewerError
        ? error.message
        : (error as Error).message
      try {
        await this.transitionTo(runId, 'FAILED', `review-failed: ${message}`, `review:fail:${runId}`)
      } catch {
        // The run is already terminal; the first transition attempt recorded the failure.
      }
    }
  }

  /** Validate/normalize a raw reviewer object into a ReviewResult. Unknown
   * rework keys are ignored; an empty (or fully filtered) list means all
   * issues are reworked. */
  private normalizeReviewResult(run: RunAggregate, raw: unknown): ReviewResult {
    const object = (raw ?? {}) as { verdict?: unknown; summary?: unknown; reworkKeys?: unknown }
    if (object.verdict !== 'PASS' && object.verdict !== 'REVISE') {
      throw new ReviewerError('parse-failed', 'reviewer output has invalid verdict')
    }
    if (typeof object.summary !== 'string') {
      throw new ReviewerError('parse-failed', 'reviewer output has invalid summary')
    }
    const knownKeys = new Set(run.issues.map((issue) => issue.key))
    const reworkKeys = Array.isArray(object.reworkKeys)
      ? object.reworkKeys.filter((key): key is string => typeof key === 'string' && knownKeys.has(key))
      : []
    return { verdict: object.verdict, summary: object.summary, reworkKeys }
  }

  /** Compute the transitive rework closure: selected keys plus every issue that
   * depends on them (directly or indirectly). An empty selection means all
   * issues are reworked. */
  private reworkClosure(run: RunAggregate, keys: readonly string[]): Set<string> {
    const selected = new Set(keys.length === 0 ? run.issues.map((issue) => issue.key) : keys)
    const dependents = new Map<string, string[]>()
    for (const issue of run.issues) {
      for (const dependency of issue.deps ?? []) {
        const list = dependents.get(dependency) ?? []
        list.push(issue.key)
        dependents.set(dependency, list)
      }
    }
    const closure = new Set<string>()
    const queue = [...selected]
    while (queue.length > 0) {
      const key = queue.shift() as string
      if (closure.has(key)) continue
      closure.add(key)
      for (const dependent of dependents.get(key) ?? []) {
        if (!closure.has(dependent)) queue.push(dependent)
      }
    }
    return closure
  }

  /** Reset reworked (and transitively affected) done/failed issues to pending. */
  private resetReworkExecutions(
    executions: readonly IssueExecution[],
    reworkKeys: ReadonlySet<string>,
  ): IssueExecution[] {
    return executions.map((execution) => {
      if (execution.status !== 'done' && execution.status !== 'failed') return execution
      if (!reworkKeys.has(execution.key)) return execution
      return { key: execution.key, status: 'pending' as const }
    })
  }

  /** All currently running issues of a run (P5 parallel). */
  private currentRunningIssues(runId: string): IssueExecution[] {
    const run = this.repository.getRun(runId)
    return (run?.executions ?? []).filter((execution) => execution.status === 'running')
  }

  /** Deterministic topological order of the run's issues (stable by key). */
  private topologicalOrder(run: RunAggregate): PlannedIssue[] {
    const byKey = new Map(run.issues.map((issue) => [issue.key, issue]))
    const indegree = new Map(run.issues.map((issue) => [issue.key, (issue.deps ?? []).length]))
    const dependents = new Map<string, string[]>()
    for (const issue of run.issues) {
      for (const dependency of issue.deps ?? []) {
        const list = dependents.get(dependency) ?? []
        list.push(issue.key)
        dependents.set(dependency, list)
      }
    }
    const queue = run.issues.filter((issue) => (issue.deps ?? []).length === 0).map((issue) => issue.key).sort()
    const order: PlannedIssue[] = []
    const seen = new Set<string>()
    while (queue.length > 0) {
      const key = queue.shift() as string
      if (seen.has(key)) continue
      seen.add(key)
      order.push(byKey.get(key) as PlannedIssue)
      for (const dependent of (dependents.get(key) ?? []).sort()) {
        const remaining = (indegree.get(dependent) ?? 1) - 1
        indegree.set(dependent, remaining)
        if (remaining === 0) queue.push(dependent)
      }
      queue.sort()
    }
    return order
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
    patch: Partial<Pick<RunAggregate, 'issueCount' | 'issues' | 'executions' | 'review' | 'baseSha'>> = {},
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
   * encoding change), so retries of legacy explicit keys stay idempotent.
   * The legacy arm excludes generated encodings (`submit:*` and `create:*`):
   * a stored `submit:foo` is the current encoding of key `foo`, never a bare
   * legacy key, and the `create:<runId>` markers of unkeyed runs are never
   * matchable — so user keys that merely look like encodings stay distinct. */
  private findByExplicitKey(idempotencyKey: string): RunAggregate | undefined {
    const target = `submit:${idempotencyKey}`
    return this.repository.listRuns().find((run) => {
      const creation = run.transitions[0]
      if (creation === undefined) return false
      if (creation.idempotencyKey === target) return true
      return !creation.idempotencyKey.startsWith('submit:')
        && !creation.idempotencyKey.startsWith('create:')
        && creation.idempotencyKey === idempotencyKey
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
      repoRoot: run.repoRoot,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      issueCount: run.issueCount,
      transitionCount: run.transitions.length,
      issues: run.issues.map((issue) => ({
        key: issue.key,
        acceptance: issue.acceptance,
        deps: [...(issue.deps ?? [])],
        risk: issue.risk ?? null,
      })),
      executions: (run.executions ?? []).map((execution) => ({
        key: execution.key,
        status: execution.status,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        summary: execution.summary,
        error: execution.error,
        workDir: execution.workDir,
        branch: execution.branch,
      })),
      review: run.review === undefined ? undefined : {
        verdict: run.review.verdict,
        summary: run.review.summary,
        reworkKeys: [...run.review.reworkKeys],
        at: run.review.at,
      },
      baseSha: run.baseSha,
    }
  }
}

/** P6 board column order and user-facing titles. */
const BOARD_COLUMNS: readonly BoardColumnId[] = ['todo', 'doing', 'review', 'done', 'failed']

const BOARD_COLUMN_TITLES: Record<BoardColumnId, string> = {
  todo: '待办',
  doing: '进行中',
  review: '待审查',
  done: '已完成',
  failed: '失败',
}

/** Map one run/issue pair to its kanban column. */
function boardColumnFor(run: RunSnapshot, execution: IssueExecutionSnapshot | undefined): BoardColumnId {
  if (run.status === 'FAILED' || run.status === 'CANCELLED') {
    return execution?.status === 'done' ? 'done' : 'failed'
  }
  if (execution === undefined || execution.status === 'pending') return 'todo'
  if (execution.status === 'running') return 'doing'
  if (execution.status === 'failed') return 'failed'
  if (run.status === 'INTEGRATION_REVIEW' || run.status === 'AWAITING_HUMAN') return 'review'
  return 'done'
}

/** Build the P6 board projection from run snapshots (pure, deterministic). */
export function buildBoard(runs: readonly RunSnapshot[]): BoardSnapshot {
  const cardsByColumn = new Map<BoardColumnId, BoardCard[]>(BOARD_COLUMNS.map((id) => [id, []]))
  for (const run of runs) {
    for (const issue of run.issues) {
      const execution = run.executions.find((item) => item.key === issue.key)
      const column = boardColumnFor(run, execution)
      const cards = cardsByColumn.get(column)
      if (cards === undefined) continue
      cards.push({
        runId: run.id,
        runTitle: run.title,
        runStatus: run.status,
        issueKey: issue.key,
        acceptance: issue.acceptance,
        deps: [...issue.deps],
        risk: issue.risk ?? null,
        status: execution?.status ?? 'pending',
        summary: execution?.summary,
      })
    }
  }
  return {
    columns: BOARD_COLUMNS.map((id) => ({
      id,
      title: BOARD_COLUMN_TITLES[id],
      cards: cardsByColumn.get(id) ?? [],
    })),
  }
}

/** Whether a status is terminal (exported for route/host convenience). */
export { isTerminal }

/** Spool root for planner artifacts: <DSH_HOME>/taskflow/plans/<runId>/. */
function defaultPlanRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'taskflow', 'plans')
}
