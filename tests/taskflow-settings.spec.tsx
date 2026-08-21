/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { TaskFlowSettings, type TaskFlowSettingsValue } from '../src/client/TaskFlowSettings.tsx'

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function settingsScope(persist = true) {
  let value: TaskFlowSettingsValue = {
    announceToAgent: true,
    enabled: true,
    allowedRepoRoots: ['C:/repo'],
    codexCliPath: '',
    codexPlanningModel: 'gpt-5.6-sol',
    codexPlanningEffort: 'max',
    codexCheckpointModel: 'gpt-5.6-sol',
    codexCheckpointEffort: 'medium',
    codexFinalModel: 'gpt-5.6-sol',
    codexFinalEffort: 'max',
    maxConcurrent: 1,
    integrationBranch: 'taskflow/integration',
    worktreesRoot: '',
    automationEnabled: true,
    autoPlan: true,
    autoReview: true,
    maxExecutorProcesses: 2,
    maxReviewCycles: 3,
    requireExecutionPermission: true,
    teamBoardSync: true,
    teamBoardTaskPrefix: '[taskflow]',
    teamBoardOwner: '',
  }
  const listeners = new Set<() => void>()
  let snapshot: ReturnType<SettingsScope<TaskFlowSettingsValue>['getSnapshot']> = {
    status: 'ready',
    value,
    base: value,
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const set = vi.fn(async (field: string, next: unknown) => {
    if (!persist) return
    value = { ...value, [field]: next }
    snapshot = {
      ...snapshot,
      value,
      user: { ...(snapshot.user as Record<string, unknown>), [field]: next },
      revision: (snapshot.revision ?? 0) + 1,
    }
    for (const listener of listeners) listener()
  })
  const scope: SettingsScope<TaskFlowSettingsValue> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set,
    unset: vi.fn(async () => {}),
  }
  return { scope, set }
}

describe('TaskFlowSettings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/plugins/taskflow/codex/models')) {
        return Promise.resolve(jsonResponse({
          ok: true,
          source: 'live',
          cached: false,
          models: [
            {
              slug: 'gpt-5.6-sol',
              displayName: 'GPT-5.6-Sol',
              description: '',
              defaultReasoningEffort: 'medium',
              reasoningEfforts: [
                { effort: 'medium', description: '' },
                { effort: 'max', description: '' },
              ],
            },
            {
              slug: 'gpt-alt',
              displayName: 'GPT Alt',
              description: '',
              defaultReasoningEffort: 'low',
              reasoningEfforts: [{ effort: 'low', description: '' }],
            },
          ],
        }))
      }
      if (url === '/plugins/taskflow/codex/auth') {
        return Promise.resolve(jsonResponse({ ok: true, available: true, authenticated: true }))
      }
      if (url === '/plugins/taskflow/codex/login' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true, launched: true }))
      }
      return Promise.reject(new Error('unexpected fetch ' + url))
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('saves a scene-specific model and supported effort', async () => {
    const { scope, set } = settingsScope()
    render(<TaskFlowSettings settings={scope} />)
    fireEvent.click(screen.getByText('Taskflow'))

    await screen.findByText('模型来源：在线目录')
    const modelInputs = screen.getAllByLabelText('模型')
    fireEvent.change(modelInputs[0]!, { target: { value: 'gpt-alt' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() => {
      expect(set).toHaveBeenCalledWith('codexPlanningModel', 'gpt-alt')
      expect(set).toHaveBeenCalledWith('codexPlanningEffort', 'low')
    })
  })

  it('launches login only after the explicit button click', async () => {
    const { scope } = settingsScope()
    render(<TaskFlowSettings settings={scope} />)
    fireEvent.click(screen.getByText('Taskflow'))
    const fetchMock = vi.mocked(fetch)

    expect(fetchMock).not.toHaveBeenCalledWith('/plugins/taskflow/codex/login', expect.anything())
    fireEvent.click(await screen.findByRole('button', { name: '打开 Codex 登录' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/plugins/taskflow/codex/login', expect.objectContaining({
        method: 'POST',
        body: '{}',
      }))
    })
    expect(await screen.findByText(/已打开 Codex 登录流程/)).toBeTruthy()
  })

  it('does not report success when the settings provider recovers without persisting', async () => {
    const { scope } = settingsScope(false)
    render(<TaskFlowSettings settings={scope} />)
    fireEvent.click(screen.getByText('Taskflow'))

    await screen.findByText('模型来源：在线目录')
    fireEvent.change(screen.getAllByLabelText('模型')[0]!, { target: { value: 'gpt-alt' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    expect(await screen.findByText('设置保存失败，请刷新后重试。')).toBeTruthy()
  })
})
