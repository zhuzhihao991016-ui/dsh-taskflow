/**
 * Plan validation: mechanical checks over the planner's Issue list before a
 * plan may be published to the board. Pure and deterministic — the P2 Codex
 * planner feeds this validator and a rejected plan never reaches the ledger.
 */

/** Issue risk level; L2/L3 constrain scheduling (serial/guarded). */
export type RiskLevel = 'L1' | 'L2' | 'L3'

/** One planned issue, as produced by the planner and validated here. */
export interface PlannedIssue {
  /** Stable unique key, e.g. `issue-001`. */
  key: string
  /** Non-empty acceptance criteria text. */
  acceptance: string
  /** Dependency keys; each must reference an existing issue. */
  deps?: readonly string[]
  /** Risk level; null/undefined when absent (the planner schema models it nullable). */
  risk?: RiskLevel | null
}

/** Validation result: the accepted plan or a stable rejection reason. */
export type PlanVerdict =
  | { ok: true; issues: readonly PlannedIssue[] }
  | { ok: false; error: string }

/** Stable error prefix for plan violations. */
const ERR = 'taskflow: invalid plan'

/** Issue keys are used verbatim in spool paths (executor workDir), so only a
 * safe charset is accepted: alphanumeric start, then alphanumerics, dots,
 * underscores, and hyphens. Rejects separators, traversal, and whitespace. */
export const ISSUE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Validate one plan: unique keys, present deps, no cycles, non-empty acceptance. */
export function validatePlan(issues: readonly PlannedIssue[]): PlanVerdict {
  if (issues.length === 0) {
    return { ok: false, error: `${ERR}: no issues` }
  }

  const keys = new Set<string>()
  for (const issue of issues) {
    if (issue.key === '' || keys.has(issue.key)) {
      return { ok: false, error: `${ERR}: duplicate or empty issue key '${issue.key}'` }
    }
    keys.add(issue.key)
    if (!ISSUE_KEY_PATTERN.test(issue.key)) {
      return { ok: false, error: `${ERR}: issue key '${issue.key}' uses an unsafe character` }
    }
    if (issue.acceptance.trim() === '') {
      return { ok: false, error: `${ERR}: issue '${issue.key}' has empty acceptance criteria` }
    }
    if (issue.risk !== undefined && issue.risk !== null && !['L1', 'L2', 'L3'].includes(issue.risk)) {
      return { ok: false, error: `${ERR}: issue '${issue.key}' has invalid risk '${String(issue.risk)}'` }
    }
  }

  const depsOf = new Map<string, readonly string[]>()
  for (const issue of issues) {
    const deps = issue.deps ?? []
    for (const dep of deps) {
      if (dep === issue.key) {
        return { ok: false, error: `${ERR}: issue '${issue.key}' depends on itself` }
      }
      if (!keys.has(dep)) {
        return { ok: false, error: `${ERR}: issue '${issue.key}' depends on unknown issue '${dep}'` }
      }
    }
    depsOf.set(issue.key, deps)
  }

  // Cycle detection: three-color DFS over the dependency graph.
  const color = new Map<string, 0 | 1 | 2>()
  const visit = (key: string, stack: string[]): string | undefined => {
    const c = color.get(key) ?? 0
    if (c === 2) return undefined
    if (c === 1) {
      const cycle = [...stack, key]
      const start = cycle.indexOf(key)
      return cycle.slice(start).join(' → ')
    }
    color.set(key, 1)
    for (const dep of depsOf.get(key) ?? []) {
      const found = visit(dep, [...stack, key])
      if (found !== undefined) return found
    }
    color.set(key, 2)
    return undefined
  }
  for (const issue of issues) {
    const cycle = visit(issue.key, [])
    if (cycle !== undefined) {
      return { ok: false, error: `${ERR}: dependency cycle ${cycle}` }
    }
  }

  return { ok: true, issues }
}
