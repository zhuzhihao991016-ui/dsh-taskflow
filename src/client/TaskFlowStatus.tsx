/**
 * The input dock entry: a compact taskflow status chip with a P6 kanban
 * board popover. It polls the host `/plugins/taskflow/state` endpoint for the
 * chip count and `/plugins/taskflow/board` while the board is open. P6 is
 * still read-only — run submission and issue movement happen through the host
 * routes or the agent.
 * @module dsh-taskflow/client/TaskFlowStatus
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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

/** One card in the board response. */
interface BoardCard {
  runId: string
  runTitle: string
  runStatus: string
  issueKey: string
  acceptance: string
  deps: string[]
  risk?: string | null
  status: 'pending' | 'running' | 'done' | 'failed'
  summary?: string
}

/** One kanban column in the board response. */
interface BoardColumn {
  id: string
  title: string
  cards: BoardCard[]
}

/** Host /plugins/taskflow/board response (whitelist projection). */
interface BoardResponse {
  ok: boolean
  columns?: BoardColumn[]
  error?: string
}

/** Poll interval for the host snapshot. */
const POLL_MS = 30_000

/** Composed props of the dock entry (runtime share only). */
export type TaskFlowStatusProps = PropsRuntime<'conversation.input.dock'>

/** Poll one JSON endpoint while enabled; aborts in-flight requests on cleanup. */
function useJsonPoll<T>(
  path: string,
  enabled: boolean,
  setValue: (value: T | null) => void,
): void {
  useEffect(() => {
    if (!enabled) return
    let live = true
    let controller: AbortController | undefined
    let inFlight = false
    const poll = (): void => {
      if (inFlight) return
      inFlight = true
      controller = new AbortController()
      fetch(path, { signal: controller.signal }).then((response) => {
        return response.json() as Promise<T>
      }).then((value) => {
        if (live) setValue(value)
      }, () => {
        if (live) setValue(null)
      }).finally(() => {
        inFlight = false
        controller = undefined
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
      controller?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [path, enabled, setValue])
}

/**
 * The status chip and board popover: polls the host snapshot and shows the
 * active run count; the board opens on click and renders kanban columns.
 * @param _props - the composed dock entry props (session-scoped seat).
 */
export function TaskFlowStatus(_props: TaskFlowStatusProps): ReactElement {
  const [state, setState] = useState<TaskFlowStateResponse | null>(null)
  const [board, setBoard] = useState<BoardResponse | null>(null)
  const [open, setOpen] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useJsonPoll<TaskFlowStateResponse>('/plugins/taskflow/state', true, setState)
  useJsonPoll<BoardResponse>('/plugins/taskflow/board', open, setBoard)

  useEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  const close = (): void => {
    setOpen(false)
    chipRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      close()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = boardRef.current
    if (dialog === null) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const active = state?.ok === true ? (state.runs ?? []).filter((run) => run.status === 'RECEIVED' || run.status === 'PLANNING' || run.status === 'EXECUTING').length : undefined
  const label = active === undefined
    ? 'taskflow · 不可用'
    : active > 0
      ? `taskflow · ${active} 个运行中`
      : 'taskflow'

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={css.chip}
        data-testid="taskflow-chip"
        title="DSH 任务工作流（P6：看板）"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={active !== undefined && active > 0 ? css.dotActive : css.dot} aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div className={css.backdrop} onClick={close} role="presentation">
          <div
            ref={boardRef}
            className={css.board}
            role="dialog"
            aria-modal="true"
            aria-label="任务流看板"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            <div className={css.boardHeader}>
              <strong>任务流看板</strong>
              <button
                ref={closeButtonRef}
                type="button"
                className={css.closeButton}
                onClick={close}
                aria-label="关闭看板"
              >
                ×
              </button>
            </div>
            {board?.ok === true ? (
              <div className={css.columns}>
                {(board.columns ?? []).map((column) => (
                  <section key={column.id} className={css.column}>
                    <h3 className={css.columnTitle}>
                      <span>{column.title}</span>
                      <span className={css.columnCount}>{column.cards.length}</span>
                    </h3>
                    <div className={css.cards}>
                      {column.cards.map((card) => (
                        <article key={`${card.runId}:${card.issueKey}`} className={css.card}>
                          <header className={css.cardHeader}>
                            <span className={css.cardRun}>{card.runTitle}</span>
                            <span className={css.cardKey}>{card.issueKey}</span>
                          </header>
                          <p className={css.cardAcceptance}>{card.acceptance}</p>
                          {card.deps.length > 0 && (
                            <p className={css.cardDeps}>依赖：{card.deps.join(', ')}</p>
                          )}
                          {card.status === 'done' && card.summary !== undefined && (
                            <p className={css.cardSummary}>{card.summary}</p>
                          )}
                        </article>
                      ))}
                      {column.cards.length === 0 && <p className={css.empty}>无</p>}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <p className={css.empty}>看板不可用</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
