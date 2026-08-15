/**
 * TaskFlowService unit tests: ledger semantics of the P0 vertical slice.
 * The full state machine (planning/execution/review) is tested per phase.
 */

import { describe, expect, it } from 'vitest'
import { TaskFlowService, validateSubmit } from '../src/service.ts'

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
  it('submit creates a RECEIVED snapshot with a stable id and count', () => {
    const service = new TaskFlowService()
    const run = service.submit({ title: '升级后端', description: 'agtscp2.0' })
    expect(run.id).toBe('run-0001')
    expect(run.status).toBe('RECEIVED')
    expect(run.title).toBe('升级后端')
    expect(run.description).toBe('agtscp2.0')
    expect(run.issueCount).toBe(0)
    expect(typeof run.createdAt).toBe('number')
  })

  it('trims surrounding whitespace from title and description', () => {
    const service = new TaskFlowService()
    const run = service.submit({ title: '  任务A  ', description: '  描述  ' })
    expect(run.title).toBe('任务A')
    expect(run.description).toBe('描述')
  })

  it('snapshot returns undefined for an unknown id', () => {
    const service = new TaskFlowService()
    expect(service.snapshot('run-9999')).toBeUndefined()
  })

  it('list returns runs in submission order', () => {
    const service = new TaskFlowService()
    service.submit({ title: '一' })
    service.submit({ title: '二' })
    expect(service.list().map((run) => run.title)).toEqual(['一', '二'])
  })

  it('cancel transitions a live run to CANCELLED', () => {
    const service = new TaskFlowService()
    const run = service.submit({ title: '任务' })
    expect(service.command(run.id, 'cancel')).toEqual({ ok: true })
    expect(service.snapshot(run.id)?.status).toBe('CANCELLED')
  })

  it('cancel fails for unknown ids and terminal runs', () => {
    const service = new TaskFlowService()
    const run = service.submit({ title: '任务' })
    service.command(run.id, 'cancel')
    expect(service.command('run-9999', 'cancel').ok).toBe(false)
    expect(service.command(run.id, 'cancel').ok).toBe(false)
  })

  it('unimplemented actions fail with a stable error', () => {
    const service = new TaskFlowService()
    const run = service.submit({ title: '任务' })
    const result = service.command(run.id, 'pause' as never)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not implemented/)
  })

  it('subscribe notifies on submit and cancel; unsubscribe stops it', () => {
    const service = new TaskFlowService()
    const events: string[] = []
    const dispose = service.subscribe(() => { events.push('change') })
    const run = service.submit({ title: '任务' })
    service.command(run.id, 'cancel')
    dispose()
    service.submit({ title: '任务二' })
    expect(events).toEqual(['change', 'change'])
  })

  it('snapshots are detached copies', () => {
    const service = new TaskFlowService()
    const run = service.submit({ title: '任务' })
    const first = service.snapshot(run.id)
    expect(first).toBeDefined()
    if (first !== undefined) {
      first.status = 'ACCEPTED' as never
      expect(service.snapshot(run.id)?.status).toBe('RECEIVED')
    }
  })
})
