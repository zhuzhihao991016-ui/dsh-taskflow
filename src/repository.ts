/**
 * Run-aggregate repositories. The domain-backed repository is authoritative
 * (durable-first writes on the domain write chain); the memory repository
 * exists for fast deterministic service tests. Both share the same
 * read/write semantics: reads return stored objects (immutable by
 * convention), writes replace whole aggregates.
 */

import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { RunAggregate, TaskFlowDomain } from './domain.ts'

/** Repository contract the service depends on (backend-agnostic). */
export interface TaskFlowRepository {
  listRuns(): RunAggregate[]
  getRun(id: string): RunAggregate | undefined
  insertRun(record: RunAggregate): Promise<void>
  /** Atomic read-modify-write; rejects `missing-key` when the run is absent. */
  updateRun(id: string, fn: (current: RunAggregate) => RunAggregate): Promise<RunAggregate>
  /** Delete a run aggregate. Used by the manual cleanup entry; no-op when missing. */
  deleteRun(id: string): Promise<void>
}

/** Repository over an opened taskflow storage domain. */
export class DomainRepository implements TaskFlowRepository {
  private readonly runs: KvTable<string, RunAggregate>

  constructor(domain: Domain<TaskFlowDomain>) {
    this.runs = domain.table('runs')
  }

  listRuns(): RunAggregate[] {
    return [...this.runs.entries()].map(([, record]) => record)
  }

  getRun(id: string): RunAggregate | undefined {
    return this.runs.get(id)
  }

  insertRun(record: RunAggregate): Promise<void> {
    return this.runs.put(record.id, record).then(() => undefined)
  }

  updateRun(id: string, fn: (current: RunAggregate) => RunAggregate): Promise<RunAggregate> {
    return this.runs.update(id, fn)
  }

  deleteRun(id: string): Promise<void> {
    return this.runs.delete(id).then(() => undefined)
  }
}

/** In-memory repository with identical semantics, for fast service tests. */
export class MemoryRepository implements TaskFlowRepository {
  private readonly runs = new Map<string, RunAggregate>()

  listRuns(): RunAggregate[] {
    return [...this.runs.values()]
  }

  getRun(id: string): RunAggregate | undefined {
    return this.runs.get(id)
  }

  insertRun(record: RunAggregate): Promise<void> {
    this.runs.set(record.id, record)
    return Promise.resolve()
  }

  updateRun(id: string, fn: (current: RunAggregate) => RunAggregate): Promise<RunAggregate> {
    const current = this.runs.get(id)
    if (current === undefined) {
      return Promise.reject(new Error(`taskflow: unknown run ${id}`))
    }
    const next = fn(current)
    this.runs.set(id, next)
    return Promise.resolve(next)
  }

    deleteRun(id: string): Promise<void> {
      this.runs.delete(id)
      return Promise.resolve()
    }
}
