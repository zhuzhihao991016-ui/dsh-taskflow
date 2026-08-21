import { describe, expect, it, vi } from 'vitest'
import { CodexCliBridge, parseCodexModelCatalog, type CodexLoginLauncher } from '../src/codex-cli.ts'
import type { ProcessExecutor, ProcessResult } from '../src/planner.ts'

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  }
}

const catalog = JSON.stringify({
  models: [
    {
      slug: 'gpt-visible',
      display_name: 'GPT Visible',
      description: 'visible model',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low', description: 'fast' },
        { effort: 'medium', description: 'balanced' },
        { effort: 'ultra', description: 'delegated' },
      ],
      visibility: 'list',
      supported_in_api: true,
    },
    {
      slug: 'gpt-hidden',
      display_name: 'GPT Hidden',
      default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'high', description: '' }],
      visibility: 'hide',
      supported_in_api: true,
    },
  ],
})

describe('Codex CLI settings bridge', () => {
  it('projects only visible model choices and supported reasoning levels', () => {
    expect(parseCodexModelCatalog(catalog)).toEqual([
      {
        slug: 'gpt-visible',
        displayName: 'GPT Visible',
        description: 'visible model',
        defaultReasoningEffort: 'medium',
        reasoningEfforts: [
          { effort: 'low', description: 'fast' },
          { effort: 'medium', description: 'balanced' },
          { effort: 'ultra', description: 'delegated' },
        ],
      },
    ])
  })

  it('uses the live catalog, caches it, and refreshes on demand', async () => {
    const executor: ProcessExecutor = { run: vi.fn(async () => result({ stdout: catalog })) }
    const bridge = new CodexCliBridge(() => 'codex.js', executor, vi.fn(), () => 100, 'C:/repo')

    expect(await bridge.listModels()).toMatchObject({ source: 'live', cached: false })
    expect(await bridge.listModels()).toMatchObject({ source: 'live', cached: true })
    expect(await bridge.listModels(true)).toMatchObject({ source: 'live', cached: false })
    expect(executor.run).toHaveBeenCalledTimes(2)
    expect(vi.mocked(executor.run).mock.calls[0]?.[0].command).toEqual([
      'codex.js', 'debug', 'models',
    ])
  })

  it('falls back to the bundled catalog when live discovery fails', async () => {
    const run = vi.fn()
    run.mockResolvedValueOnce(result({ exitCode: 1, stderr: 'network failure' }))
    run.mockResolvedValueOnce(result({ stdout: catalog }))
    const executor: ProcessExecutor = { run }
    const bridge = new CodexCliBridge(() => 'codex.js', executor, vi.fn(), () => 100, 'C:/repo')

    expect(await bridge.listModels()).toMatchObject({ source: 'bundled', cached: false })
    expect(run.mock.calls[1]?.[0].command).toEqual([
      'codex.js', 'debug', 'models', '--bundled',
    ])
  })

  it('returns only boolean auth state and explicitly launches browser login', async () => {
    const executor: ProcessExecutor = { run: vi.fn(async () => result()) }
    const launcher: CodexLoginLauncher = vi.fn(async () => {})
    const bridge = new CodexCliBridge(() => 'codex.js', executor, launcher, () => 100, 'C:/repo')

    await expect(bridge.authStatus()).resolves.toEqual({ available: true, authenticated: true })
    expect(vi.mocked(executor.run).mock.calls[0]?.[0].command).toEqual([
      'codex.js', 'login', 'status',
    ])

    await bridge.login()
    expect(launcher).toHaveBeenCalledWith({
      command: ['codex.js', 'login'],
      cwd: 'C:/repo',
    })
  })
})
