/**
 * dsh-taskflow runtime invariant: the ledger is plain in-memory state in P0
 * (P1 moves it to a storage-domain aggregate), so there is no durable
 * cross-domain relation to assert yet; service behavior is covered by unit
 * tests.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.invariants service declaration merge.
import type {} from '@deepseek-ai/dsh-invariants'

export const name = 'dsh-taskflow'
export const inject = ['invariants']

/** Register the package's (currently empty) invariant contribution. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.invariants.register('dsh-taskflow', () => {
    // No runtime invariant: P0 台账在内存中，无持久数据关系可断言；P1 引入
    // storage-domain 聚合后在此登记对应的数据关系不变量。
  }), 'dsh-taskflow: invariants')
}
