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

describe('TaskFlowStatus', () => {
  beforeEach(() => {
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
})
