/**
 * The input dock entry: a compact taskflow status chip with a P6 kanban
 * board popover and a P8.5 run console drawer. It polls the host
 * `/plugins/taskflow/state` endpoint for the chip count and
 * `/plugins/taskflow/board` while the board is open. Clicking a board card
 * opens the run detail drawer (`/plugins/taskflow/run`), subscribes to the
 * run-scoped SSE stream, and renders `allowedActions` as confirmed action
 * buttons. All writes still go through the host's controlled routes.
 * @module dsh-taskflow/client/TaskFlowStatus
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
    executions?: Array<{
      status: string
    }>
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

/** One whitelisted run event shown in the drawer. */
interface RunEvent {
  seq: number
  at: number
  runId: string
  kind: string
  issueKey?: string
  attemptId?: string
  phase?: string
  summary?: string
}

/** P8.1/P8.5 run-detail projection returned by /plugins/taskflow/run. */
interface RunDetail {
  runId: string
  status: string
  automation: {
    enabled: boolean
    mode: string
  }
  currentIssue?: {
    key: string
    attemptId?: string
    phase?: string
    workDir?: string
    branch?: string
    heartbeatAt?: number
  }
  allowedActions: string[]
  recentEvents: RunEvent[]
}

/** Host /plugins/taskflow/run response (whitelist projection). */
interface RunDetailResponse {
  ok: boolean
  run?: RunDetail
  error?: string
}

/** Human-readable labels for every action surfaced from allowedActions. */
const ACTION_LABELS: Record<string, string> = {
  pause: '暂停',
  resume: '继续',
  cancel: '取消',
  takeover: '接管',
  release: '放行',
  retry: '重试',
  accept: '通过',
  rework: '打回',
}

/** SSE event names emitted by the host; EventSource dispatches these as
 * named events rather than firing `onmessage`. */
const SSE_EVENT_KINDS = [
  'run.updated',
  'issue.started',
  'issue.progress',
  'issue.finished',
  'issue.failed',
  'review.started',
  'review.finished',
  'human.decision',
  'automation.paused',
  'automation.resumed',
] as const

/** Poll interval for the host snapshot. */
const POLL_MS = 30_000

/** Composed props of the dock entry (runtime share only). */
export type TaskFlowStatusProps = PropsRuntime<'conversation.input.dock'>

/** Poll one JSON endpoint while enabled; aborts in-flight requests on cleanup. */
function useJsonPoll<T>(
  path: string,
  enabled: boolean,
  setValue: (value: T | null) => void,
  refreshKey = 0,
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
  }, [path, enabled, setValue, refreshKey])
}

/** Open the P8.3 SSE channel and bump a refresh key on each event so the
 * poll hooks re-fetch immediately instead of waiting for the next interval. */
function useSseRefresh(onEvent: () => void): void {
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/plugins/taskflow/events')
    const handler = (): void => onEvent()
    for (const kind of SSE_EVENT_KINDS) source.addEventListener(kind, handler)
    source.onmessage = handler
    source.onerror = () => { source.close() }
    return () => { source.close() }
  }, [onEvent])
}

/** Open a run-scoped P8.3/P8.5 SSE channel while the run drawer is active so
 * detail/actions refresh immediately on new durable events. */
function useRunSse(runId: string | null, onEvent: () => void): void {
  useEffect(() => {
    if (runId === null || typeof EventSource === 'undefined') return
    const source = new EventSource(`/plugins/taskflow/events?runId=${encodeURIComponent(runId)}`)
    const handler = (): void => onEvent()
    for (const kind of SSE_EVENT_KINDS) source.addEventListener(kind, handler)
    source.onmessage = handler
    source.onerror = () => { source.close() }
    return () => { source.close() }
  }, [runId, onEvent])
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
  const [revision, setRevision] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetailResponse | null>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [sendingAction, setSendingAction] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const handleSseEvent = useCallback(() => setRevision((value) => value + 1), [])
  const handleDetailSseEvent = useCallback(() => setDetailRevision((value) => value + 1), [])
  useSseRefresh(handleSseEvent)
  useRunSse(selectedRunId, handleDetailSseEvent)
  useJsonPoll<TaskFlowStateResponse>('/plugins/taskflow/state', true, setState, revision)
  useJsonPoll<BoardResponse>('/plugins/taskflow/board', open, setBoard, revision)
  useJsonPoll<RunDetailResponse>(
    selectedRunId === null ? '/plugins/taskflow/run?runId=' : `/plugins/taskflow/run?runId=${encodeURIComponent(selectedRunId)}`,
    selectedRunId !== null,
    setDetail,
    detailRevision,
  )

  useEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  const closeRun = useCallback((): void => {
    setSelectedRunId(null)
    setDetail(null)
    setDetailRevision(0)
    setPendingAction(null)
    setActionError(null)
    setSendingAction(false)
  }, [])

  const close = useCallback((): void => {
    closeRun()
    setOpen(false)
    chipRef.current?.focus()
  }, [closeRun])

  const openRun = useCallback((runId: string): void => {
    setSelectedRunId(runId)
    setDetail(null)
    setDetailRevision(0)
    setPendingAction(null)
    setActionError(null)
    setSendingAction(false)
  }, [])

  const confirmAction = useCallback(async (action: string): Promise<void> => {
    if (selectedRunId === null) return
    setSendingAction(true)
    setActionError(null)
    try {
      const isHumanDecision = action === 'accept' || action === 'rework'
      const path = isHumanDecision ? '/plugins/taskflow/human-decision' : '/plugins/taskflow/command'
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isHumanDecision
          ? { runId: selectedRunId, decision: action }
          : { runId: selectedRunId, action }),
      })
      const body = await response.json() as { ok: boolean; error?: string }
      if (!body.ok) {
        setActionError(body.error ?? `taskflow: ${action} failed`)
        return
      }
      setPendingAction(null)
      setDetailRevision((value) => value + 1)
    } catch {
      setActionError('taskflow: 操作请求失败')
    } finally {
      setSendingAction(false)
    }
  }, [selectedRunId])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (selectedRunId !== null) {
        closeRun()
      } else {
        close()
      }
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

  const active = state?.ok === true ? (state.runs ?? []).filter((run) => {
    if (run.status === 'PLANNING') return true
    if (run.status !== 'EXECUTING') return false
    return (run.executions ?? []).some((execution) => execution.status === 'running')
  }).length : undefined
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
        aria-haspopup="dialog"
        aria-expanded={open}
        title="DSH 任务工作流（P8.5：运行台）"
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
            <div className={css.boardBody}>
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
                          <button
                            key={`${card.runId}:${card.issueKey}`}
                            type="button"
                            className={css.card}
                            data-status={card.status}
                            data-testid={`taskflow-card-${card.runId}:${card.issueKey}`}
                            onClick={() => openRun(card.runId)}
                          >
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
                          </button>
                        ))}
                        {column.cards.length === 0 && <p className={css.empty}>无</p>}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className={css.empty}>看板不可用</p>
              )}
              {selectedRunId !== null && (
                <aside className={css.drawer} aria-label="运行详情">
                  <div className={css.drawerHeader}>
                    <strong>运行详情</strong>
                    <button
                      type="button"
                      className={css.closeButton}
                      onClick={closeRun}
                      aria-label="关闭运行详情"
                    >
                      ×
                    </button>
                  </div>
                  {detail?.ok === true && detail.run !== undefined ? (
                    <div className={css.detailBody}>
                      <dl className={css.detailGrid}>
                        <div>
                          <dt>运行 ID</dt>
                          <dd>{detail.run.runId}</dd>
                        </div>
                        <div>
                          <dt>状态</dt>
                          <dd>{detail.run.status}</dd>
                        </div>
                        <div>
                          <dt>自动化</dt>
                          <dd>{detail.run.automation.enabled ? '开启' : '关闭'} · {detail.run.automation.mode}</dd>
                        </div>
                      </dl>
                      {detail.run.currentIssue !== undefined && (
                        <section className={css.detailSection}>
                          <h4>当前 Issue</h4>
                          <p className={css.detailIssue}>{detail.run.currentIssue.key}</p>
                          {detail.run.currentIssue.phase !== undefined && (
                            <p>阶段：{detail.run.currentIssue.phase}</p>
                          )}
                          {detail.run.currentIssue.workDir !== undefined && (
                            <p className={css.mono}>{detail.run.currentIssue.workDir}</p>
                          )}
                          {detail.run.currentIssue.branch !== undefined && (
                            <p className={css.mono}>{detail.run.currentIssue.branch}</p>
                          )}
                        </section>
                      )}
                      <section className={css.detailSection}>
                        <h4>操作</h4>
                        {detail.run.allowedActions.length > 0 ? (
                          <div className={css.actions}>
                            {detail.run.allowedActions.map((action) => {
                              const label = ACTION_LABELS[action] ?? action
                              if (pendingAction === action) {
                                return (
                                  <div key={action} className={css.confirm}>
                                    <span className={css.confirmText}>确认{label}？</span>
                                    <button
                                      type="button"
                                      className={css.confirmButton}
                                      disabled={sendingAction}
                                      onClick={() => void confirmAction(action)}
                                    >
                                      确认
                                    </button>
                                    <button
                                      type="button"
                                      className={css.cancelButton}
                                      disabled={sendingAction}
                                      onClick={() => setPendingAction(null)}
                                    >
                                      返回
                                    </button>
                                  </div>
                                )
                              }
                              return (
                                <button
                                  key={action}
                                  type="button"
                                  className={css.actionButton}
                                  onClick={() => setPendingAction(action)}
                                >
                                  {label}
                                </button>
                              )
                            })}
                          </div>
                        ) : (
                          <p className={css.empty}>无可执行操作</p>
                        )}
                        {actionError !== null && <p className={css.actionError} role="alert">{actionError}</p>}
                      </section>
                      <section className={css.detailSection}>
                        <h4>最近事件</h4>
                        {detail.run.recentEvents.length > 0 ? (
                          <ul className={css.events}>
                            {detail.run.recentEvents.slice().reverse().map((event) => (
                              <li key={`${event.runId}:${event.seq}`}>
                                <span className={css.eventKind}>{event.kind}</span>
                                {event.summary !== undefined && (
                                  <span className={css.eventSummary}>{event.summary}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className={css.empty}>暂无事件</p>
                        )}
                      </section>
                    </div>
                  ) : (
                    <p className={css.empty}>详情不可用</p>
                  )}
                </aside>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
