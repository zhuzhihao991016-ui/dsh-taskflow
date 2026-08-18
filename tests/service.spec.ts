/**
 * TaskFlowService tests over the memory repository: ledger semantics,
 * idempotent submit, atomic cancel, and listener notifications. The
 * domain-backed path (restart/corruption) is covered in repository.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { MemoryRepository } from '../src/repository.ts'
import { TaskFlowService, validateSubmit } from '../src/service.ts'

function harness() {
  const repository = new MemoryRepository()
  const service = new TaskFlowService(repository)
  return { repository, service }
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
