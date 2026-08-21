/** Read-only Codex CLI discovery plus the explicit browser-login launcher. */

import { spawn } from 'node:child_process'
import {
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
} from './codex-profile.ts'
import {
  resolveCodexCli,
  resolveCodexSpawnTarget,
  spawnCodexProcess,
  type ProcessExecutor,
} from './planner.ts'

const MODEL_DISCOVERY_TIMEOUT_MS = 20_000
const AUTH_STATUS_TIMEOUT_MS = 10_000
const MODEL_CACHE_TTL_MS = 60_000
const MODEL_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const STATUS_OUTPUT_LIMIT_BYTES = 64 * 1024

export type CodexModelSource = 'live' | 'bundled'

export interface CodexReasoningOption {
  effort: CodexReasoningEffort
  description: string
}

/** A deliberately small, non-sensitive projection of one CLI catalog row. */
export interface CodexModelOption {
  slug: string
  displayName: string
  description: string
  defaultReasoningEffort: CodexReasoningEffort
  reasoningEfforts: CodexReasoningOption[]
}

export interface CodexModelList {
  source: CodexModelSource
  cached: boolean
  models: CodexModelOption[]
}

export interface CodexAuthStatus {
  available: boolean
  authenticated: boolean
}

export class CodexCliError extends Error {
  constructor(readonly code: 'models-unavailable' | 'login-launch-failed', message: string) {
    super('taskflow: Codex CLI ' + message)
    this.name = 'CodexCliError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textField(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === 'string' ? record[field] as string : ''
}

function reasoningOptions(record: Record<string, unknown>): CodexReasoningOption[] {
  const rows = record.supported_reasoning_levels
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const options: CodexReasoningOption[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const effort = textField(row, 'effort')
    if (!CODEX_REASONING_EFFORTS.includes(effort as CodexReasoningEffort) || seen.has(effort)) continue
    seen.add(effort)
    options.push({
      effort: effort as CodexReasoningEffort,
      description: textField(row, 'description'),
    })
  }
  return options
}

/** Parse the current `codex debug models` JSON without retaining raw catalog data. */
export function parseCodexModelCatalog(text: string): CodexModelOption[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch {
    throw new CodexCliError('models-unavailable', '模型目录不是有效 JSON')
  }
  const rows = isRecord(decoded) && Array.isArray(decoded.models) ? decoded.models : []
  const seen = new Set<string>()
  const models: CodexModelOption[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const slug = textField(row, 'slug')
    if (slug === '' || seen.has(slug) || row.visibility === 'hide' || row.supported_in_api === false) continue
    const options = reasoningOptions(row)
    const catalogDefault = textField(row, 'default_reasoning_level') as CodexReasoningEffort
    const defaultReasoningEffort = options.some(option => option.effort === catalogDefault)
      ? catalogDefault
      : options[0]?.effort ?? 'medium'
    seen.add(slug)
    models.push({
      slug,
      displayName: textField(row, 'display_name') || slug,
      description: textField(row, 'description'),
      defaultReasoningEffort,
      reasoningEfforts: options,
    })
  }
  if (models.length === 0) {
    throw new CodexCliError('models-unavailable', '模型目录中没有可选择的模型')
  }
  return models
}

export interface CodexLoginLaunchRequest {
  command: readonly string[]
  cwd: string
}

export type CodexLoginLauncher = (request: CodexLoginLaunchRequest) => Promise<void>

/** Launch `codex login` independently so its OAuth callback server survives the HTTP request. */
export const launchDetachedCodexLogin: CodexLoginLauncher = async ({ command, cwd }) => {
  const target = resolveCodexSpawnTarget(command)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(target.file, target.args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}

interface CatalogCache {
  cliPath: string
  expiresAt: number
  value: Omit<CodexModelList, 'cached'>
}

/** Runtime bridge used by the loopback HTTP routes. */
export class CodexCliBridge {
  private cache: CatalogCache | undefined

  constructor(
    private readonly cliPath: () => string | undefined,
    private readonly executor: ProcessExecutor = spawnCodexProcess,
    private readonly loginLauncher: CodexLoginLauncher = launchDetachedCodexLogin,
    private readonly now: () => number = Date.now,
    private readonly cwd: string = process.cwd(),
  ) {}

  private resolvedCliPath(): string {
    const configured = this.cliPath()?.trim()
    return configured !== undefined && configured !== '' ? configured : resolveCodexCli()
  }

  async listModels(refresh = false): Promise<CodexModelList> {
    const cliPath = this.resolvedCliPath()
    if (!refresh && this.cache?.cliPath === cliPath && this.cache.expiresAt > this.now()) {
      return { ...this.cache.value, cached: true }
    }
    let value: Omit<CodexModelList, 'cached'> | undefined
    try {
      value = { source: 'live', models: await this.readModels(cliPath, false) }
    } catch {
      try {
        value = { source: 'bundled', models: await this.readModels(cliPath, true) }
      } catch {
        throw new CodexCliError('models-unavailable', '无法读取模型列表')
      }
    }
    this.cache = { cliPath, expiresAt: this.now() + MODEL_CACHE_TTL_MS, value }
    return { ...value, cached: false }
  }

  async authStatus(): Promise<CodexAuthStatus> {
    try {
      const result = await this.executor.run({
        command: [this.resolvedCliPath(), 'login', 'status'],
        cwd: this.cwd,
        stdinText: '',
        timeoutMs: AUTH_STATUS_TIMEOUT_MS,
        maxOutputBytes: STATUS_OUTPUT_LIMIT_BYTES,
      })
      if (result.timedOut || result.outputLimitExceeded === true) {
        return { available: false, authenticated: false }
      }
      return { available: true, authenticated: result.exitCode === 0 }
    } catch {
      return { available: false, authenticated: false }
    }
  }

  async login(): Promise<void> {
    try {
      await this.loginLauncher({
        command: [this.resolvedCliPath(), 'login'],
        cwd: this.cwd,
      })
    } catch {
      throw new CodexCliError('login-launch-failed', '无法启动登录流程')
    }
  }

  private async readModels(cliPath: string, bundled: boolean): Promise<CodexModelOption[]> {
    const result = await this.executor.run({
      command: [cliPath, 'debug', 'models', ...(bundled ? ['--bundled'] : [])],
      cwd: this.cwd,
      stdinText: '',
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
      maxOutputBytes: MODEL_OUTPUT_LIMIT_BYTES,
    })
    if (result.timedOut || result.outputLimitExceeded === true || result.exitCode !== 0) {
      throw new CodexCliError('models-unavailable', '模型目录命令失败')
    }
    return parseCodexModelCatalog(result.stdout)
  }
}
