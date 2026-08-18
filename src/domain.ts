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
import { RUN_STATUSES, type RunStatus } from './state.ts'

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
  /** Append-only; `transitions[transitions.length - 1].to` equals `status`. */
  transitions: RunTransition[]
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
})

const reviewSchema = z.object({
  verdict: z.enum(['PASS', 'REVISE']),
  summary: z.string(),
  reworkKeys: z.array(z.string()).default([]),
  at: z.number(),
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
