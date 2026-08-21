/**
 * P8.0 contract-freeze tests: the automation config schema, control-action
 * vocabulary, event vocabulary, and default automation config remain stable.
 */

import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_CONTROL_ACTIONS,
  DEFAULT_AUTOMATION_CONFIG,
  TASKFLOW_EVENT_KINDS,
  type AutomationConfig,
} from '../src/contracts.ts'
import { Config } from '../src/index.ts'

describe('P8.0 automation config contract', () => {
  it('enables automation by default and preserves P7 agent-driven fields', () => {
    const parsed = Config({})
    expect(parsed.automationEnabled).toBe(true)
    expect(parsed.autoPlan).toBe(true)
    expect(parsed.autoReview).toBe(true)
    expect(parsed.maxExecutorProcesses).toBe(DEFAULT_AUTOMATION_CONFIG.maxExecutorProcesses)
    expect(parsed.maxReviewCycles).toBe(DEFAULT_AUTOMATION_CONFIG.maxReviewCycles)
    expect(parsed.requireExecutionPermission).toBe(DEFAULT_AUTOMATION_CONFIG.requireExecutionPermission)
    // Existing P7 fields remain intact.
    expect(parsed.maxConcurrent).toBe(1)
    expect(parsed.integrationBranch).toBe('taskflow/integration')
    expect(parsed.worktreesRoot).toBe('')
  })

  it('accepts explicit automation overrides', () => {
    const parsed = Config({
      automationEnabled: true,
      maxExecutorProcesses: 4,
      maxReviewCycles: 5,
      autoReview: false,
      requireExecutionPermission: true,
    })
    expect(parsed).toMatchObject({
      automationEnabled: true,
      maxExecutorProcesses: 4,
      maxReviewCycles: 5,
      autoReview: false,
      requireExecutionPermission: true,
    })
  })

  it('allows explicit opt-out from default automation', () => {
    const parsed = Config({ automationEnabled: false })
    expect(parsed.automationEnabled).toBe(false)
  })
})

describe('P8.0 contract vocabulary', () => {
  it('exposes the human intervention control actions', () => {
    expect(AUTOMATION_CONTROL_ACTIONS).toEqual([
      'pause',
      'resume',
      'cancel',
      'takeover',
      'release',
      'retry',
    ])
  })

  it('exposes the whitelisted taskflow event kinds', () => {
    expect(TASKFLOW_EVENT_KINDS).toContain('run.updated')
    expect(TASKFLOW_EVENT_KINDS).toContain('issue.progress')
    expect(TASKFLOW_EVENT_KINDS).toContain('issue.finished')
    expect(TASKFLOW_EVENT_KINDS).toContain('review.finished')
    expect(TASKFLOW_EVENT_KINDS).toContain('human.decision')
  })

  it('default automation config satisfies the contract type', () => {
    const config: AutomationConfig = DEFAULT_AUTOMATION_CONFIG
    expect(config.enabled).toBe(true)
    expect(config.maxExecutorProcesses).toBeGreaterThan(0)
    expect(config.maxReviewCycles).toBeGreaterThan(0)
    expect(config.requireExecutionPermission).toBe(true)
  })
})
