/**
 * Domain integrity tests for persisted run aggregates: review rework keys and
 * finding issue keys must match ISSUE_KEY_PATTERN and reference currently
 * planned issues, with clear Zod error paths. Runs without a review stay valid.
 */

import { describe, expect, it } from 'vitest'
import type { PlannedIssue } from '../src/dag.ts'
import { runAggregateSchema, type RunAggregate } from '../src/domain.ts'

const issues: PlannedIssue[] = [
  { key: 'issue-001', acceptance: '验收 A' },
  { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'] },
]

function validRun(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    id: 'run-0001',
    status: 'READY',
    title: '任务',
    description: '',
    repoRoot: 'C:/repo',
    createdAt: 1,
    updatedAt: 2,
    issueCount: issues.length,
    issues,
    executions: [],
    transitions: [
      { seq: 0, from: 'RECEIVED', to: 'RECEIVED', reason: 'created', actor: 'host', idempotencyKey: 'create:run-0001', at: 1 },
      { seq: 1, from: 'RECEIVED', to: 'PLANNING', reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:run-0001', at: 1 },
      { seq: 2, from: 'PLANNING', to: 'READY', reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:run-0001', at: 2 },
    ],
    ...overrides,
  }
}

interface ZodIssueView {
  path: string
  message: string
}

function parseIssues(run: RunAggregate): ZodIssueView[] {
  try {
    runAggregateSchema.parse(run)
  } catch (error) {
    const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues
    if (!Array.isArray(issues)) throw new Error(`expected ZodError, got ${String(error)}`)
    return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
  }
  throw new Error('expected run aggregate parse to fail')
}

function expectIssue(run: RunAggregate, path: string, messagePattern: RegExp): void {
  const issues = parseIssues(run)
  expect(issues.some((issue) => issue.path === path && messagePattern.test(issue.message))).toBe(true)
}

describe('runAggregateSchema review integrity', () => {
  it('accepts runs without a review', () => {
    expect(() => runAggregateSchema.parse(validRun())).not.toThrow()
  })

  it('accepts review rework keys and findings that reference planned issues', () => {
    const run = validRun({
      review: {
        verdict: 'REVISE',
        summary: '返工',
        reworkKeys: ['issue-001', 'issue-002'],
        findings: [{
          issueKey: 'issue-002',
          problem: '不满足验收',
          evidenceNeeded: ['证据'],
          acceptance: '验收 B',
        }],
        at: 3,
      },
    })
    expect(() => runAggregateSchema.parse(run)).not.toThrow()
  })

  it('accepts an empty rework list (semantic “all issues”)', () => {
    const run = validRun({
      review: { verdict: 'PASS', summary: '通过', reworkKeys: [], at: 3 },
    })
    expect(() => runAggregateSchema.parse(run)).not.toThrow()
  })

  it('rejects rework keys that are not planned issues with a clear path', () => {
    const run = validRun({
      review: { verdict: 'REVISE', summary: '返工', reworkKeys: ['issue-999'], at: 3 },
    })
    expectIssue(run, 'review.reworkKeys.0', /does not reference a planned issue/)
  })

  it('rejects rework keys that violate ISSUE_KEY_PATTERN', () => {
    const run = validRun({
      review: { verdict: 'REVISE', summary: '返工', reworkKeys: ['issue/evil'], at: 3 },
    })
    expectIssue(run, 'review.reworkKeys.0', /unsafe issue key/)
  })

  it('rejects finding issue keys that are not planned issues with a clear path', () => {
    const run = validRun({
      review: {
        verdict: 'REVISE',
        summary: '返工',
        reworkKeys: [],
        findings: [{
          issueKey: 'issue-999',
          problem: '不满足验收',
          evidenceNeeded: [],
          acceptance: '验收 B',
        }],
        at: 3,
      },
    })
    expectIssue(run, 'review.findings.0.issueKey', /does not reference a planned issue/)
  })

  it('rejects finding issue keys that violate ISSUE_KEY_PATTERN', () => {
    const run = validRun({
      review: {
        verdict: 'REVISE',
        summary: '返工',
        reworkKeys: [],
        findings: [{
          issueKey: '../escape',
          problem: '不满足验收',
          evidenceNeeded: [],
          acceptance: '验收 B',
        }],
        at: 3,
      },
    })
    expectIssue(run, 'review.findings.0.issueKey', /unsafe issue key/)
  })
})
