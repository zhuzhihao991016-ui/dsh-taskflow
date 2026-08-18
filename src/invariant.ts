/**
 * dsh-taskflow runtime invariant: the run aggregate's transition legality is
 * enforced at the write boundary (the service's repository update runs
 * assertTransition before persisting, inside the domain's atomic RMW), so no
 * illegal transition can ever be stored; aggregate round-trip validity is
 * re-checked by the storage domain's zod schema on every open. Service
 * behavior and the state machine are covered by unit tests.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.invariants service declaration merge.
import type {} from '@deepseek-ai/dsh-invariants'

export const name = 'dsh-taskflow'
export const inject = ['invariants']

/** Register the package's (currently empty) invariant contribution. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.invariants.register('dsh-taskflow', () => {
    // No runtime invariant: 状态迁移合法性在写入边界由 assertTransition 强制
    // （仓库原子 update 内），聚合 schema 由 storage-domain 打开时全量校验；
    // 此处无可独立观察的跨域数据关系。
  }), 'dsh-taskflow: invariants')
}
