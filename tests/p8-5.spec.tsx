/**
 * P8.5 browser run console tests: the board card opens a run-detail drawer,
 * action buttons are rendered from allowedActions, commands and human
 * decisions require confirmation before being sent, and failures are shown
 * inline.
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

const runDetailBody = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  run: {
    runId: 'run-0001',
    status: 'READY',
    automation: { enabled: false, mode: 'manual' },
    allowedActions: ['pause', 'cancel'],
    recentEvents: [
      { seq: 1, at: 1, runId: 'run-0001', kind: 'run.updated', summary: 'created' },
    ],
    ...overrides,
  },
})

describe('TaskFlowStatus P8.5 run console', () => {
  beforeEach(() => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({
          ok: true,
          runs: [{ id: 'run-0001', status: 'READY', title: '任务' }],
        }))
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
      if (url === '/plugins/taskflow/run?runId=run-0001') {
        return Promise.resolve(jsonResponse(runDetailBody()))
      }
      if (url === '/plugins/taskflow/command' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; runId: string }
        if (body.action === 'fail') {
          return Promise.resolve(jsonResponse({ ok: false, error: 'taskflow: cannot fail' }))
        }
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (url === '/plugins/taskflow/human-decision' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true, runId: 'run-0001', status: 'ACCEPTED' }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  async function openDrawer(): Promise<void> {
    render(<TaskFlowStatus {...({} as TaskFlowStatusProps)} />)
    fireEvent.click(await screen.findByTestId('taskflow-chip'))
    fireEvent.click(await screen.findByTestId('taskflow-card-run-0001:issue-001'))
    await screen.findByRole('complementary', { name: '运行详情' })
  }

  it('opens the run detail drawer from a board card and renders allowedActions', async () => {
    await openDrawer()

    expect(await screen.findByText('run-0001')).toBeTruthy()
    expect(await screen.findByText('READY')).toBeTruthy()
    expect(await screen.findByText('暂停')).toBeTruthy()
    expect(await screen.findByText('取消')).toBeTruthy()
    expect(await screen.findByText('run.updated')).toBeTruthy()
  })

  it('does not send a command until the user confirms', async () => {
    await openDrawer()

    const cancelButton = await screen.findByRole('button', { name: '取消' })
    fireEvent.click(cancelButton)

    expect(await screen.findByText('确认取消？')).toBeTruthy()
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).not.toHaveBeenCalledWith('/plugins/taskflow/command', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ runId: 'run-0001', action: 'cancel' }),
    }))

    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/plugins/taskflow/command', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ runId: 'run-0001', action: 'cancel' }),
      }))
    })
    await waitFor(() => {
      expect(screen.queryByText('确认取消？')).toBeNull()
    })
  })

  it('sends human decisions to /human-decision after confirmation', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({
          ok: true,
          runs: [{ id: 'run-0001', status: 'AWAITING_HUMAN', title: '任务' }],
        }))
      }
      if (url === '/plugins/taskflow/board') {
        return Promise.resolve(jsonResponse({
          ok: true,
          columns: [
            {
              id: 'review',
              title: '待审查',
              cards: [
                {
                  runId: 'run-0001',
                  runTitle: '任务',
                  runStatus: 'AWAITING_HUMAN',
                  issueKey: 'issue-001',
                  acceptance: '验收 A',
                  deps: [],
                  status: 'done',
                  summary: '完成',
                },
              ],
            },
          ],
        }))
      }
      if (url === '/plugins/taskflow/run?runId=run-0001') {
        return Promise.resolve(jsonResponse(runDetailBody({
          status: 'AWAITING_HUMAN',
          allowedActions: ['accept', 'rework', 'cancel'],
        })))
      }
      if (url === '/plugins/taskflow/human-decision' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true, runId: 'run-0001', status: 'ACCEPTED' }))
      }
      if (url === '/plugins/taskflow/command' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    await openDrawer()
    fireEvent.click(await screen.findByRole('button', { name: '通过' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/plugins/taskflow/human-decision', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ runId: 'run-0001', decision: 'accept' }),
      }))
    })
  })

  it('shows the server error inline when an action fails', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/plugins/taskflow/state') {
        return Promise.resolve(jsonResponse({
          ok: true,
          runs: [{ id: 'run-0001', status: 'READY', title: '任务' }],
        }))
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
      if (url === '/plugins/taskflow/run?runId=run-0001') {
        return Promise.resolve(jsonResponse(runDetailBody({ allowedActions: ['fail'] })))
      }
      if (url === '/plugins/taskflow/command' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: false, error: 'taskflow: cannot fail' }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    await openDrawer()
    fireEvent.click(await screen.findByRole('button', { name: 'fail' }))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    expect(await screen.findByText('taskflow: cannot fail')).toBeTruthy()
  })
})
