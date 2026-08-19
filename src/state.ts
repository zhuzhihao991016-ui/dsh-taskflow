/**
 * Pure Run state machine: the legal-transition table and its guards. No I/O,
 * no storage — the service enforces these guards inside the repository's
 * atomic read-modify-write, so a violation can never be persisted.
 */

/** Run lifecycle statuses; the transition table below defines legal moves. */
export const RUN_STATUSES = [
  'RECEIVED',
  'PLANNING',
  'READY',
  'EXECUTING',
  'INTEGRATION_REVIEW',
  'WAITING_PERMISSION',
  'WAITING_DECISION',
  'PAUSED',
  'AWAITING_HUMAN',
  'ACCEPTED',
  'CANCELLED',
  'FAILED',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

/** Terminal statuses: no further transition is legal. */
const TERMINAL: ReadonlySet<RunStatus> = new Set(['ACCEPTED', 'CANCELLED', 'FAILED'])

/**
 * Legal transitions, one entry per source status. The table is the single
 * authority for every `from → to` pair; tests assert it exhaustively.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  RECEIVED: ['PLANNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['READY', 'CANCELLED', 'FAILED'],
  READY: ['EXECUTING', 'CANCELLED', 'FAILED'],
  EXECUTING: ['INTEGRATION_REVIEW', 'WAITING_PERMISSION', 'WAITING_DECISION', 'PAUSED', 'FAILED', 'CANCELLED'],
  INTEGRATION_REVIEW: ['AWAITING_HUMAN', 'EXECUTING', 'WAITING_DECISION', 'FAILED', 'CANCELLED'],
  WAITING_PERMISSION: ['EXECUTING', 'CANCELLED', 'FAILED'],
  WAITING_DECISION: ['READY', 'EXECUTING', 'INTEGRATION_REVIEW', 'CANCELLED', 'FAILED'],
  PAUSED: ['EXECUTING', 'WAITING_PERMISSION', 'CANCELLED', 'FAILED'],
  AWAITING_HUMAN: ['ACCEPTED', 'PLANNING', 'CANCELLED'],
  ACCEPTED: [],
  CANCELLED: [],
  FAILED: [],
}

/** Whether `from → to` is a legal transition. */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

/** Whether `status` is terminal. */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status)
}

/** Throw a stable `taskflow:` error when `from → to` is illegal. */
export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`taskflow: illegal transition ${from} → ${to}`)
  }
}
