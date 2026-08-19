/**
 * The taskflow storage-domain declaration: one `runs` table of Run
 * aggregates. Each aggregate carries its append-only transition list, so one
 * row write commits a transition atomically (the domain write chain persists
 * first, then updates memory). Backend routing is the profile's
 * storage-domain config (`backend: json` by default; SQLite via `routes`).
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { ISSUE_KEY_PATTERN } from './dag.ts'
import type { PlannedIssue } from './dag.ts'
import { EXECUTOR_PHASES, TASKFLOW_EVENT_KINDS, type ExecutorPhase, type TaskFlowEvent } from './contracts.ts'
import { RUN_STATUSES, canTransition, type RunStatus } from './state.ts'

/** One recorded transition inside a run aggregate. */
export interface RunTransition {
  /** Monotonic per-run sequence; the first transition is seq 0 (creation). */
  seq: number
  from: RunStatus
  to: RunStatus
  reason: string
  actor: string
  /** Idempotency key of the operation that produced this transition. */
  idempotencyKey: string
  at: number
}

/** The durable run aggregate: state plus its full transition history. */
export interface RunAggregate {
  id: string
  status: RunStatus
  title: string
  description: string
  /** Repo root the planner/executor work in; required for planning. */
  repoRoot?: string
  createdAt: number
  updatedAt: number
  issueCount: number
  /** Validated planned issues (P2); empty until a plan succeeds. */
  issues: PlannedIssue[]
  /** Per-issue execution state (P3); empty until execution starts. Exactly
   * one entry is `running` at a time (serial runner); `done`/`failed` are
   * terminal per issue. */
  executions: IssueExecution[]
  /** Latest Codex review record (P4); absent until a review completes. */
  review?: RunReview
  /** P5: base commit SHA captured when execution starts; used by the reviewer
   * to inspect the integration-branch diff instead of uncommitted changes. */
  baseSha?: string
  /** P5: true while a success report is committing/merging Git side effects. */
  merging?: boolean
  /** P8.1: durable automation/control metadata. */
  control?: RunControl
  /** P8.1: run-scoped Git isolation metadata. */
  runGit?: RunGitIsolation
  /** P8.1: whitelisted event log (bounded, newest last). */
  events?: TaskFlowEvent[]
  /** Append-only; `transitions[transitions.length - 1].to` equals `status`. */
  transitions: RunTransition[]
}

/** P8.1 persistent automation/control state for one run. */
export interface RunControl {
  automation: {
    enabled: boolean
    mode: 'manual' | 'automatic'
  }
  paused: boolean
  takenOver: boolean
  retryCount: number
}

/** P8.1 run-scoped Git isolation metadata. */
export interface RunGitIsolation {
  /** Run-specific integration branch; issue worktrees merge here. */
  integrationBranch: string
  /** Optional run-level worktree path (reserved for run-level isolation). */
  workDir?: string
  /** Optional run-level branch name (reserved for run-level isolation). */
  branch?: string
}


/** One issue's execution state inside a run. */
export interface IssueExecution {
  key: string
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt?: number
  finishedAt?: number
  /** Executor's human-readable result when done. */
  summary?: string
  /** Failure message when failed. */
  error?: string
  /** P5: isolated worktree path when this issue runs in a worktree. */
  workDir?: string
  /** P5: per-issue branch created for the worktree. */
  branch?: string
  /** P8.1: monotonic automated-executor attempt id for this issue. */
  attemptId?: string
  /** P8.1: coarse automated-executor phase (persisted progress). */
  phase?: ExecutorPhase
  /** P8.1: last progress heartbeat timestamp. */
  heartbeatAt?: number
}

/** P4 review verdict. */
export type ReviewVerdict = 'PASS' | 'REVISE'

/** The latest Codex review record persisted on a run. */
export interface RunReview {
  verdict: ReviewVerdict
  summary: string
  /** Issue keys selected for rework; empty means all issues. */
  reworkKeys: string[]
  at: number
}

const transitionSchema = z.object({
  seq: z.number().int().min(0),
  from: z.enum(RUN_STATUSES),
  to: z.enum(RUN_STATUSES),
  reason: z.string(),
  actor: z.string(),
  idempotencyKey: z.string(),
  at: z.number(),
})

const plannedIssueSchema = z.object({
  key: z.string().min(1).regex(ISSUE_KEY_PATTERN, 'unsafe issue key'),
  acceptance: z.string().min(1),
  deps: z.array(z.string()).default([]),
  // The planner schema models optional risk as nullable (strict outputs).
  risk: z.enum(['L1', 'L2', 'L3']).nullable().optional(),
})

const issueExecutionSchema = z.object({
  key: z.string().min(1).regex(ISSUE_KEY_PATTERN, 'unsafe issue key'),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  workDir: z.string().optional(),
  branch: z.string().optional(),
  attemptId: z.string().optional(),
  phase: z.enum(EXECUTOR_PHASES).optional(),
  heartbeatAt: z.number().optional(),
})

const reviewSchema = z.object({
  verdict: z.enum(['PASS', 'REVISE']),
  summary: z.string(),
  reworkKeys: z.array(z.string()).default([]),
  at: z.number(),
})

const taskFlowEventSchema = z.object({
  seq: z.number().int().min(0),
  at: z.number(),
  runId: z.string(),
  kind: z.enum(TASKFLOW_EVENT_KINDS),
  issueKey: z.string().optional(),
  attemptId: z.string().optional(),
  phase: z.enum(EXECUTOR_PHASES).optional(),
  summary: z.string().optional(),
})

const runControlSchema = z.object({
  automation: z.object({
    enabled: z.boolean(),
    mode: z.enum(['manual', 'automatic']),
  }),
  paused: z.boolean(),
  takenOver: z.boolean(),
  retryCount: z.number().int().min(0),
})

const runGitIsolationSchema = z.object({
  integrationBranch: z.string().min(1),
  workDir: z.string().optional(),
  branch: z.string().optional(),
})

const runAggregateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  title: z.string().min(1),
  description: z.string(),
  repoRoot: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  issueCount: z.number().int().min(0),
  issues: z.array(plannedIssueSchema).default([]),
  executions: z.array(issueExecutionSchema).default([]),
  review: reviewSchema.optional(),
  baseSha: z.string().optional(),
  merging: z.boolean().optional(),
  control: runControlSchema.optional(),
  runGit: runGitIsolationSchema.optional(),
  events: z.array(taskFlowEventSchema).default([]),
  transitions: z.array(transitionSchema),
}).superRefine((run, ctx) => {
  // Aggregate history consistency: this runs at every domain open (the
  // integrity boundary), so a structurally valid but inconsistent medium
  // fails closed instead of poisoning the running ledger.
  const transitions = run.transitions
  if (transitions.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'transitions must not be empty' })
    return
  }
  const first = transitions[0]
  if (first.seq !== 0 || first.from !== 'RECEIVED' || first.to !== 'RECEIVED') {
    ctx.addIssue({ code: 'custom', message: 'first transition must be the RECEIVED creation (seq 0)' })
  }
  for (let i = 1; i < transitions.length; i += 1) {
    if (transitions[i].seq !== transitions[i - 1].seq + 1) {
      ctx.addIssue({ code: 'custom', message: `transition seq must be contiguous at index ${i}` })
    }
    if (transitions[i].from !== transitions[i - 1].to) {
      ctx.addIssue({ code: 'custom', message: `transition chain must be continuous at index ${i}` })
    }
    if (!canTransition(transitions[i].from, transitions[i].to)) {
      ctx.addIssue({ code: 'custom', message: `illegal transition ${transitions[i].from} → ${transitions[i].to} at index ${i}` })
    }
  }
  const last = transitions[transitions.length - 1]
  if (last.to !== run.status) {
    ctx.addIssue({ code: 'custom', message: `final transition '${last.to}' must equal run status '${run.status}'` })
  }
  // Execution consistency: one entry per issue, all keys known. Multiple
  // issues may be running concurrently (P5 DAG parallel execution).
  const issueKeys = new Set(run.issues.map((issue) => issue.key))
  const executedKeys = new Set<string>()
  for (const execution of run.executions) {
    if (executedKeys.has(execution.key)) {
      ctx.addIssue({ code: 'custom', message: `duplicate execution for issue '${execution.key}'` })
    }
    executedKeys.add(execution.key)
    if (!issueKeys.has(execution.key)) {
      ctx.addIssue({ code: 'custom', message: `execution references unknown issue '${execution.key}'` })
    }
  }
})

/** The taskflow domain declaration (version 1; a medium stamped otherwise rejects at open). */
export const TASKFLOW_DOMAIN = defineDomain({
  name: 'taskflow',
  version: 1,
  tables: {
    runs: domainTable<string, RunAggregate>(runAggregateSchema),
  },
})

export type TaskFlowDomain = typeof TASKFLOW_DOMAIN

/** Exported for write-path validation in the service (parse before persist). */
export { runAggregateSchema }
