/**
 * Plan (DAG) validation tests: unique keys, present deps, acyclicity, and
 * non-empty acceptance criteria.
 */

import { describe, expect, it } from 'vitest'
import { validatePlan, type PlannedIssue } from '../src/dag.ts'

const issue = (key: string, deps: string[] = [], acceptance = '验收标准'): PlannedIssue => ({
  key,
  acceptance,
  deps,
})

describe('validatePlan', () => {
  it('accepts a valid plan and returns it', () => {
    const issues = [issue('a'), issue('b', ['a'])]
    const verdict = validatePlan(issues)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.issues).toBe(issues)
  })

  it('accepts a diamond dependency graph', () => {
    const issues = [issue('a'), issue('b', ['a']), issue('c', ['a']), issue('d', ['b', 'c'])]
    expect(validatePlan(issues).ok).toBe(true)
  })

  it('rejects an empty plan', () => {
    expect(validatePlan([])).toMatchObject({ ok: false, error: expect.stringContaining('no issues') })
  })

  it('rejects duplicate and empty keys', () => {
    expect(validatePlan([issue('a'), issue('a')])).toMatchObject({
      ok: false, error: expect.stringContaining('duplicate'),
    })
    expect(validatePlan([issue('')])).toMatchObject({
      ok: false, error: expect.stringContaining('empty issue key'),
    })
  })

  it('rejects empty acceptance criteria', () => {
    expect(validatePlan([issue('a', [], '   ')])).toMatchObject({
      ok: false, error: expect.stringContaining('empty acceptance'),
    })
  })

  it('rejects dependencies on unknown issues', () => {
    expect(validatePlan([issue('a'), issue('b', ['nope'])])).toMatchObject({
      ok: false, error: expect.stringContaining('unknown issue'),
    })
  })

  it('rejects self-dependencies', () => {
    expect(validatePlan([issue('a', ['a'])])).toMatchObject({
      ok: false, error: expect.stringContaining('depends on itself'),
    })
  })

  it('rejects a direct cycle', () => {
    expect(validatePlan([issue('a', ['b']), issue('b', ['a'])])).toMatchObject({
      ok: false, error: expect.stringContaining('cycle'),
    })
  })

  it('rejects an indirect cycle', () => {
    const issues = [issue('a', ['b']), issue('b', ['c']), issue('c', ['a'])]
    const verdict = validatePlan(issues)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/cycle .*→.*→/)
  })

  it('rejects an invalid risk level', () => {
    expect(validatePlan([{ key: 'a', acceptance: 'x', risk: 'L4' as never }])).toMatchObject({
      ok: false, error: expect.stringContaining('invalid risk'),
    })
  })
})
