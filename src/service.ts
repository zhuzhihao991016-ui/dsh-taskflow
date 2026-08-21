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
import {
  AUTOMATION_CONTROL_ACTIONS,
  DEFAULT_AUTOMATION_CONFIG,
  type AutomationControlAction,
  type ExecutorPhase,
  type RunDetailResponse,
  type TaskFlowEvent,
  type TaskFlowEventKind,
} from './contracts.ts'
import type { AutomatedExecutionInput, AutomatedExecutionResult, AutomatedExecutor } from './contracts.ts'
import { runAggregateSchema, type IssueExecution, type ReviewVerdict, type RunAggregate, type RunControl, type RunGitIsolation, type RunTransition } from './domain.ts'
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
    findings?: Array<{
      issueKey: string
      problem: string
      evidenceNeeded: string[]
      acceptance: string
    }>
    evidenceChecklist?: string[]
    at: number
  }
  /** P5: base commit SHA captured when execution started. */
  baseSha?: string
  /** P8.1: persistent automation/control metadata. */
  control?: RunControl
  /** P8.1: run-scoped Git isolation metadata. */
  runGit?: RunGitIsolation
  /** P8.1: bounded whitelisted event log. */
  events?: TaskFlowEvent[]
}

/** Projected planned issue (agent needs acceptance/deps to execute). */
export interface IssueSnapshot {
  key: string
  taskId?: string
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
  /** P8.1: automated-executor attempt id (progress metadata). */
  attemptId?: string
  /** P8.1: coarse automated-executor phase. */
  phase?: ExecutorPhase
  /** P8.1: last progress heartbeat timestamp. */
  heartbeatAt?: number
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

/** Commands the host accepts on a run (P1: cancel; P8.1: automation control actions). */
export type CommandAction = AutomationControlAction

/** Result of one command; ok:false carries a stable machine-readable error. */
export interface CommandResult {
  ok: boolean
  error?: string
}

/** Final human acceptance decision on an AWAITING_HUMAN run (P7). */
export type HumanDecision = 'accept' | 'rework'

/** Result of a human acceptance decision. */
export type HumanDecisionResult =
  | { ok: true; runId: string; status: RunStatus }
  | { ok: false; error: string }

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
  /** P8.1: master switch for automation (persisted in run control metadata). */
  automationEnabled?: boolean
  /** P8: global cap on concurrent Codex executor processes (reserved for the
   * automatic coordinator; the built-in executor uses per-run maxConcurrent). */
  maxExecutorProcesses?: number
  /** P8.3: automatically start planning when automation is enabled. */
  autoPlan?: boolean
  /** P8.3: automatically start Codex review when automation is enabled. */
  autoReview?: boolean
  /** P8.3: maximum automatic review/rework cycles before asking a human. */
  maxReviewCycles?: number
  /** P8.4: wait for human release before automatic execution starts. */
  requireExecutionPermission?: boolean
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
  /** P8.3: SSE/event subscribers receive each durable whitelisted event. */
  private readonly eventSubscriptions = new Set<{
    listener: (event: TaskFlowEvent) => void
    seen: Map<string, number>
  }>()
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
  private readonly automationEnabled: boolean
  private readonly automationMode: 'manual' | 'automatic'
  private readonly autoPlan: boolean
  private readonly autoReview: boolean
  private readonly maxReviewCycles: number

  private readonly requireExecutionPermission: boolean
  private readonly maxExecutorProcesses: number
  /** Active automated-executor AbortControllers per run (for pause/cancel/takeover). */
  private readonly activeExecutions = new Map<string, Set<AbortController>>()
  /** Global automated-executor concurrency semaphore state. */
  private executorActive = 0
  private readonly executorWaiters: Array<() => void> = []

  constructor(
    private readonly repository: TaskFlowRepository,
    private readonly now: () => number = Date.now,
    private readonly planner: Planner = new CodexPlanner(),
    /** Canonical repo roots the planner may inspect; empty = planning disabled. */
    private readonly allowedRepoRoots: readonly string[] = [],
    /** Optional automated executor; unset = agent-driven mode (a DSH session
     * claims the current issue and reports via exec-result). */
    private readonly executor?: Executor | AutomatedExecutor,
    /** Optional Codex reviewer; default is the production CodexReviewer. */
    private readonly reviewer: Reviewer = new CodexReviewer(),
    /** P5 execution/worktree options. */
    options: TaskFlowOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 1))
    this.integrationBranch = options.integrationBranch ?? 'taskflow/integration'
    this.worktrees = new WorktreeManager(options.git, options.worktreesRoot ?? '.taskflow/worktrees')
    this.automationEnabled = options.automationEnabled ?? false
    this.automationMode = this.automationEnabled ? 'automatic' : 'manual'
    this.autoPlan = options.autoPlan ?? DEFAULT_AUTOMATION_CONFIG.autoPlan
    this.autoReview = options.autoReview ?? DEFAULT_AUTOMATION_CONFIG.autoReview
    this.maxReviewCycles = Math.max(1, Math.floor(options.maxReviewCycles ?? DEFAULT_AUTOMATION_CONFIG.maxReviewCycles))
    this.requireExecutionPermission = options.requireExecutionPermission ?? DEFAULT_AUTOMATION_CONFIG.requireExecutionPermission
    this.maxExecutorProcesses = Math.max(1, Math.floor(options.maxExecutorProcesses ?? DEFAULT_AUTOMATION_CONFIG.maxExecutorProcesses))
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
        control: {
          automation: { enabled: this.automationEnabled, mode: this.automationMode },
          paused: false,
          takenOver: false,
          retryCount: 0,
        },
        events: [],
        transitions: [creationTransition(now, explicitKey !== undefined ? `submit:${explicitKey}` : `create:${id}`)],
      }
      // Parse before persist: a malformed aggregate must never reach the
      // medium (KvTable.put does not schema-check; open-time validation would
      // then fail the whole plugin on the next restart).
      runAggregateSchema.parse(aggregate)
      await this.repository.insertRun(aggregate)
      this.notify()
      if (this.automationEnabled && this.autoPlan && this.isRunAutomationEnabled(aggregate) && normalizedRepoRoot !== undefined) {
        void this.plan(id).catch(() => undefined)
      }
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

  /** P8.1 run-detail projection: the durable automation/control metadata,
   * current running issue progress, allowed control actions, and recent events. */
  runDetail(runId: string): RunDetailResponse | undefined {
    const run = this.repository.getRun(runId)
    if (run === undefined) return undefined
    const running = (run.executions ?? []).find((execution) => execution.status === 'running')
    return {
      runId: run.id,
      status: run.status,
      automation: {
        enabled: run.control?.automation.enabled ?? this.automationEnabled,
        mode: run.control?.automation.mode ?? this.automationMode,
      },
      currentIssue: running === undefined ? undefined : {
        key: running.key,
        attemptId: running.attemptId,
        phase: running.phase,
        workDir: running.workDir,
        branch: running.branch,
        heartbeatAt: running.heartbeatAt,
      },
      allowedActions: this.allowedActions(run),
      recentEvents: (run.events ?? []).slice(-50),
    }
  }

  /** P8.1 persist one whitelisted automated-executor progress event and update
   * the running issue's attempt/phase/heartbeat metadata. */
  async recordProgress(
    runId: string,
    issueKey: string,
    progress: { attemptId?: string; phase: ExecutorPhase; summary?: string; detail?: string; at?: number },
  ): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
    const run = this.repository.getRun(runId)
    if (run === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    if (run.status !== 'EXECUTING') {
      return { ok: false, error: `taskflow: cannot record progress for run ${runId} in status ${run.status}` }
    }
    const running = (run.executions ?? []).find((execution) => execution.status === 'running' && execution.key === issueKey)
    if (running === undefined) {
      return { ok: false, error: `taskflow: issue '${issueKey}' is not currently running` }
    }
    try {
      const updated = await this.repository.updateRun(runId, (current) => {
        const currentRunning = (current.executions ?? []).find((execution) => execution.status === 'running' && execution.key === issueKey)
        if (currentRunning === undefined) {
          throw new Error(`taskflow: issue '${issueKey}' is not currently running`)
        }
        const events = current.events ?? []
        const nextEvents = this.appendEvent(events, runId, 'issue.progress', {
          issueKey,
          attemptId: progress.attemptId ?? currentRunning.attemptId,
          phase: progress.phase,
          summary: progress.summary,
        })
        const executions = (current.executions ?? []).map((execution) => (
          execution.key === issueKey
            ? {
                ...execution,
                attemptId: progress.attemptId ?? execution.attemptId,
                phase: progress.phase,
                heartbeatAt: progress.at ?? this.now(),
              }
            : execution
        ))
        const next: RunAggregate = {
          ...current,
          executions,
          events: nextEvents,
          updatedAt: progress.at ?? this.now(),
        }
        runAggregateSchema.parse(next)
        return next
      })
      this.notify()
      const events = updated.events ?? []
      return { ok: true, seq: events.length > 0 ? events[events.length - 1]!.seq : 0 }
    } catch (error) {
      const message = (error as Error).message
      if (message.startsWith('taskflow:')) {
        return { ok: false, error: message }
      }
      throw error
    }
  }

  /** Alias for {@link runDetail} (P8.1 contract consumers). */
  getRunDetail(runId: string): RunDetailResponse | undefined {
    return this.runDetail(runId)
  }

  /** Alias for {@link recordProgress} (P8.1 automated-executor callbacks). */
  reportProgress(
    runId: string,
    issueKey: string,
    progress: { attemptId?: string; phase: ExecutorPhase; summary?: string; detail?: string; at?: number },
  ): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
    return this.recordProgress(runId, issueKey, progress)
  }

  /**
   * Apply one command to a run. P1 supports cancel (any non-terminal status →
   * CANCELLED); unknown ids, terminal runs, and unimplemented actions fail
   * with a stable error. The transition check runs inside the repository's
   * atomic update, so a concurrent status change cannot be overwritten.
   */
  async command(runId: string, action: CommandAction, actor = 'host'): Promise<CommandResult> {
    if (!(AUTOMATION_CONTROL_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, error: `taskflow: unsupported action '${String(action)}'` }
    }
    if (this.repository.getRun(runId) === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    try {
      if (action === 'cancel' || action === 'pause' || action === 'takeover') {
        this.abortRunExecutions(runId)
      }
      const updated = await this.repository.updateRun(runId, (current) => {
        if (current.merging === true) {
          throw new Error('taskflow: cannot control while a merge is in progress')
        }
        const now = this.now()
        const control = current.control ?? this.defaultControl()
        const events = current.events ?? []
        const append = (kind: TaskFlowEventKind, extra: { summary?: string; issueKey?: string; attemptId?: string; phase?: ExecutorPhase } = {}) =>
          this.appendEvent(events, runId, kind, extra)
        const transitionTo = (
          to: RunStatus,
          reason: string,
          idempotencyKey: string,
          patch: Partial<Pick<RunAggregate, 'control' | 'events' | 'executions' | 'review' | 'baseSha' | 'runGit' | 'merging'>> = {},
        ): RunAggregate => {
          const seq = current.transitions.length
          const transition: RunTransition = {
            seq,
            from: current.status,
            to,
            reason,
            actor,
            idempotencyKey,
            at: now,
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
        switch (action) {
          case 'cancel':
            assertTransition(current.status, 'CANCELLED')
            return transitionTo('CANCELLED', 'cancelled', `command:cancel:${runId}:${current.transitions.length}`, {
              control: { ...control, paused: false, takenOver: false },
              events: append('run.updated', { summary: 'cancelled' }),
            })
          case 'pause':
            assertTransition(current.status, 'PAUSED')
            return transitionTo('PAUSED', 'paused', `command:pause:${runId}:${current.transitions.length}`, {
              control: { ...control, paused: true },
              executions: (current.executions ?? []).map((execution) => (
                execution.status === 'running' ? { ...execution, status: 'pending' as const } : execution
              )),
              events: append('automation.paused', { summary: 'paused' }),
            })
          case 'resume':
            assertTransition(current.status, 'EXECUTING')
            return transitionTo('EXECUTING', 'resumed', `command:resume:${runId}:${current.transitions.length}`, {
              control: { ...control, paused: false },
              events: append('automation.resumed', { summary: 'resumed' }),
            })
          case 'takeover':
            assertTransition(current.status, 'WAITING_PERMISSION')
            return transitionTo('WAITING_PERMISSION', 'takeover', `command:takeover:${runId}:${current.transitions.length}`, {
              control: { ...control, takenOver: true },
              executions: (current.executions ?? []).map((execution) => (
                execution.status === 'running' ? { ...execution, status: 'pending' as const } : execution
              )),
              events: append('run.updated', { summary: 'takeover' }),
            })
          case 'release':
            assertTransition(current.status, 'EXECUTING')
            return transitionTo('EXECUTING', 'released', `command:release:${runId}:${current.transitions.length}`, {
              control: { ...control, takenOver: false },
              events: append('run.updated', { summary: 'release' }),
            })
          case 'retry': {
            if (current.status !== 'EXECUTING' && current.status !== 'FAILED') {
              throw new Error(`taskflow: retry requires EXECUTING or FAILED, got ${current.status}`)
            }
            const hasFailed = (current.executions ?? []).some((execution) => execution.status === 'failed')
            if (!hasFailed) {
              throw new Error('taskflow: retry requires at least one failed issue')
            }
            const executions = (current.executions ?? []).map((execution) => (
              execution.status === 'failed' ? { ...execution, status: 'pending' as const } : execution
            ))
            if (current.status === 'FAILED') {
              assertTransition(current.status, 'EXECUTING')
              return transitionTo('EXECUTING', 'retry', `command:retry:${runId}:${current.transitions.length}`, {
                control: { ...control, retryCount: control.retryCount + 1 },
                executions,
                events: append('run.updated', { summary: 'retry' }),
              })
            }
            const next: RunAggregate = {
              ...current,
              control: { ...control, retryCount: control.retryCount + 1 },
              executions,
              events: append('run.updated', { summary: 'retry' }),
              updatedAt: now,
            }
            runAggregateSchema.parse(next)
            return next
          }
        }
      })
      this.notify()
      if ((action === 'resume' || action === 'release') && updated.status === 'EXECUTING' && this.automationEnabled && this.executor !== undefined && this.isRunAutomationEnabled(updated)) {
        void this.startExecution(runId).catch(() => undefined)
      }
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

  /** Delete a run from the ledger and board. Only allowed when the run has no
   * active execution (PLANNING/EXECUTING are rejected to avoid deleting a
   * running workflow). */
  async deleteRun(runId: string): Promise<{ ok: true }> {
    const run = this.repository.getRun(runId)
    if (run === undefined) {
      throw new Error(`taskflow: unknown run ${runId}`)
    }
    if (run.status === 'PLANNING' || run.status === 'EXECUTING' || run.status === 'INTEGRATION_REVIEW') {
      throw new Error(`taskflow: cannot delete run ${runId} in status ${run.status}; cancel or wait for it to stop first`)
    }
    await this.repository.deleteRun(runId)
    this.notify()
    return { ok: true }
  }


  /**
   * Apply the final human acceptance decision to an AWAITING_HUMAN run.
   * `accept` moves the run to the terminal ACCEPTED state; `rework` moves it
   * back to PLANNING and clears the previous executions, review, and base SHA
   * so a fresh plan can replace the issue set without stale state leaking into
   * the next cycle. The transition check runs inside the repository's atomic
   * update.
   */
  async decideHuman(runId: string, decision: HumanDecision, actor = 'human'): Promise<HumanDecisionResult> {
    if (decision !== 'accept' && decision !== 'rework') {
      return { ok: false, error: `taskflow: unsupported human decision '${String(decision)}'` }
    }
    const existingRun = this.repository.getRun(runId)
    if (existingRun === undefined) {
      return { ok: false, error: `taskflow: unknown run ${runId}` }
    }
    try {
      const updated = await this.repository.updateRun(runId, (current) => {
        const to: RunStatus = decision === 'accept' ? 'ACCEPTED' : 'PLANNING'
        assertTransition(current.status, to)
        const seq = current.transitions.length
        const transition: RunTransition = {
          seq,
          from: current.status,
          to,
          reason: decision === 'accept' ? 'human-accepted' : 'human-rework',
          actor,
          idempotencyKey: `human:${decision}:${runId}:${seq}`,
          at: this.now(),
        }
        const next: RunAggregate = {
          ...current,
          ...(decision === 'rework'
            ? {
                executions: [],
                review: undefined,
                baseSha: undefined,
                runGit: undefined,
                control: this.defaultControl(),
              }
            : {}),
          status: to,
          updatedAt: transition.at,
          events: this.appendEvent(current.events ?? [], runId, 'human.decision', { summary: decision }),
          transitions: [...current.transitions, transition],
        }
        runAggregateSchema.parse(next)
        return next
      })
      this.notify()
      if (decision === 'rework' && existingRun.repoRoot !== undefined && existingRun.runGit?.integrationBranch !== undefined) {
        // Drop the previous run-scoped integration branch so the next cycle
        // starts from a clean baseline instead of reusing stale commits.
        await this.worktrees.removeIntegrationBranch(
          existingRun.repoRoot,
          existingRun.runGit.integrationBranch,
        ).catch(() => undefined)
      }
      if (this.automationEnabled && this.autoPlan && decision === 'rework' && updated.status === 'PLANNING' && this.isRunAutomationEnabled(updated)) {
        void this.plan(runId).catch(() => undefined)
      }
      return { ok: true, runId, status: updated.status }
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

  /** Subscribe to durable whitelisted taskflow events (P8.3 SSE). The
   * listener receives only events appended after subscription; callers that
   * need an initial replay (e.g. the SSE route) read the run snapshots first.
   * Returns the unsubscribe disposer. */
  subscribeEvents(listener: (event: TaskFlowEvent) => void): () => void {
    const subscription = {
      listener,
      seen: new Map<string, number>(),
    }
    for (const run of this.repository.listRuns()) {
      const events = run.events ?? []
      const last = events.at(-1)
      if (last !== undefined) subscription.seen.set(run.id, last.seq)
    }
    this.eventSubscriptions.add(subscription)
    return () => { this.eventSubscriptions.delete(subscription) }
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
    // A `human-rework` transition invalidates every earlier `plan:done`
    // marker: after the human sends a run back to PLANNING, the same
    // title/description must be allowed to invoke the planner again instead of
    // being treated as already-planned.
    const lastReworkSeq = run.transitions
      .filter((t) => t.reason === 'human-rework')
      .reduce((max, t) => Math.max(max, t.seq), -1)
    const hasPlanDone = run.transitions.some((t) =>
      t.idempotencyKey === `plan:done:${inputHash}` && t.seq > lastReworkSeq
    )
    if (hasPlanDone) {
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
              runGit: { integrationBranch: this.runIntegrationBranch(runId) },
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
        attemptId: execution.attemptId,
        phase: execution.phase,
        heartbeatAt: execution.heartbeatAt,
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
      // Persist a merge-in-progress marker before touching Git so a concurrent
      // cancel cannot interleave between the Git side effects and the ledger
      // update. The marker is cleared in the final report update below.
      try {
        await this.repository.updateRun(runId, (current) => {
          const currentRunning = current.executions?.find((execution) => execution.status === 'running' && execution.key === issueKey)
          if (current.status !== 'EXECUTING' || currentRunning === undefined) {
            throw new Error(`taskflow: issue '${issueKey}' is not currently running`)
          }
          if (current.merging === true) {
            throw new Error('taskflow: merge already in progress')
          }
          const next: RunAggregate = { ...current, merging: true, updatedAt: this.now() }
          runAggregateSchema.parse(next)
          return next
        })
      } catch (error) {
        const message = (error as Error).message
        if (message.startsWith('taskflow:')) {
          return { ok: false, error: message }
        }
        throw error
      }
      try {
        // Ensure uncommitted worktree edits are on the issue branch before the
        // integration merge; otherwise merge would be a no-op and cleanup would
        // silently discard the executor's work.
        await this.worktrees.commitWorktreeEdits(workDir, `taskflow ${runId} ${issueKey}`)
        await this.withMergeLock(repoRoot, () => this.worktrees.mergeIssueWorktree(
          repoRoot,
          branch,
          `taskflow ${runId} ${issueKey}`,
          run.runGit?.integrationBranch ?? this.integrationBranch,
          run.baseSha,
        ))
      } catch (error) {
        effectiveResult = { ok: false, error: `worktree merge failed: ${(error as Error).message}` }
        // Best-effort clear the marker so a transient merge failure can retry.
        await this.repository.updateRun(runId, (current) => {
          if (current.merging !== true) return current
          const next: RunAggregate = { ...current, merging: false, updatedAt: this.now() }
          runAggregateSchema.parse(next)
          return next
        }).catch(() => undefined)
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
              attemptId: currentRunning.attemptId,
              phase: 'done',
              heartbeatAt: currentRunning.heartbeatAt,
            }
          : {
              key: issueKey,
              status: 'failed',
              startedAt: currentRunning.startedAt,
              finishedAt: now,
              error: effectiveResult.error,
              workDir: currentRunning.workDir,
              branch: currentRunning.branch,
              attemptId: currentRunning.attemptId,
              phase: 'failed',
              heartbeatAt: currentRunning.heartbeatAt,
            }
        const executionsNext = [
          ...currentExecutions.filter((execution) => execution.key !== issueKey),
          finished,
        ]
        if (!effectiveResult.ok) {
          assertTransition(current.status, 'FAILED')
          return this.withTransition(current, 'FAILED', `execution-failed: ${issueKey}: ${effectiveResult.error}`, `exec:fail:${runId}`, {
            executions: executionsNext,
            merging: false,
            events: this.appendEvent(current.events ?? [], runId, 'issue.failed', { issueKey, summary: effectiveResult.error }),
          })
        }
        const doneKeys = new Set(executionsNext.filter((execution) => execution.status === 'done').map((execution) => execution.key))
        const allDone = current.issues.every((issue) => doneKeys.has(issue.key))
        if (allDone) {
          assertTransition(current.status, 'INTEGRATION_REVIEW')
          return this.withTransition(current, 'INTEGRATION_REVIEW', 'execution-completed', `exec:done:${runId}`, {
            executions: executionsNext,
            merging: false,
            events: this.appendEvent(current.events ?? [], runId, 'issue.finished', { issueKey, summary: effectiveResult.summary }),
          })
        }
        const next: RunAggregate = {
          ...current,
          merging: false,
          updatedAt: now,
          executions: executionsNext,
          events: this.appendEvent(current.events ?? [], runId, 'issue.finished', { issueKey, summary: effectiveResult.summary }),
        }
        runAggregateSchema.parse(next)
        return next
      })
      this.notify()
      const runAfter = this.repository.getRun(runId)
      if (effectiveResult.ok && this.automationEnabled && this.autoReview && runAfter?.status === 'INTEGRATION_REVIEW' && this.isRunAutomationEnabled(runAfter)) {
        void this.startReview(runId).catch(() => undefined)
      }
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
      if (run.status !== 'EXECUTING') continue
      const automatic = this.automationEnabled && this.executor !== undefined && this.isRunAutomationEnabled(run)
      const manualResume = !this.automationEnabled || this.executor === undefined
      if (!automatic && !manualResume) continue
      void this.resetStuckExecutions(run.id)
        .then(() => {
          if (automatic || manualResume) return this.startExecution(run.id)
        })
        .catch(() => undefined)
    }
  }

  /** Resume automatic READY and INTEGRATION_REVIEW flows that were persisted
   * before a host restart. Only run-level automatic runs are touched, so a
   * manually created/legacy run is never auto-taken-over during gray rollout. */
  resumeAutomation(): void {
    for (const run of this.repository.listRuns()) {
      if (!this.automationEnabled || this.executor === undefined || !this.isRunAutomationEnabled(run)) continue
      if (run.status === 'READY') {
        if (this.requireExecutionPermission) {
          void this.transitionTo(run.id, 'WAITING_PERMISSION', 'waiting-permission', `permission:resume:${run.id}`).catch(() => undefined)
        } else {
          void this.startExecution(run.id).catch(() => undefined)
        }
      } else if (run.status === 'INTEGRATION_REVIEW' && this.autoReview) {
        void this.startReview(run.id).catch(() => undefined)
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
          ? { ...existing, status: 'running', startedAt: existing.startedAt ?? this.now(), attemptId: `attempt-${candidate.key}-${this.now()}` }
          : { key: candidate.key, status: 'running', startedAt: this.now(), attemptId: `attempt-${candidate.key}-${this.now()}` }
        const index = nextExecutions.findIndex((execution) => execution.key === candidate.key)
        if (index >= 0) nextExecutions[index] = running
        else nextExecutions.push(running)
      }
      let events = current.events ?? []
      for (const claim of claimed) {
        events = this.appendEvent(events, runId, 'issue.started', { issueKey: claim.key })
      }
      const next: RunAggregate = {
        ...current,
        updatedAt: this.now(),
        executions: nextExecutions,
        events,
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
        const worktree = await this.worktrees.createIssueWorktree(
          run.repoRoot,
          runId,
          claim.key,
          run.runGit?.integrationBranch ?? this.integrationBranch,
          run.baseSha,
        )
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
      if ((current.executions ?? []).every((execution) => execution.status !== 'running') && current.merging !== true) return current
      const next: RunAggregate = {
        ...current,
        merging: false,
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
          result = await this.executeClaim(runId, claim, repoRoot)
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

  /** Execute one claimed issue through the configured executor. Supports both
   * the legacy `Executor` (agent/DSH fake) and the P8.2 `AutomatedExecutor`
   * contract. For automated executors, persists an attempt id, wires progress
   * callbacks to the run event log, and protects against stale results. */
  private async executeClaim(
    runId: string,
    claim: { key: string; issue: PlannedIssue; workDir?: string; branch?: string },
    repoRoot: string,
  ): Promise<ExecutionResult> {
    const executor = this.executor
    if (executor === undefined) {
      return { ok: false, error: 'taskflow: no executor configured' }
    }
    const workDir = claim.workDir ?? join(defaultPlanRoot(), runId, claim.issue.key)
    const persisted = this.repository.getRun(runId)
      ?.executions?.find((execution) => execution.key === claim.key)
    const attemptId = persisted?.attemptId ?? `attempt-${claim.key}-${this.now()}`
    // Persist the attempt id before invoking the executor so runDetail can
    // expose it to the human intervention window while the issue is running.
    await this.repository.updateRun(runId, (current) => {
      const executions = (current.executions ?? []).map((execution) => (
        execution.key === claim.key ? { ...execution, attemptId } : execution
      ))
      const next: RunAggregate = { ...current, updatedAt: this.now(), executions }
      runAggregateSchema.parse(next)
      return next
    }).catch(() => undefined)

    const controller = new AbortController()
    this.registerActiveExecution(runId, controller)
    const currentRun = this.repository.getRun(runId)
    const reviewFindings = currentRun?.review?.findings?.filter((finding) => finding.issueKey === claim.key)
    const input: AutomatedExecutionInput = {
      runId,
      issue: claim.issue,
      repoRoot,
      workDir,
      attemptId,
      reviewFindings,
      signal: controller.signal,
      onProgress: (event) => {
        void this.recordProgress(runId, claim.key, {
          attemptId,
          phase: event.phase,
          summary: event.summary,
          at: event.at,
        })
      },
    }
    try {
      const raw = await this.withExecutorSlot(() => executor.execute(input as never))
      if (this.isAutomatedResult(raw) && raw.attemptId !== attemptId) {
        return { ok: false, error: `stale executor result for ${claim.key}: expected ${attemptId}, got ${raw.attemptId}` }
      }
      return this.normalizeExecutorResult(raw)
    } finally {
      this.unregisterActiveExecution(runId, controller)
    }
  }

  private isAutomatedResult(result: ExecutionResult | AutomatedExecutionResult): result is AutomatedExecutionResult {
    return typeof (result as AutomatedExecutionResult).attemptId === 'string'
  }

  private normalizeExecutorResult(result: ExecutionResult | AutomatedExecutionResult): ExecutionResult {
    if (typeof result !== 'object' || result === null || typeof (result as { ok?: unknown }).ok !== 'boolean') {
      return { ok: false, error: 'executor returned an invalid result' }
    }
    if (result.ok) {
      if (this.isAutomatedResult(result)) {
        return { ok: true, summary: result.summary }
      }
      return result
    }
    if (this.isAutomatedResult(result)) {
      const blocker = result.blocker !== undefined && result.blocker !== '' ? `: ${result.blocker}` : ''
      return { ok: false, error: `${result.error}${blocker}` }
    }
    return result
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
      await this.repository.updateRun(runId, (current) => {
        const next: RunAggregate = {
          ...current,
          updatedAt: this.now(),
          events: this.appendEvent(current.events ?? [], runId, 'review.started'),
        }
        runAggregateSchema.parse(next)
        return next
      })
      const integrationBranch = run.runGit?.integrationBranch ?? this.integrationBranch
      const integrationHeadSha = run.baseSha === undefined
        ? undefined
        : await this.worktrees.getBranchHeadSha(run.repoRoot, integrationBranch)
      const raw = await this.reviewer.review({
        runId,
        title: run.title,
        description: run.description,
        repoRoot: run.repoRoot,
        issues: run.issues,
        executions: run.executions ?? [],
        workDir: join(defaultPlanRoot(), runId),
        baseSha: run.baseSha,
        integrationBranch,
        integrationHeadSha,
      })
      const result = this.normalizeReviewResult(run, raw)
      if (result.verdict === 'PASS') {
        await this.repository.updateRun(runId, (current) => {
          assertTransition(current.status, 'AWAITING_HUMAN')
          return this.withTransition(current, 'AWAITING_HUMAN', 'review-passed', `review:pass:${runId}`, {
            review: { verdict: 'PASS', summary: result.summary, reworkKeys: [], findings: result.findings === undefined ? undefined : result.findings.map((finding) => ({ ...finding, evidenceNeeded: [...finding.evidenceNeeded] })), evidenceChecklist: result.evidenceChecklist === undefined ? undefined : [...result.evidenceChecklist], at: this.now() },
            events: this.appendEvent(current.events ?? [], runId, 'review.finished', { summary: 'PASS' }),
          })
        })
        this.notify()
        return
      }
      const reworkKeys = this.reworkClosure(run, result.reworkKeys)
      const reviewCycles = (run.control?.reviewCycles ?? 0) + 1
      const limitReached = reviewCycles >= this.maxReviewCycles
      if (limitReached) {
        await this.repository.updateRun(runId, (current) => {
          assertTransition(current.status, 'WAITING_DECISION')
          return this.withTransition(current, 'WAITING_DECISION', 'review-cycle-limit', `review:limit:${runId}`, {
            executions: this.resetReworkExecutions(current.executions ?? [], reworkKeys),
            review: { verdict: 'REVISE', summary: result.summary, reworkKeys: [...reworkKeys], findings: result.findings === undefined ? undefined : result.findings.map((finding) => ({ ...finding, evidenceNeeded: [...finding.evidenceNeeded] })), evidenceChecklist: result.evidenceChecklist === undefined ? undefined : [...result.evidenceChecklist], at: this.now() },
            control: { ...(current.control ?? this.defaultControl()), reviewCycles },
            events: this.appendEvent(current.events ?? [], runId, 'review.finished', { summary: 'REVISE' }),
          })
        })
        this.notify()
        return
      }
      await this.repository.updateRun(runId, (current) => {
        assertTransition(current.status, 'EXECUTING')
        return this.withTransition(current, 'EXECUTING', 'review-revise', `review:revise:${runId}`, {
          executions: this.resetReworkExecutions(current.executions ?? [], reworkKeys),
          review: { verdict: 'REVISE', summary: result.summary, reworkKeys: [...reworkKeys], findings: result.findings === undefined ? undefined : result.findings.map((finding) => ({ ...finding, evidenceNeeded: [...finding.evidenceNeeded] })), evidenceChecklist: result.evidenceChecklist === undefined ? undefined : [...result.evidenceChecklist], at: this.now() },
          control: { ...(current.control ?? this.defaultControl()), reviewCycles },
          events: this.appendEvent(current.events ?? [], runId, 'review.finished', { summary: 'REVISE' }),
        })
      })
      this.notify()
      const runAfterReview = this.repository.getRun(runId)
      if (this.automationEnabled && this.executor !== undefined && runAfterReview?.status === 'EXECUTING' && this.isRunAutomationEnabled(runAfterReview)) {
        void this.startExecution(runId).catch(() => undefined)
      }
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
    const object = (raw ?? {}) as {
      verdict?: unknown
      summary?: unknown
      reworkKeys?: unknown
      findings?: unknown
      evidenceChecklist?: unknown
    }
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
    const findings = Array.isArray(object.findings)
      ? object.findings
          .filter((item): item is { issueKey: string; problem: string; evidenceNeeded: string[]; acceptance: string } =>
            typeof item === 'object' && item !== null
            && typeof (item as { issueKey?: unknown }).issueKey === 'string'
            && typeof (item as { problem?: unknown }).problem === 'string'
            && Array.isArray((item as { evidenceNeeded?: unknown }).evidenceNeeded)
            && typeof (item as { acceptance?: unknown }).acceptance === 'string')
          .map((item) => ({
            issueKey: item.issueKey,
            problem: item.problem,
            evidenceNeeded: item.evidenceNeeded.filter((value): value is string => typeof value === 'string'),
            acceptance: item.acceptance,
          }))
      : undefined
    const evidenceChecklist = Array.isArray(object.evidenceChecklist)
      ? object.evidenceChecklist.filter((item): item is string => typeof item === 'string')
      : findings !== undefined
        ? [...new Set(findings.flatMap((finding) => finding.evidenceNeeded))]
        : undefined
    return { verdict: object.verdict, summary: object.summary, reworkKeys, findings, evidenceChecklist }
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
      const normalizedIssues = this.normalizePlannedIssues(verdict.issues)
      await this.repository.updateRun(runId, (current) => {
        assertTransition(current.status, 'READY')
        return this.withTransition(current, 'READY', 'planning-succeeded', `plan:done:${inputHash}`, {
          issueCount: normalizedIssues.length,
          issues: normalizedIssues,
        })
      })
      this.notify()
      const runAfterPlan = this.repository.getRun(runId)
      if (this.automationEnabled && this.executor !== undefined && runAfterPlan?.status === 'READY' && this.isRunAutomationEnabled(runAfterPlan)) {
        if (this.requireExecutionPermission) {
          await this.transitionTo(runId, 'WAITING_PERMISSION', 'waiting-permission', `permission:wait:${runId}`)
        } else {
          void this.startExecution(runId).catch(() => undefined)
        }
      }
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

  /** P8.1/P8.5: allowed actions for the current run state (control actions
   * plus P7 human decisions when the run is awaiting human acceptance). */
  private allowedActions(run: RunAggregate): string[] {
    if (isTerminal(run.status)) return []
    const allowed = new Set<string>()
    switch (run.status) {
      case 'RECEIVED':
      case 'PLANNING':
      case 'READY':
      case 'INTEGRATION_REVIEW':
        allowed.add('cancel')
        break
      case 'AWAITING_HUMAN':
        allowed.add('accept')
        allowed.add('rework')
        allowed.add('cancel')
        break
      case 'WAITING_DECISION':
        allowed.add('resume')
        allowed.add('cancel')
        break
      case 'EXECUTING':
        allowed.add('pause')
        allowed.add('cancel')
        allowed.add('takeover')
        if ((run.executions ?? []).some((execution) => execution.status === 'failed')) {
          allowed.add('retry')
        }
        break
      case 'PAUSED':
        allowed.add('resume')
        allowed.add('cancel')
        allowed.add('takeover')
        break
      case 'WAITING_PERMISSION':
        allowed.add('release')
        allowed.add('cancel')
        break
      case 'FAILED':
        if ((run.executions ?? []).some((execution) => execution.status === 'failed')) {
          allowed.add('retry')
        }
        break
    }
    return Array.from(allowed)
  }

  /** P8.5: only run-level automatic runs may be picked up by the global
   * automated coordinator. Old records missing control metadata fail closed. */
  private isRunAutomationEnabled(run: RunAggregate): boolean {
    return run.control?.automation.enabled === true
  }

  /** Register an in-flight automated executor so control actions can abort it. */
  private registerActiveExecution(runId: string, controller: AbortController): void {
    let set = this.activeExecutions.get(runId)
    if (set === undefined) {
      set = new Set()
      this.activeExecutions.set(runId, set)
    }
    set.add(controller)
  }

  private unregisterActiveExecution(runId: string, controller: AbortController): void {
    const set = this.activeExecutions.get(runId)
    set?.delete(controller)
    if (set?.size === 0) this.activeExecutions.delete(runId)
  }

  /** Abort every in-flight automated executor for one run. */
  private abortRunExecutions(runId: string): void {
    const set = this.activeExecutions.get(runId)
    if (set === undefined) return
    for (const controller of set) controller.abort()
  }

  /** Global semaphore enforcing `maxExecutorProcesses` across all runs. */
  private async withExecutorSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.executorActive >= this.maxExecutorProcesses) {
      await new Promise<void>((resolvePromise) => {
        this.executorWaiters.push(resolvePromise)
      })
    }
    this.executorActive += 1
    try {
      return await fn()
    } finally {
      this.executorActive -= 1
      const next = this.executorWaiters.shift()
      next?.()
    }
  }

  private defaultControl(): RunControl {
    return {
      automation: { enabled: this.automationEnabled, mode: this.automationMode },
      paused: false,
      takenOver: false,
      retryCount: 0,
    }
  }

  /** Append one whitelisted event; the log is bounded to the newest 200 events. */
  private appendEvent(
    events: readonly TaskFlowEvent[],
    runId: string,
    kind: TaskFlowEventKind,
    extra: { issueKey?: string; attemptId?: string; phase?: ExecutorPhase; summary?: string } = {},
  ): TaskFlowEvent[] {
    const seq = events.reduce((max, event) => Math.max(max, event.seq), -1) + 1
    const event: TaskFlowEvent = { seq, at: this.now(), runId, kind, ...extra }
    return [...events, event].slice(-200)
  }

  /** P8.1: run-scoped integration branch for Git isolation. */
  private runIntegrationBranch(runId: string): string {
    return `${this.integrationBranch}/${runId}`
  }

  /** Build the next aggregate: append one transition, stamp updatedAt, parse-before-persist. */
  private withTransition(
    current: RunAggregate,
    to: RunStatus,
    reason: string,
    idempotencyKey: string,
    patch: Partial<Pick<RunAggregate, 'issueCount' | 'issues' | 'executions' | 'review' | 'baseSha' | 'merging' | 'control' | 'runGit' | 'events'>> = {},
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
    const baseEvents = patch.events ?? current.events ?? []
    const next: RunAggregate = {
      ...current,
      ...patch,
      status: to,
      updatedAt: transition.at,
      events: this.appendEvent(baseEvents, current.id, 'run.updated', { summary: reason }),
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

  /** Normalize planner-issued keys into globally unique, monotonically
   * increasing Issue keys (`issue-NNN`). The original planner key is kept as
   * `taskId` when it looks like a project-local task ID, so task IDs can reset
   * per project while Issue keys stay unique across the whole ledger. */
  private normalizePlannedIssues(issues: readonly PlannedIssue[]): PlannedIssue[] {
    let max = 0
    for (const run of this.repository.listRuns()) {
      for (const issue of run.issues) {
        const match = /^issue-(\d+)$/.exec(issue.key)
        if (match !== null) {
          max = Math.max(max, Number(match[1]))
        }
      }
    }
    const oldToNew = new Map<string, string>()
    const normalized: PlannedIssue[] = []
    for (const issue of issues) {
      max += 1
      const newKey = `issue-${String(max).padStart(3, '0')}`
      oldToNew.set(issue.key, newKey)
      const taskId = issue.taskId !== undefined && issue.taskId !== ''
        ? issue.taskId
        : /^issue-\d+$/.test(issue.key)
          ? undefined
          : issue.key
      normalized.push({
        key: newKey,
        ...(taskId !== undefined ? { taskId } : {}),
        acceptance: issue.acceptance,
        deps: (issue.deps ?? []).map((dep) => oldToNew.get(dep) ?? dep),
        risk: issue.risk ?? null,
      })
    }
    return normalized
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
    for (const run of this.repository.listRuns()) {
      for (const event of run.events ?? []) this.emitEvent(event)
    }
  }

  private emitEvent(event: TaskFlowEvent): void {
    for (const subscription of [...this.eventSubscriptions]) {
      const lastSeq = subscription.seen.get(event.runId) ?? -1
      if (event.seq > lastSeq) {
        subscription.seen.set(event.runId, event.seq)
        subscription.listener(event)
      }
    }
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
        ...(issue.taskId !== undefined ? { taskId: issue.taskId } : {}),
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
        findings: run.review.findings === undefined ? undefined : run.review.findings.map((finding) => ({ ...finding, evidenceNeeded: [...finding.evidenceNeeded] })),
        evidenceChecklist: run.review.evidenceChecklist === undefined ? undefined : [...run.review.evidenceChecklist],
        at: run.review.at,
      },
      baseSha: run.baseSha,
      control: run.control,
      runGit: run.runGit,
      events: run.events ?? [],
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
