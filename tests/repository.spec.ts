/**
 * Repository tests over the REAL json storage backend: round-trip writes,
 * atomic read-modify-write, restart persistence (close + reopen), and
 * fail-closed behavior on malformed / version-mismatched / schema-invalid
 * media. Mirrors the harness's own storage-domain test mounting pattern.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TASKFLOW_DOMAIN } from '../src/domain.ts'
import { DomainRepository } from '../src/repository.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taskflow-repo-'))
  roots.push(root)
  return root
}

/** Mount the real storage stack over a temp json root and open the taskflow domain. */
async function mount(root: string): Promise<{ ctx: Context; domain: Domain<typeof TASKFLOW_DOMAIN>; repository: DomainRepository }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(TASKFLOW_DOMAIN)
  const repository = new DomainRepository(domain)
  return { ctx, domain, repository }
}

/** Close the domain and dispose the context (simulates a process restart). */
async function unmount(ctx: Context, domain: Domain<typeof TASKFLOW_DOMAIN>): Promise<void> {
  await domain.close()
  await ctx.fiber.dispose()
}

afterEach(async () => {
  // Cleanup is best-effort; a leftover temp dir is harmless.
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

function sampleAggregate(id: string) {
  return {
    id,
    status: 'RECEIVED' as const,
    title: `任务 ${id}`,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    issueCount: 0,
    issues: [],
    executions: [],
    transitions: [{
      seq: 0, from: 'RECEIVED' as const, to: 'RECEIVED' as const,
      reason: 'created', actor: 'host', idempotencyKey: `create:${id}`, at: 1,
    }],
  }
}

describe('DomainRepository', () => {
  it('inserts, reads, lists, and atomically updates aggregates', async () => {
    const root = await freshRoot()
    const { repository } = await mount(root)
    await repository.insertRun(sampleAggregate('run-0001'))
    expect(repository.getRun('run-0001')?.title).toBe('任务 run-0001')
    expect(repository.listRuns()).toHaveLength(1)

    const updated = await repository.updateRun('run-0001', (current) => ({
      ...current,
      status: 'CANCELLED' as const,
      transitions: [...current.transitions, {
        seq: 1, from: 'RECEIVED' as const, to: 'CANCELLED' as const,
        reason: 'cancelled', actor: 'host', idempotencyKey: 'cancel:1', at: 2,
      }],
    }))
    expect(updated.status).toBe('CANCELLED')
    expect(repository.getRun('run-0001')?.transitions).toHaveLength(2)
  })

  it('updateRun rejects a missing key', async () => {
    const root = await freshRoot()
    const { repository } = await mount(root)
    await expect(repository.updateRun('run-9999', (c) => c)).rejects.toThrow()
  })

  it('persists across restart (close + reopen on the same root)', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    await first.repository.insertRun(sampleAggregate('run-0001'))
    await first.repository.updateRun('run-0001', (current) => ({
      ...current,
      status: 'CANCELLED' as const,
      transitions: [...current.transitions, {
        seq: 1, from: 'RECEIVED' as const, to: 'CANCELLED' as const,
        reason: 'cancelled', actor: 'host', idempotencyKey: 'cancel:1', at: 2,
      }],
    }))
    await unmount(first.ctx, first.domain)

    const second = await mount(root)
    expect(second.repository.listRuns()).toHaveLength(1)
    expect(second.repository.getRun('run-0001')?.status).toBe('CANCELLED')
    expect(second.repository.getRun('run-0001')?.transitions).toHaveLength(2)
    await unmount(second.ctx, second.domain)
  })

  it('fails closed on a malformed medium file', async () => {
    const root = await freshRoot()
    const first = await mount(root)
    await first.repository.insertRun(sampleAggregate('run-0001'))
    await unmount(first.ctx, first.domain)

    await writeFile(join(root, 'taskflow.json'), '{ this is not json', 'utf8')
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await expect(ctx.storageDomain.open(TASKFLOW_DOMAIN)).rejects.toMatchObject({
      code: 'malformed-medium',
    })
    await ctx.fiber.dispose()
  })

  it('fails closed on a version-mismatched medium', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'taskflow.json'),
      JSON.stringify({ unit: { name: 'taskflow', version: 2 }, global: null, tables: {} }),
      'utf8',
    )
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await expect(ctx.storageDomain.open(TASKFLOW_DOMAIN)).rejects.toMatchObject({
      code: 'version-mismatch',
    })
    await ctx.fiber.dispose()
  })

  it('fails closed on a schema-invalid stored record', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'taskflow.json'),
      JSON.stringify({
        unit: { name: 'taskflow', version: 1 },
        global: null,
        tables: { runs: { 'run-0001': { id: 'run-0001', status: 'BOGUS' } } },
      }),
      'utf8',
    )
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await expect(ctx.storageDomain.open(TASKFLOW_DOMAIN)).rejects.toMatchObject({
      code: 'invalid-record',
    })
    await ctx.fiber.dispose()
  })

  it('fails closed on an inconsistent aggregate history (status vs final transition)', async () => {
    const root = await freshRoot()
    const inconsistent = {
      ...sampleAggregate('run-0001'),
      status: 'RECEIVED',
      transitions: [
        ...sampleAggregate('run-0001').transitions,
        {
          seq: 1, from: 'RECEIVED' as const, to: 'CANCELLED' as const,
          reason: 'cancelled', actor: 'host', idempotencyKey: 'cancel:1', at: 2,
        },
      ],
    }
    await writeFile(
      join(root, 'taskflow.json'),
      JSON.stringify({
        unit: { name: 'taskflow', version: 1 },
        global: null,
        tables: { runs: { 'run-0001': inconsistent } },
      }),
      'utf8',
    )
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await expect(ctx.storageDomain.open(TASKFLOW_DOMAIN)).rejects.toMatchObject({
      code: 'invalid-record',
    })
    await ctx.fiber.dispose()
  })

  it('opens a pre-P2 medium without the issues field (defaults to [])', async () => {
    const root = await freshRoot()
    const legacy = sampleAggregate('run-0001')
    const { issues, ...withoutIssues } = legacy
    void issues
    await writeFile(
      join(root, 'taskflow.json'),
      JSON.stringify({
        unit: { name: 'taskflow', version: 1 },
        global: null,
        tables: { runs: { 'run-0001': withoutIssues } },
      }),
      'utf8',
    )
    const mounted = await mount(root)
    expect(mounted.repository.getRun('run-0001')?.issues).toEqual([])
    await unmount(mounted.ctx, mounted.domain)
  })

  it('opens a pre-P3 medium without the executions field (defaults to [])', async () => {
    const root = await freshRoot()
    const p2Era = {
      ...sampleAggregate('run-0001'),
      status: 'READY' as const,
      issueCount: 1,
      issues: [{ key: 'issue-001', acceptance: '验收 A' }],
      transitions: [
        ...sampleAggregate('run-0001').transitions,
        {
          seq: 1, from: 'RECEIVED' as const, to: 'PLANNING' as const,
          reason: 'planning-started', actor: 'host', idempotencyKey: 'plan:start:abc', at: 2,
        },
        {
          seq: 2, from: 'PLANNING' as const, to: 'READY' as const,
          reason: 'planning-succeeded', actor: 'host', idempotencyKey: 'plan:done:abc', at: 3,
        },
      ],
    }
    const { executions, ...withoutExecutions } = p2Era
    void executions
    await writeFile(
      join(root, 'taskflow.json'),
      JSON.stringify({
        unit: { name: 'taskflow', version: 1 },
        global: null,
        tables: { runs: { 'run-0001': withoutExecutions } },
      }),
      'utf8',
    )
    const mounted = await mount(root)
    expect(mounted.repository.getRun('run-0001')?.status).toBe('READY')
    await unmount(mounted.ctx, mounted.domain)
  })

  it('fails closed on duplicate or unknown-issue executions', async () => {
    const root = await freshRoot()
    const base = sampleAggregate('run-0001')
    const bad = {
      ...base,
      status: 'EXECUTING' as const,
      issueCount: 1,
      issues: [{ key: 'issue-001', acceptance: '验收 A' }],
      executions: [
        { key: 'issue-001', status: 'running' },
        { key: 'issue-999', status: 'done' },
      ],
      transitions: [
        ...base.transitions,
        {
          seq: 1, from: 'RECEIVED' as const, to: 'EXECUTING' as const,
          reason: 'execution-started', actor: 'host', idempotencyKey: 'exec:start:run-0001', at: 2,
        },
      ],
    }
    await writeFile(
      join(root, 'taskflow.json'),
      JSON.stringify({
        unit: { name: 'taskflow', version: 1 },
        global: null,
        tables: { runs: { 'run-0001': bad } },
      }),
      'utf8',
    )
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await expect(ctx.storageDomain.open(TASKFLOW_DOMAIN)).rejects.toMatchObject({
      code: 'invalid-record',
    })
    await ctx.fiber.dispose()
  })
})
