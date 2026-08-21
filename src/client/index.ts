/**
 * dsh-taskflow browser half — registers a status chip into the input dock
 * band (`conversation.input.dock`, the same seat dsh-sentinel uses) that
 * polls the host's same-origin `/plugins/taskflow/state` endpoint, shows how
 * many workflow runs are active, opens the P6 kanban board popover, and
 * exposes the P8.5 run detail drawer with allowedActions and confirmation.
 * Read-only projection: all writes go through the host's controlled routes.
 * @module dsh-taskflow/client
 */

import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input dock entry).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { TaskFlowStatus } from './TaskFlowStatus.tsx'
import {
  createTaskFlowSettingsCard,
  type TaskFlowSettingsValue,
} from './TaskFlowSettings.tsx'

export { TaskFlowStatus } from './TaskFlowStatus.tsx'
export type { TaskFlowStatusProps } from './TaskFlowStatus.tsx'
export { TaskFlowSettings } from './TaskFlowSettings.tsx'
export type { TaskFlowSettingsProps, TaskFlowSettingsValue } from './TaskFlowSettings.tsx'

interface SettingsScopeBinder {
  bind<T>(spec: { namespace: string }): SettingsScope<T>
}

/** Required services: slots for the dock entry, conversation for scope. */
export const inject = ['slots', 'conversation']

/**
 * Register the status chip into the input dock band.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'conversation'], (scope: ClientContext) => {
    scope.effect(() => scope.slots.register({
      name: 'conversation.input.dock',
      id: 'taskflow',
      order: 150,
    }, TaskFlowStatus), 'dsh-taskflow: dock registration')
  })

  ctx.inject(['slots', 'settingsScope'], (scope: ClientContext) => {
    const binder = (scope as unknown as { settingsScope: SettingsScopeBinder }).settingsScope
    const settings = binder.bind<TaskFlowSettingsValue>({ namespace: 'taskflow' })
    const SettingsCard = createTaskFlowSettingsCard(settings)
    scope.slots.inject('settings.plugin.item' as never, () => scope.slots.register({
      name: 'settings.plugin.item',
      key: 'taskflow',
      order: 120,
    } as never, SettingsCard as never))
  })
}
