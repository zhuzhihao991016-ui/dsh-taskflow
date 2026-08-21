/**
 * P6 client interaction tests for the taskflow status chip and board popover.
 * Uses jsdom + Testing Library; fetch is stubbed so the component exercises
 * its real open/close/poll/render lifecycle without a host.
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaskFlowStatus, type TaskFlowStatusProps } from '../src/client/TaskFlowStatus.tsx'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response
}

/** Minimal EventSource fake used to verify the SSE lifecycle contract:
 * errors must not close the stream, unmount must. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  listeners = new Map<string, Set<() => void>>()
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(kind: string, handler: () => void): void {
    const set = this.listeners.get(kind) ?? new Set<() => void>()
    set.add(handler)
    this.listeners.set(kind, set)
  }

  close(): void {
    this.closed = true
  }
}

describe('TaskFlowStatus', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({ ok: true, runs: [] }))
      }
      if (url === '/plugins/taskflow/board') {
        return Promise.resolve(jsonResponse({
          ok: true,
          columns: [
            {
              id: 'todo',
              title: '待办',
              cards: [
                {
                  runId: 'run-0001',
                  runTitle: '任务',
                  runStatus: 'READY',
                  issueKey: 'issue-001',
                  acceptance: '验收 A',
                  deps: [],
                  status: 'pending',
                },
              ],
            },
          ],
        }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders the status chip', async () => {
    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)
    await waitFor(() => {
      expect(screen.getByTestId('taskflow-chip')).toBeTruthy()
    })
  })

  it('opens the board popover and renders kanban cards', async () => {
    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)
    fireEvent.click(await screen.findByTestId('taskflow-chip'))

    expect(await screen.findByText('任务流看板')).toBeTruthy()
    expect(await screen.findByText('待办')).toBeTruthy()
    expect(await screen.findByText('issue-001')).toBeTruthy()
  })

  it('closes the board popover on Escape', async () => {
    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)
    fireEvent.click(await screen.findByTestId('taskflow-chip'))
    const board = await screen.findByRole('dialog', { name: '任务流看板' })

    fireEvent.keyDown(board, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByText('任务流看板')).toBeNull()
    })
  })

  it('does not count a RECEIVED run as running', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({
          ok: true,
          runs: [{ id: 'run-0001', status: 'RECEIVED', title: '任务' }],
        }))
      }
      if (url === '/plugins/taskflow/board') {
        return Promise.resolve(jsonResponse({ ok: true, columns: [] }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)

    await waitFor(() => {
      expect(screen.queryByText('taskflow · 1 个运行中')).toBeNull()
    })
    expect(screen.getByText('taskflow')).toBeTruthy()
  })

  it('does not count an EXECUTING run without a running execution as running', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({
          ok: true,
          runs: [{
            id: 'run-0001',
            status: 'EXECUTING',
            title: '任务',
            executions: [{ status: 'done' }],
          }],
        }))
      }
      if (url === '/plugins/taskflow/board') {
        return Promise.resolve(jsonResponse({ ok: true, columns: [] }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)

    await waitFor(() => {
      expect(screen.queryByText('taskflow · 1 个运行中')).toBeNull()
    })
    expect(screen.getByText('taskflow')).toBeTruthy()
  })

  it('counts an EXECUTING run with a running execution as running', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({
          ok: true,
          runs: [{
            id: 'run-0001',
            status: 'EXECUTING',
            title: '任务',
            executions: [{ status: 'running' }],
          }],
        }))
      }
      if (url === '/plugins/taskflow/board') {
        return Promise.resolve(jsonResponse({ ok: true, columns: [] }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)

    await waitFor(() => {
      expect(screen.getByText('taskflow · 1 个运行中')).toBeTruthy()
    })
  })

  it('keeps EventSource open on errors and closes it on unmount', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({ ok: true, runs: [] }))
      }
      if (url === '/plugins/taskflow/board') {
        return Promise.resolve(jsonResponse({
          ok: true,
          columns: [
            {
              id: 'todo',
              title: '待办',
              cards: [
                {
                  runId: 'run-0001',
                  runTitle: '任务',
                  runStatus: 'READY',
                  issueKey: 'issue-001',
                  acceptance: '验收 A',
                  deps: [],
                  status: 'pending',
                },
              ],
            },
          ],
        }))
      }
      if (url.startsWith('/plugins/taskflow/run?runId=')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          run: {
            runId: 'run-0001',
            status: 'READY',
            automation: { enabled: true, mode: 'automatic' },
            allowedActions: [],
            recentEvents: [],
          },
        }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    const { unmount } = render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0)
    })
    const globalSource = FakeEventSource.instances[0]!

    fireEvent.click(await screen.findByTestId('taskflow-chip'))
    fireEvent.click(await screen.findByTestId('taskflow-card-run-0001:issue-001'))
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2)
    })
    const runSource = FakeEventSource.instances[1]!

    // An EventSource error must not close the stream so the browser can
    // reconnect; the component only closes on unmount.
    for (const source of [globalSource, runSource]) {
      expect(source.onerror).toBeNull()
      expect(source.closed).toBe(false)
      source.onerror?.()
      expect(source.closed).toBe(false)
    }

    unmount()
    expect(globalSource.closed).toBe(true)
    expect(runSource.closed).toBe(true)
  })
})
