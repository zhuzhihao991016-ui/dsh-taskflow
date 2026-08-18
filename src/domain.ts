/**
 * The taskflow storage-domain declaration: one `runs` table of Run
 * aggregates. Each aggregate carries its append-only transition list, so one
 * row write commits a transition atomically (the domain write chain persists
 * first, then updates memory). Backend routing is the profile's
 * storage-domain config (`backend: json` by default; SQLite via `routes`).
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
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
  createdAt: number
  updatedAt: number
  issueCount: number
  /** Append-only; `transitions[transitions.length - 1].to` equals `status`. */
  transitions: RunTransition[]
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

const runAggregateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  title: z.string().min(1),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  issueCount: z.number().int().min(0),
  transitions: z.array(transitionSchema),
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
