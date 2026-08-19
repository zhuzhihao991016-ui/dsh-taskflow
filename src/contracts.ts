/**
 * P8 contract freeze: types and constants for the automated executor,
 * control actions, event stream, run detail response, and automation config.
 *
 * These are the stable contracts that P8.1+ will implement against. They are
 * intentionally additive: existing P0-P7 manual/agent-driven paths remain
 * unchanged, and automation is enabled by default from P8.6; explicit `automationEnabled=false`
 * restores manual/agent-driven mode.
 */

import type { ExecutionInput, ExecutionResult } from './executor.ts'
import type { RunStatus } from './state.ts'

/** Coarse phase of one automated Issue execution. */
export const EXECUTOR_PHASES = [
  'preparing',
  'running',
  'merging',
  'reporting',
  'blocked',
  'done',
  'failed',
] as const

export type ExecutorPhase = (typeof EXECUTOR_PHASES)[number]

/** Whitelisted progress event emitted by an automated executor. */
export interface ExecutorProgressEvent {
  phase: ExecutorPhase
  /** Short human-readable progress text; never raw logs. */
  summary?: string
  /** Optional structured detail, already truncated/whitelisted by the executor. */
  detail?: string
  at: number
}

/** Input passed to an automated executor for one Issue attempt. */
export interface AutomatedExecutionInput extends ExecutionInput {
  /** Monotonic attempt id for this Issue execution. */
  attemptId: string
  /** Abort signal used by the host to cancel/stop the attempt. */
  signal?: AbortSignal
  /** Progress callback; the executor must keep payloads small and whitelisted. */
  onProgress?: (event: ExecutorProgressEvent) => void
}

/** Result returned by an automated executor; carries attemptId for stale-report protection. */
export type AutomatedExecutionResult =
  | {
      ok: true
      summary: string
      attemptId: string
      phase?: Extract<ExecutorPhase, 'done'>
      changedFiles?: string[]
    }
  | {
      ok: false
      error: string
      attemptId: string
      phase?: Extract<ExecutorPhase, 'failed' | 'blocked'>
      blocker?: string
    }

/** Automated executor contract; production implementation is CodexIssueExecutor (P8.2). */
export interface AutomatedExecutor {
  execute(input: AutomatedExecutionInput): Promise<AutomatedExecutionResult>
}

/** Control actions exposed to the human intervention window. */
export const AUTOMATION_CONTROL_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'takeover',
  'release',
  'retry',
] as const

export type AutomationControlAction = (typeof AUTOMATION_CONTROL_ACTIONS)[number]

/** Whitelisted event kinds for the browser console / SSE stream. */
export const TASKFLOW_EVENT_KINDS = [
  'run.updated',
  'issue.started',
  'issue.progress',
  'issue.finished',
  'issue.failed',
  'review.started',
  'review.finished',
  'human.decision',
  'automation.paused',
  'automation.resumed',
] as const

export type TaskFlowEventKind = (typeof TASKFLOW_EVENT_KINDS)[number]

/** One whitelisted taskflow event; never contains raw command output/secrets. */
export interface TaskFlowEvent {
  seq: number
  at: number
  runId: string
  kind: TaskFlowEventKind
  issueKey?: string
  attemptId?: string
  phase?: ExecutorPhase
  summary?: string
}

/** P8 run-detail response returned by the `/run` endpoint. `allowedActions`
 * contains both automation control actions and P7 human decisions
 * (`accept`/`rework`) so the browser console can render the full
 * intervention window from one source of truth. */
export interface RunDetailResponse {
  runId: string
  status: RunStatus
  automation: {
    enabled: boolean
    mode: 'manual' | 'automatic'
  }
  currentIssue?: {
    key: string
    attemptId?: string
    phase?: ExecutorPhase
    workDir?: string
    branch?: string
    heartbeatAt?: number
  }
  allowedActions: string[]
  recentEvents: TaskFlowEvent[]
}

/** P8 automation configuration contract. */
export interface AutomationConfig {
  enabled: boolean
  autoPlan: boolean
  autoReview: boolean
  maxExecutorProcesses: number
  maxReviewCycles: number
  /** P8.4: when true, automatic execution waits in WAITING_PERMISSION until a human releases it. */
  requireExecutionPermission: boolean
}

/** P8 default automation configuration; automation is on from P8.6 onward. */
export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  enabled: true,
  autoPlan: true,
  autoReview: true,
  maxExecutorProcesses: 2,
  maxReviewCycles: 3,
  requireExecutionPermission: false,
}

/** Re-export the base executor result for contract consumers. */
export type { ExecutionResult }
