/**
 * The input dock entry: a compact taskflow status chip. It polls the host
 * `/plugins/taskflow/state` endpoint and renders the active run count;
 * transport or server errors render a compact unavailable state. P0 is
 * read-only — run submission happens through the host routes or the agent.
 * @module dsh-taskflow/client/TaskFlowStatus
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './taskflow.module.css'

/** Host /plugins/taskflow/state response (whitelist projection). */
interface TaskFlowStateResponse {
  ok: boolean
  runs?: Array<{
    id: string
    status: string
    title: string
  }>
  error?: string
}

/** Poll interval for the host snapshot. */
const POLL_MS = 30_000

/** Composed props of the dock entry (runtime share only). */
export type TaskFlowStatusProps = PropsRuntime<'conversation.input.dock'>

/**
 * The status chip: polls the host snapshot and shows the active run count.
 * @param _props - the composed dock entry props (session-scoped seat).
 */
export function TaskFlowStatus(_props: TaskFlowStatusProps): ReactElement {
  const [state, setState] = useState<TaskFlowStateResponse | null>(null)

  useEffect(() => {
    let live = true
    const poll = (): void => {
      fetch('/plugins/taskflow/state').then((response) => {
        return response.json() as Promise<TaskFlowStateResponse>
      }).then((snapshot) => {
        if (live) setState(snapshot)
      }, () => {
        if (live) setState(null)
      })
    }
    poll()
    const timer = window.setInterval(poll, POLL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const active = state?.ok === true ? (state.runs ?? []).filter((run) => run.status === 'RECEIVED' || run.status === 'PLANNING' || run.status === 'EXECUTING').length : undefined
  const label = active === undefined
    ? 'taskflow · 不可用'
    : active > 0
      ? `taskflow · ${active} 个运行中`
      : 'taskflow'

  return (
    <span className={css.chip} data-testid="taskflow-chip" title="DSH 任务工作流（P4：审查门）">
      <span className={active !== undefined && active > 0 ? css.dotActive : css.dot} aria-hidden="true" />
      {label}
    </span>
  )
}
