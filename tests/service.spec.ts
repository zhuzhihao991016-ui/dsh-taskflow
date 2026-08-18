/**
 * TaskFlowService tests over the memory repository: ledger semantics,
 * idempotent submit, atomic cancel, and listener notifications. The
 * domain-backed path (restart/corruption) is covered in repository.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import type { RunAggregate } from '../src/domain.ts'
import { PlannerError, type PlanInput } from '../src/planner.ts'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService, validateSubmit } from '../src/service.ts'
import type { Planner } from '../src/service.ts'

/** Scriptable fake planner for service-level plan-flow tests. */
class FakePlanner implements Planner {
  calls = 0
  delayMs = 0
  result: unknown = { issues: [] }
  error?: Error

  async plan(_input: PlanInput): Promise<unknown> {
    this.calls += 1
    if (this.delayMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs))
    }
    if (this.error !== undefined) throw this.error
    return this.result
  }
}

function harness() {
  const repository = new MemoryRepository()
  const planner = new FakePlanner()
  const service = new TaskFlowService(repository, () => 1000, planner, ['C:/repo'])
  return { repository, service, planner }
}

describe('validateSubmit', () => {
  it('rejects empty and blank titles', () => {
    expect(() => validateSubmit({ title: '' })).toThrow('non-empty title')
    expect(() => validateSubmit({ title: '   ' })).toThrow('non-empty title')
  })

  it('accepts a non-empty title', () => {
    expect(() => validateSubmit({ title: '任务' })).not.toThrow()
  })
})

describe('TaskFlowService', () => {
  it('submit creates a RECEIVED snapshot with a creation transition', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '升级后端', description: 'agtscp2.0' })
    expect(run.id).toBe('run-0001')
    expect(run.status).toBe('RECEIVED')
    expect(run.title).toBe('升级后端')
    expect(run.description).toBe('agtscp2.0')
    expect(run.issueCount).toBe(0)
    expect(run.transitionCount).toBe(1)
    expect(typeof run.createdAt).toBe('number')
  })

  it('trims surrounding whitespace from title and description', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '  任务A  ', description: '  描述  ' })
    expect(run.title).toBe('任务A')
    expect(run.description).toBe('描述')
  })

  it('repeated submit with the same idempotency key returns the existing run', async () => {
    const { service } = harness()
    const first = await service.submit({ title: '任务', idempotencyKey: 'req-1' })
    const second = await service.submit({ title: '任务', idempotencyKey: 'req-1' })
    expect(second.id).toBe(first.id)
    expect(service.list()).toHaveLength(1)
  })

  it('creates separate runs for same-title submits without a key', async () => {
    const { service } = harness()
    const first = await service.submit({ title: '同标题' })
    const second = await service.submit({ title: '同标题' })
    expect(first.id).not.toBe(second.id)
    expect(service.list()).toHaveLength(2)
  })

  it('rejects the same idempotency key with a different request', async () => {
    const { service } = harness()
    await service.submit({ title: '任务', description: '原始', idempotencyKey: 'req-1' })
    await expect(service.submit({ title: '任务', description: '改了', idempotencyKey: 'req-1' })).rejects.toThrow(
      'different request',
    )
    expect(service.list()).toHaveLength(1)
  })

  it('rejects the same idempotency key with a different repoRoot', async () => {
    const { service } = harness()
    await service.submit({ title: '任务', repoRoot: 'C:/repo', idempotencyKey: 'req-2' })
    await expect(service.submit({ title: '任务', repoRoot: 'C:/other', idempotencyKey: 'req-2' })).rejects.toThrow(
      'different request',
    )
    expect(service.list()).toHaveLength(1)
  })

  it('recognizes legacy bare-key encodings for idempotent retries', async () => {
    const { repository, service } = harness()
    const run = await service.submit({ title: '旧数据', idempotencyKey: 'req-legacy' })
    // Rewrite the creation transition key to the pre-encoding format (bare key).
    await repository.updateRun(run.id, (current) => ({
      ...current,
      transitions: [{ ...current.transitions[0], idempotencyKey: 'req-legacy' }],
    }))
    const retry = await service.submit({ title: '旧数据', idempotencyKey: 'req-legacy' })
    expect(retry.id).toBe(run.id)
    expect(service.list()).toHaveLength(1)
  })

  it('rejects a non-string idempotency key before persisting anything', async () => {
    const { service } = harness()
    expect(() => service.submit({ title: '任务', idempotencyKey: 123 as never })).toThrow(
      'idempotencyKey must be a string',
    )
    expect(service.list()).toHaveLength(0)
  })

  it('serializes concurrent submits without id collisions or overwrites', async () => {
    const { service } = harness()
    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => service.submit({ title: `任务${n}` })),
    )
    const ids = runs.map((run) => run.id)
    expect(new Set(ids).size).toBe(5)
    expect(service.list()).toHaveLength(5)
  })

  it('snapshot returns undefined for an unknown id', async () => {
    const { service } = harness()
    expect(service.snapshot('run-9999')).toBeUndefined()
  })

  it('list returns runs in submission order with monotonic ids', async () => {
    const { service } = harness()
    await service.submit({ title: '一' })
    await service.submit({ title: '二' })
    const list = service.list()
    expect(list.map((run) => run.title)).toEqual(['一', '二'])
    expect(list.map((run) => run.id)).toEqual(['run-0001', 'run-0002'])
  })

  it('cancel transitions a live run to CANCELLED and appends a transition', async () => {
    const { repository, service } = harness()
    const run = await service.submit({ title: '任务' })
    const result = await service.command(run.id, 'cancel')
    expect(result).toEqual({ ok: true })
    const aggregate = repository.getRun(run.id)
    expect(aggregate?.status).toBe('CANCELLED')
    expect(aggregate?.transitions).toHaveLength(2)
    expect(aggregate?.transitions[1]).toMatchObject({ from: 'RECEIVED', to: 'CANCELLED', reason: 'cancelled' })
    expect(aggregate?.transitions[1].seq).toBe(1)
  })

  it('cancel fails for unknown ids and terminal runs', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '任务' })
    await service.command(run.id, 'cancel')
    expect((await service.command('run-9999', 'cancel')).ok).toBe(false)
    const terminal = await service.command(run.id, 'cancel')
    expect(terminal.ok).toBe(false)
    expect(terminal.error).toMatch(/illegal transition/)
  })

  it('unimplemented actions fail with a stable error', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '任务' })
    const result = await service.command(run.id, 'pause' as never)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unsupported action/)
  })

  it('subscribe notifies on submit and cancel; unsubscribe stops it', async () => {
    const { service } = harness()
    const events: string[] = []
    const dispose = service.subscribe(() => { events.push('change') })
    const run = await service.submit({ title: '任务' })
    await service.command(run.id, 'cancel')
    dispose()
    await service.submit({ title: '任务二' })
    expect(events).toEqual(['change', 'change'])
  })

  it('snapshots are detached copies', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '任务' })
    const first = service.snapshot(run.id)
    expect(first).toBeDefined()
    if (first !== undefined) {
      first.status = 'ACCEPTED' as never
      expect(service.snapshot(run.id)?.status).toBe('RECEIVED')
    }
  })
})

describe('TaskFlowService.plan', () => {
  const PLAN = {
    issues: [
      { key: 'issue-001', acceptance: '验收 A' },
      { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'], risk: 'L2' },
    ],
  }

  async function submitReady(service: TaskFlowService, planner: FakePlanner, title = '任务') {
    const run = await service.submit({ title, description: '描述', repoRoot: 'C:/repo' })
    planner.result = PLAN
    return run
  }

  it('moves RECEIVED → PLANNING → READY and persists the validated issues', async () => {
    const { repository, service, planner } = harness()
    const run = await submitReady(service, planner)
    const result = await service.plan(run.id, { wait: true })

    expect(result).toMatchObject({ ok: true, runId: run.id, status: 'PLANNING', alreadyPlanned: false })
    expect(planner.calls).toBe(1)
    const aggregate = repository.getRun(run.id)
    expect(aggregate?.status).toBe('READY')
    expect(aggregate?.issueCount).toBe(2)
    expect(aggregate?.issues.map((issue) => issue.key)).toEqual(['issue-001', 'issue-002'])
    expect(aggregate?.transitions.map((t) => t.reason)).toEqual([
      'created', 'planning-started', 'planning-succeeded',
    ])
  })

  it('rejects a cyclic plan and moves the run to FAILED', async () => {
    const { service, planner } = harness()
    const run = await submitReady(service, planner)
    planner.result = {
      issues: [
        { key: 'a', acceptance: 'x', deps: ['b'] },
        { key: 'b', acceptance: 'x', deps: ['a'] },
      ],
    }
    await service.plan(run.id, { wait: true })
    expect(service.snapshot(run.id)?.status).toBe('FAILED')
  })

  it('fails the run when the planner errors (infrastructure failure)', async () => {
    const { service, planner } = harness()
    const run = await submitReady(service, planner)
    planner.error = new PlannerError('timeout', 'exceeded')
    await service.plan(run.id, { wait: true })
    expect(service.snapshot(run.id)?.status).toBe('FAILED')
  })

  it('requires repoRoot before starting a plan', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '无仓库' })
    const result = await service.plan(run.id)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('repoRoot') })
    expect(service.snapshot(run.id)?.status).toBe('RECEIVED')
  })

  it('rejects a repoRoot outside the configured allowlist', async () => {
    const { service } = harness()
    const run = await service.submit({ title: '越界', repoRoot: 'D:/other' })
    const result = await service.plan(run.id)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not in allowedRepoRoots') })
    expect(service.snapshot(run.id)?.status).toBe('RECEIVED')
  })

  it('resumes a persisted PLANNING run instead of re-transitioning', async () => {
    const { repository, service, planner } = harness()
    const run = await service.submit({ title: '中断的规划', repoRoot: 'C:/repo' })
    // Simulate a host restart mid-plan: the run is persisted in PLANNING with
    // the planning-started transition but no plan:done.
    await repository.updateRun(run.id, (current) => ({
      ...current,
      status: 'PLANNING' as const,
      transitions: [...current.transitions, {
        seq: 1, from: 'RECEIVED' as const, to: 'PLANNING' as const,
        reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 1001,
      }],
    }))
    planner.result = PLAN
    const result = await service.plan(run.id, { wait: true })
    expect(result).toMatchObject({ ok: true, status: 'PLANNING' })
    expect(planner.calls).toBe(1)
    expect(service.snapshot(run.id)?.status).toBe('READY')
  })

  it('resumePlanning re-runs every persisted PLANNING run', async () => {
    const { repository, service, planner } = harness()
    const run = await service.submit({ title: '重启续跑', repoRoot: 'C:/repo' })
    await repository.updateRun(run.id, (current) => ({
      ...current,
      status: 'PLANNING' as const,
      transitions: [...current.transitions, {
        seq: 1, from: 'RECEIVED' as const, to: 'PLANNING' as const,
        reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 1001,
      }],
    }))
    planner.result = PLAN
    service.resumePlanning()
    // resumePlanning is fire-and-forget; give the microtask queue a turn.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    expect(planner.calls).toBe(1)
    expect(service.snapshot(run.id)?.status).toBe('READY')
  })

  it('runs the planner exactly once under concurrent plan calls', async () => {
    const { service, planner } = harness()
    planner.delayMs = 20
    const run = await service.submit({ title: '并发规划', repoRoot: 'C:/repo' })
    planner.result = PLAN
    const results = await Promise.all([
      service.plan(run.id, { wait: true }),
      service.plan(run.id, { wait: true }),
    ])
    expect(planner.calls).toBe(1)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(service.snapshot(run.id)?.status).toBe('READY')
  })

  it('does not double-run when resumePlanning overlaps an in-flight plan', async () => {
    const { service, planner } = harness()
    planner.delayMs = 20
    const run = await service.submit({ title: '重叠规划', repoRoot: 'C:/repo' })
    planner.result = PLAN
    const first = service.plan(run.id, { wait: true })
    service.resumePlanning()
    await first
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    expect(planner.calls).toBe(1)
    expect(service.snapshot(run.id)?.status).toBe('READY')
  })

  it('is idempotent: a repeated plan for the same input does not re-run the planner', async () => {
    const { service, planner } = harness()
    const run = await submitReady(service, planner)
    await service.plan(run.id, { wait: true })
    const again = await service.plan(run.id, { wait: true })
    expect(again).toMatchObject({ ok: true, alreadyPlanned: true })
    expect(planner.calls).toBe(1)
  })

  it('reports alreadyPlanned when planning a run that already has a plan for the same input', async () => {
    const { service, planner } = harness()
    const run = await submitReady(service, planner)
    await service.plan(run.id, { wait: true })
    const result = await service.plan(run.id)
    expect(result).toMatchObject({ ok: true, alreadyPlanned: true })
    expect(planner.calls).toBe(1)
  })

  it('rejects planning a run in a non-plannable state (cancelled, no plan)', async () => {
    const { service, planner } = harness()
    const run = await service.submit({ title: '任务', repoRoot: 'C:/repo' })
    await service.command(run.id, 'cancel')
    const result = await service.plan(run.id)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('illegal transition') })
  })

  it('does not acknowledge a plan whose durable transition fails', async () => {
    // A repository whose PLANNING write fails (e.g. backend outage) must make
    // plan() fail instead of answering 202 with the run still RECEIVED.
    class FailingRepository extends MemoryRepository {
      override updateRun(id: string, fn: (current: RunAggregate) => RunAggregate): Promise<RunAggregate> {
        if (id === 'run-0001') {
          // A backend outage does not carry the taskflow: client-conflict
          // prefix, so plan() must propagate it (thrown) instead of answering
          // a result — the route turns that into 5xx.
          return Promise.reject(new Error('backend unavailable'))
        }
        return super.updateRun(id, fn)
      }
    }
    const failing = new FailingRepository()
    const planner = new FakePlanner()
    const service = new TaskFlowService(failing, () => 1000, planner, ['C:/repo'])
    await service.submit({ title: '故障', repoRoot: 'C:/repo' })
    await expect(service.plan('run-0001')).rejects.toThrow('backend unavailable')
    expect(planner.calls).toBe(0)
  })
})
