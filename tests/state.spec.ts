/**
 * State machine tests: exhaustive assertion of the legal-transition table,
 * terminal statuses, and the guard's stable error contract.
 */

import { describe, expect, it } from 'vitest'
import {
  RUN_STATUSES,
  RUN_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
  type RunStatus,
} from '../src/state.ts'

describe('RUN_TRANSITIONS', () => {
  it('has an entry for every status and only references known statuses', () => {
    for (const from of RUN_STATUSES) {
      const targets = RUN_TRANSITIONS[from]
      expect(Array.isArray(targets)).toBe(true)
      for (const to of targets) {
        expect(RUN_STATUSES).toContain(to)
      }
    }
  })

  it('exhaustively matches canTransition against the declared table', () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canTransition(from, to)).toBe(RUN_TRANSITIONS[from].includes(to))
      }
    }
  })

  it('allows the main path RECEIVED → PLANNING → READY → EXECUTING → INTEGRATION_REVIEW → AWAITING_HUMAN → ACCEPTED', () => {
    const path: RunStatus[] = ['RECEIVED', 'PLANNING', 'READY', 'EXECUTING', 'INTEGRATION_REVIEW', 'AWAITING_HUMAN', 'ACCEPTED']
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1])).toBe(true)
    }
  })

  it('allows rework INTEGRATION_REVIEW → EXECUTING and rejection AWAITING_HUMAN → PLANNING', () => {
    expect(canTransition('INTEGRATION_REVIEW', 'EXECUTING')).toBe(true)
    expect(canTransition('AWAITING_HUMAN', 'PLANNING')).toBe(true)
  })

  it('allows waiting and pause states only from active states', () => {
    expect(canTransition('EXECUTING', 'WAITING_PERMISSION')).toBe(true)
    expect(canTransition('EXECUTING', 'WAITING_DECISION')).toBe(true)
    expect(canTransition('EXECUTING', 'PAUSED')).toBe(true)
    expect(canTransition('WAITING_PERMISSION', 'EXECUTING')).toBe(true)
    expect(canTransition('PAUSED', 'EXECUTING')).toBe(true)
    expect(canTransition('ACCEPTED', 'PAUSED')).toBe(false)
    expect(canTransition('CANCELLED', 'READY')).toBe(false)
  })

  it('terminal statuses accept no outgoing transitions', () => {
    for (const terminal of ['ACCEPTED', 'CANCELLED', 'FAILED'] as const) {
      expect(RUN_TRANSITIONS[terminal]).toEqual([])
    }
  })
})

describe('isTerminal', () => {
  it('marks ACCEPTED, CANCELLED, FAILED terminal and everything else live', () => {
    for (const status of RUN_STATUSES) {
      expect(isTerminal(status)).toBe(status === 'ACCEPTED' || status === 'CANCELLED' || status === 'FAILED')
    }
  })
})

describe('assertTransition', () => {
  it('accepts legal transitions and throws a stable error on illegal ones', () => {
    expect(() => assertTransition('RECEIVED', 'PLANNING')).not.toThrow()
    expect(() => assertTransition('ACCEPTED', 'READY')).toThrow('taskflow: illegal transition ACCEPTED → READY')
    expect(() => assertTransition('READY', 'ACCEPTED')).toThrow('taskflow: illegal transition READY → ACCEPTED')
  })
})
