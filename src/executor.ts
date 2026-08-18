/**
 * P3 Executor contract: the seam between the serial runner and whoever
 * performs an Issue. The production profile is agent-driven — a DSH session
 * claims the current issue (via /plugins/taskflow/execute) and reports the
 * outcome (via /plugins/taskflow/exec-result) — so the service runs without
 * an executor and exposes exactly one `running` issue at a time. Tests and
 * future automated executors plug in here; the serial runner treats every
 * executor identically (claim → execute → report → next).
 */

import type { PlannedIssue } from './dag.ts'

/** Everything an executor needs to perform one issue. */
export interface ExecutionInput {
  /** Owning run id, e.g. `run-0001`. */
  runId: string
  /** The validated planned issue to perform. */
  issue: PlannedIssue
  /** Repo root the issue work happens in (already allowlisted at planning). */
  repoRoot: string
  /** Spool directory for this issue's artifacts. */
  workDir: string
}

/** One issue execution outcome, as reported back to the runner. */
export type ExecutionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string }

/** Executor contract; the production service leaves this unset (agent-driven). */
export interface Executor {
  execute(input: ExecutionInput): Promise<ExecutionResult>
}
