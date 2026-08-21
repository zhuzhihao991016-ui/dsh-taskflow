/**
 * dsh-taskflow host half: opens the taskflow storage domain, mounts the
 * orchestration service over its repository, registers the same-origin JSON
 * routes (/plugins/taskflow/state|board|submit|command|plan|execute|exec-result|review|human-decision),
 * and injects a model-facing announcement section. P5 adds DAG parallel
 * execution with Git worktree isolation (maxConcurrent, per-issue worktrees,
 * auto-merge to an integration branch) on top of the P4 Codex review gate;
 * P6 adds the read-only kanban board projection; P7 adds the final human
 * acceptance gate and closes the loop for pilot runs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { TASKFLOW_DOMAIN } from './domain.ts'
import { AUTOMATION_CONTROL_ACTIONS, EXECUTOR_PHASES, type TaskFlowEvent } from './contracts.ts'
import type { ExecutionResult } from './executor.ts'
import { CodexCliBridge } from './codex-cli.ts'
import {
  Config as TaskFlowConfigSchema,
  assertTaskFlowConfig,
  codexProfile,
  resolveTaskFlowConfig,
  type Config,
  type ResolvedConfig,
} from './config.ts'
import { CodexIssueExecutor } from './issue-executor.ts'
import { CodexPlanner } from './planner.ts'
import { DomainRepository } from './repository.ts'
import { CodexReviewer } from './reviewer.ts'
import { TaskFlowService, type CommandAction, type HumanDecision, type SubmitRequest } from './service.ts'
import { createTeamBoardSync, type TeamBoardService } from './team-board-sync.ts'

/** P8.2 public adapter exports. */
export { CodexIssueExecutor, CodexExecutor } from './issue-executor.ts'
export { Config } from './config.ts'
export type { CodexReasoningEffort, CodexScene } from './codex-profile.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Required services: systemPrompt for the announcement, storageDomain for the ledger. */
export const inject = ['systemPrompt', 'storageDomain']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASKFLOW_GUIDANCE = '本机已安装 dsh-taskflow 插件（DSH 全自动任务工作流编排）：任务提出后由 Codex CLI 规划拆分为 Issue 并发布看板，DSH 认领执行（串行/并行 + Git worktree 隔离）。每个 Issue 完成后先由 Codex CHECKPOINT（gpt-5.6-sol medium）做合并前方向审查；全部 Issue 完成后由 Codex FINAL（gpt-5.6-sol max）终审。审查可 CONTINUE、FIX 原地修复，或 REPLAN 携带 findings 返回规划，最终由人工验收。当前为 P8.6 阶段：运行台账已持久化，Codex 规划引擎已接入（提交时带 repoRoot 后经 /plugins/taskflow/plan 触发规划，规划通过后运行进入 READY 并携带 Issue 清单）；执行引擎已启用（经 /plugins/taskflow/execute 启动执行，READY → EXECUTING，按 DAG 依赖每次认领最多 maxConcurrent 个可调度 Issue，响应含 currentIssues；每个 Issue 在独立 Git worktree 中执行，workDir/branch 可从 state/execute 响应读取；完成 currentIssue 后经 /plugins/taskflow/exec-result 上报 { runId, issueKey, ok, summary|error }，成功提交后先执行 CHECKPOINT，CONTINUE 才自动合并到集成分支，全部完成后运行进入 INTEGRATION_REVIEW 并执行 FINAL）；P4 双阶段审查门已启用（自动 CHECKPOINT 负责逐步方向审查，/plugins/taskflow/review 仅在 INTEGRATION_REVIEW 手动触发 FINAL；PASS/CONTINUE 继续，REVISE/FIX 打回执行，REVISE/REPLAN 返回 PLANNING）；P6 看板已启用（GET /plugins/taskflow/board 返回五列看板快照，浏览器端状态卡片可打开看板）；P7 人工验收门已启用（POST /plugins/taskflow/human-decision 提交 { runId, decision: accept|rework }，accept 进入 ACCEPTED 终态，rework 回到 PLANNING 重新规划）；P8 自动化契约已冻结且默认开启（automationEnabled=true）；P8.1 已持久化控制元数据、进度事件与运行级 Git 隔离，并提供 GET /plugins/taskflow/run 详情投影与 pause/resume/takeover/release/retry 控制动作；P8.2 已内置 Codex Issue Executor（自动化开启时在独立 worktree 中以 workspace-write 非交互实现 Issue）；P8.3 已接入自动推进协调器（automationEnabled 开启且 autoPlan/autoReview 为 true 时自动完成规划、执行、逐步审查和最终审查），新增 GET /plugins/taskflow/events SSE 事件流，自动修复或重新规划达到 maxReviewCycles 时进入 WAITING_DECISION 人工介入窗口（可用 resume 继续）；P8.4 已接入自动执行授权门（requireExecutionPermission=true 时，规划完成后进入 WAITING_PERMISSION，人工 release 后自动继续执行）；P8.5 已接入浏览器运行台与介入窗口（看板卡片打开运行详情抽屉，经 /plugins/taskflow/run 与 run-scoped SSE 实时刷新，按 allowedActions 渲染操作按钮并二次确认后调用 /plugins/taskflow/command 或 /plugins/taskflow/human-decision）。若同 profile 安装了 team-board 插件，taskflow 看板会自动镜像到 ctx.teamBoard（teamBoardSync=false 可关闭）。用户提到「工作流 / 任务流 / taskflow」时即指本插件，请据此协作。'

export function buildTaskFlowGuidance(_config: ResolvedConfig): string {
  return TASKFLOW_GUIDANCE
    .replace(
      'Codex CHECKPOINT（gpt-5.6-sol medium）',
      'Codex CHECKPOINT（使用插件设置中的步审模型和思考强度）',
    )
    .replace(
      'Codex FINAL（gpt-5.6-sol max）',
      'Codex FINAL（使用插件设置中的终审模型和思考强度）',
    )
}

const TASKFLOW_SETTINGS_NAMESPACE = 'taskflow'

interface HostSettingsScope<T> {
  get(): T
}

interface HostSettingsProvider {
  register<T>(
    namespace: string,
    schema: typeof TaskFlowConfigSchema,
    options: {
      base: Partial<T>
      applies: 'restart'
      validate: (value: T) => void
    },
  ): HostSettingsScope<T>
}

/** Resolve an optional Cordis service without declaration-merging its provider package. */
function optionalService(scope: Context, name: string): unknown {
  return (scope as unknown as { get(service: string): unknown }).get(name)
}

/** Register the Taskflow settings namespace when the Host settings seam is present. */
function installTaskFlowSettings(scope: Context, entry: ResolvedConfig): () => ResolvedConfig {
  let source: () => Config = () => entry
  const attach = (ownerScope: Context, settings: HostSettingsProvider): void => {
    const owner = settings.register<Config>(
      TASKFLOW_SETTINGS_NAMESPACE,
      TaskFlowConfigSchema,
      {
        base: entry,
        applies: 'restart',
        validate: assertTaskFlowConfig,
      },
    )
    source = () => owner.get()
    ownerScope.effect(() => () => {
      source = () => entry
    }, 'dsh-taskflow: settings source')
  }
  const settings = optionalService(scope, 'settings') as HostSettingsProvider | undefined
  if (settings !== undefined && typeof settings.register === 'function') {
    attach(scope, settings)
  } else {
    scope.inject(['settings'], (settingsScope: Context) => {
      const available = optionalService(settingsScope, 'settings') as HostSettingsProvider | undefined
      if (available !== undefined && typeof available.register === 'function') {
        attach(settingsScope, available)
      }
    })
  }
  return () => resolveTaskFlowConfig(source())
}

/** JSON response writer (same-origin routes; no secrets ever enter bodies). */
function sendJson(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/** Whether an error is a client (validation/state) error with a stable taskflow: message. */
function isClientError(error: unknown): boolean {
  return (error as Error).message.startsWith('taskflow:')
}

/** Map a thrown error to its HTTP status: 4xx for client errors, 500 for the rest. */
function errorStatus(error: unknown): number {
  return isClientError(error) ? 400 : 500
}

/**
 * Parse a Host header into its lowercase hostname and optional port, or null
 * when the value is malformed. Accepts `localhost`, `127.x.x.x`, bracketed
 * IPv6 (`[::1]:port`) and the bare `::1` loopback form; rejects embedded
 * credentials, paths, whitespace, extra hosts and invalid ports.
 */
function parseHostHeader(host: string | undefined): { hostname: string; port?: string } | null {
  if (host === undefined) return null
  const raw = host.trim()
  if (
    raw === ''
    || raw !== host
    || /\s/.test(raw)
    || raw.includes('@')
    || raw.includes('/')
    || raw.includes('\\')
    || raw.includes(',')
  ) {
    return null
  }
  let hostname: string
  let port: string | undefined
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close <= 1) return null
    hostname = raw.slice(1, close)
    const suffix = raw.slice(close + 1)
    if (suffix === '') {
      port = undefined
    } else if (suffix.startsWith(':')) {
      port = suffix.slice(1)
    } else {
      return null
    }
  } else {
    const firstColon = raw.indexOf(':')
    if (firstColon === -1) {
      hostname = raw
      port = undefined
    } else if (raw.indexOf(':', firstColon + 1) !== -1) {
      // Bare IPv6 is only accepted for the exact loopback form; anything else
      // must use the bracketed syntax.
      if (raw !== '::1') return null
      hostname = raw
      port = undefined
    } else {
      hostname = raw.slice(0, firstColon)
      port = raw.slice(firstColon + 1)
    }
  }
  if (hostname === '') return null
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) > 65535)) return null
  return { hostname: hostname.toLowerCase(), port }
}

/** Whether a hostname or socket address belongs to the loopback network. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true
  if (hostname.startsWith('::ffff:')) {
    return isMappedLoopback(hostname.slice('::ffff:'.length))
  }
  return isDottedLoopback(hostname)
}

/** Whether a dotted-quad address is within 127.0.0.0/8. */
function isDottedLoopback(address: string): boolean {
  if (!/^127(?:\.\d{1,3}){3}$/.test(address)) return false
  return address.split('.').every((part) => Number(part) <= 255)
}

/**
 * Whether the remainder after the `::ffff:` prefix is an IPv4-mapped 127/8
 * address: either the dotted quad `127.a.b.c` or canonical hex with the first
 * group in `7f00`..`7fff`. Other mapped values are not loopback.
 */
function isMappedLoopback(address: string): boolean {
  if (isDottedLoopback(address)) return true
  const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(address)
  if (hex === null) return false
  const high = Number.parseInt(hex[1], 16)
  return high >= 0x7f00 && high <= 0x7fff
}

/** Whether an Origin header value is strictly same-origin with the Host. */
function originMatchesHost(
  origin: string | undefined,
  host: { hostname: string; port?: string },
  requestProtocol: 'http:' | 'https:',
): boolean {
  if (origin === undefined) return true
  if (origin === 'null') return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== requestProtocol) return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return false
  let originHostname = parsed.hostname.toLowerCase()
  if (originHostname.startsWith('[') && originHostname.endsWith(']')) {
    originHostname = originHostname.slice(1, -1)
  }
  const defaultPort = requestProtocol === 'http:' ? '80' : '443'
  const originPort = parsed.port === '' ? defaultPort : parsed.port
  const hostPort = host.port ?? defaultPort
  return originHostname === host.hostname && originPort === hostPort
}

/**
 * Reject requests that are not loopback JSON POSTs. The host binds loopback by
 * default but may be exposed on 0.0.0.0, and a CORS-safelisted text/plain POST
 * would otherwise mutate the ledger without a preflight. DNS rebinding and
 * forged Host headers are blocked by requiring a loopback Host (and, when a
 * socket address is available, a loopback peer); browser requests must also
 * carry an Origin that is strictly same-origin with the Host. Local
 * non-browser clients (CLI/DSH) may omit Origin.
 * @returns an error message when the request is rejected, else undefined.
 */
export function guardMutation(req: IncomingMessage): string | undefined {
  if (req.method !== 'POST') {
    return 'taskflow: mutation routes require POST'
  }
  const contentType = req.headers['content-type'] ?? ''
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return 'taskflow: mutation routes require application/json'
  }
  // Test shims and Unix-domain sockets may not expose a remote address; real
  // TCP requests always do, and non-loopback peers are rejected.
  const remoteAddress = req.socket?.remoteAddress
  if (remoteAddress !== undefined && !isLoopbackHostname(remoteAddress)) {
    return 'taskflow: non-loopback connection rejected'
  }
  const host = parseHostHeader(req.headers.host)
  if (host === null || !isLoopbackHostname(host.hostname)) {
    return 'taskflow: non-loopback host rejected'
  }
  const requestProtocol = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true
    ? 'https:'
    : 'http:'
  if (!originMatchesHost(req.headers.origin, host, requestProtocol)) {
    return 'taskflow: cross-origin request rejected'
  }
  return undefined
}

/** Read a JSON request body with a hard size cap. */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('taskflow: request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error as Error)
      }
    })
    req.on('error', reject)
  })
}

/** POST /plugins/taskflow/submit — create a run from { title, description?, repoRoot?, idempotencyKey? }. */
function handleSubmit(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const request = (body ?? {}) as Partial<SubmitRequest>
    void service.submit({
      title: request.title ?? '',
      description: request.description,
      repoRoot: request.repoRoot,
      idempotencyKey: request.idempotencyKey,
    }).then((run) => {
      sendJson(res, { ok: true, run })
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/plan — start planning { runId }; the flow continues in the background. */
function handlePlan(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const { runId } = (body ?? {}) as { runId?: string }
    if (typeof runId !== 'string' || runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: plan requires runId' }, 400)
      return
    }
    void service.plan(runId).then((result) => {
      sendJson(res, result.ok ? { ok: true, runId, status: result.status, alreadyPlanned: result.alreadyPlanned } : { ok: false, error: result.error }, result.ok ? 202 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/command — apply { runId, action } to a run. */
function handleCommand(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const { runId, action } = (body ?? {}) as { runId?: string; action?: CommandAction }
    if (typeof runId !== 'string' || runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: command requires runId' }, 400)
      return
    }
    if (typeof action !== 'string' || !(AUTOMATION_CONTROL_ACTIONS as readonly string[]).includes(action)) {
      sendJson(res, { ok: false, error: 'taskflow: unsupported action' }, 400)
      return
    }
    void service.command(runId, action).then((result) => {
      sendJson(res, result.ok ? { ok: true } : { ok: false, error: result.error }, result.ok ? 200 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/delete — remove a finished/stale run from the ledger and board. */
function handleDelete(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const { runId } = (body ?? {}) as { runId?: string }
    if (typeof runId !== 'string' || runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: delete requires runId' }, 400)
      return
    }
    void service.deleteRun(runId).then(() => {
      sendJson(res, { ok: true })
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

function publicCodexProfile(config: ResolvedConfig, scene: 'planning' | 'checkpoint' | 'final') {
  const { model, reasoningEffort } = codexProfile(config, scene)
  return { model, reasoningEffort }
}

const RESTART_CONFIG_FIELDS = [
  'announceToAgent',
  'enabled',
  'allowedRepoRoots',
  'maxConcurrent',
  'integrationBranch',
  'worktreesRoot',
  'automationEnabled',
  'autoPlan',
  'autoReview',
  'maxExecutorProcesses',
  'maxReviewCycles',
  'requireExecutionPermission',
  'teamBoardSync',
  'teamBoardTaskPrefix',
  'teamBoardOwner',
] as const satisfies readonly (keyof ResolvedConfig)[]

function pendingRestartFields(
  effective: ResolvedConfig,
  configured: ResolvedConfig,
): Array<(typeof RESTART_CONFIG_FIELDS)[number]> {
  return RESTART_CONFIG_FIELDS.filter(
    field => JSON.stringify(effective[field]) !== JSON.stringify(configured[field]),
  )
}

/** GET /plugins/taskflow/status — unified process/config/automation status entry. */
export function handleStatus(
  effectiveConfig: ResolvedConfig,
  configuredConfig: ResolvedConfig,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!requireGet(req, res, 'status')) return
  const pendingFields = pendingRestartFields(effectiveConfig, configuredConfig)
  sendJson(res, {
    ok: true,
    status: {
      pid: process.pid,
      plugin: 'dsh-taskflow',
      version: '0.1.0',
      enabled: effectiveConfig.enabled,
      hotReload: 'codex-next-invocation-workflow-restart',
      settings: {
        codexApplies: 'next-invocation',
        workflowApplies: 'restart',
        restartRequired: pendingFields.length > 0,
        pendingRestartFields: pendingFields,
      },
      automation: {
        enabled: effectiveConfig.automationEnabled,
        autoPlan: effectiveConfig.autoPlan,
        autoReview: effectiveConfig.autoReview,
        requireExecutionPermission: effectiveConfig.requireExecutionPermission,
        maxConcurrent: effectiveConfig.maxConcurrent,
        maxExecutorProcesses: effectiveConfig.maxExecutorProcesses,
        maxReviewCycles: effectiveConfig.maxReviewCycles,
      },
      codex: {
        planning: publicCodexProfile(configuredConfig, 'planning'),
        checkpoint: publicCodexProfile(configuredConfig, 'checkpoint'),
        final: publicCodexProfile(configuredConfig, 'final'),
      },
      allowedRepoRoots: effectiveConfig.allowedRepoRoots,
    },
  })
}

function requireGet(req: IncomingMessage, res: ServerResponse, route: string): boolean {
  if (req.method === 'GET') return true
  sendJson(res, { ok: false, error: 'taskflow: ' + route + ' requires GET' }, 405, { Allow: 'GET' })
  return false
}

/** GET /plugins/taskflow/codex/models — sanitized CLI model choices. */
export function handleCodexModels(bridge: CodexCliBridge, req: IncomingMessage, res: ServerResponse): void {
  if (!requireGet(req, res, 'codex models')) return
  const refresh = new URL(req.url ?? '', 'http://localhost').searchParams.get('refresh') === '1'
  void bridge.listModels(refresh).then((result) => {
    sendJson(res, { ok: true, ...result })
  }, () => {
    sendJson(res, { ok: false, error: 'taskflow: 无法读取 Codex 模型列表' }, 503)
  })
}

/** GET /plugins/taskflow/codex/auth — boolean auth status only, never account text. */
export function handleCodexAuth(bridge: CodexCliBridge, req: IncomingMessage, res: ServerResponse): void {
  if (!requireGet(req, res, 'codex auth')) return
  void bridge.authStatus().then((status) => {
    sendJson(res, { ok: true, ...status })
  }, () => {
    sendJson(res, { ok: true, available: false, authenticated: false })
  })
}

/** POST /plugins/taskflow/codex/login — explicitly launch browser OAuth. */
export function handleCodexLogin(bridge: CodexCliBridge, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 4 * 1024).then((body) => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, { ok: false, error: 'taskflow: login body must be an object' }, 400)
      return
    }
    void bridge.login().then(() => {
      sendJson(res, { ok: true, launched: true }, 202)
    }, () => {
      sendJson(res, { ok: false, error: 'taskflow: 无法启动 Codex 登录流程' }, 503)
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}


/** POST /plugins/taskflow/execute — start the serial execution of { runId }. */
function handleExecute(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const { runId } = (body ?? {}) as { runId?: string }
    if (typeof runId !== 'string' || runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: execute requires runId' }, 400)
      return
    }
    void service.startExecution(runId).then((result) => {
      sendJson(res, result.ok
        ? { ok: true, runId, status: result.status, alreadyExecuting: result.alreadyExecuting, currentIssue: result.currentIssue }
        : { ok: false, error: result.error }, result.ok ? 202 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/exec-result — report { runId, issueKey, ok, summary?, error? }. */
function handleExecResult(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const parsed = (body ?? {}) as { runId?: unknown; issueKey?: unknown; ok?: unknown; summary?: unknown; error?: unknown }
    if (typeof parsed.runId !== 'string' || parsed.runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: exec-result requires runId' }, 400)
      return
    }
    if (typeof parsed.issueKey !== 'string' || parsed.issueKey === '') {
      sendJson(res, { ok: false, error: 'taskflow: exec-result requires issueKey' }, 400)
      return
    }
    if (typeof parsed.ok !== 'boolean') {
      sendJson(res, { ok: false, error: 'taskflow: exec-result requires ok (boolean)' }, 400)
      return
    }
    const result: ExecutionResult = parsed.ok
      ? { ok: true, summary: typeof parsed.summary === 'string' ? parsed.summary : '' }
      : { ok: false, error: typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : 'execution failed' }
    void service.reportResult(parsed.runId, parsed.issueKey, result).then((report) => {
      sendJson(res, report.ok ? { ok: true } : { ok: false, error: report.error }, report.ok ? 200 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/progress — persist one P8.1 automated-executor progress event. */
export function handleProgress(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const parsed = (body ?? {}) as {
      runId?: unknown
      issueKey?: unknown
      attemptId?: unknown
      phase?: unknown
      summary?: unknown
      detail?: unknown
      at?: unknown
    }
    if (typeof parsed.runId !== 'string' || parsed.runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: progress requires runId' }, 400)
      return
    }
    if (typeof parsed.issueKey !== 'string' || parsed.issueKey === '') {
      sendJson(res, { ok: false, error: 'taskflow: progress requires issueKey' }, 400)
      return
    }
    if (typeof parsed.phase !== 'string' || !(EXECUTOR_PHASES as readonly string[]).includes(parsed.phase)) {
      sendJson(res, { ok: false, error: 'taskflow: progress requires a valid phase' }, 400)
      return
    }
    void service.recordProgress(parsed.runId, parsed.issueKey, {
      attemptId: typeof parsed.attemptId === 'string' ? parsed.attemptId : undefined,
      phase: parsed.phase as never,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
      at: typeof parsed.at === 'number' ? parsed.at : undefined,
    }).then((result) => {
      sendJson(res, result.ok
        ? { ok: true, seq: result.seq }
        : { ok: false, error: result.error }, result.ok ? 200 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/review — start the P4 Codex review gate for { runId }. */
function handleReview(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const { runId } = (body ?? {}) as { runId?: string }
    if (typeof runId !== 'string' || runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: review requires runId' }, 400)
      return
    }
    void service.startReview(runId).then((result) => {
      sendJson(res, result.ok
        ? { ok: true, runId, status: result.status, alreadyReviewing: result.alreadyReviewing, verdict: result.verdict }
        : { ok: false, error: result.error }, result.ok ? 202 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** POST /plugins/taskflow/human-decision — apply { runId, decision: accept|rework } (P7). */
export function handleHumanDecision(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  const guardError = guardMutation(req)
  if (guardError !== undefined) {
    sendJson(res, { ok: false, error: guardError }, 403)
    return
  }
  void readJsonBody(req, 64 * 1024).then((body) => {
    const parsed = (body ?? {}) as { runId?: unknown; decision?: unknown }
    if (typeof parsed.runId !== 'string' || parsed.runId === '') {
      sendJson(res, { ok: false, error: 'taskflow: human-decision requires runId' }, 400)
      return
    }
    if (parsed.decision !== 'accept' && parsed.decision !== 'rework') {
      sendJson(res, { ok: false, error: 'taskflow: human-decision requires decision (accept|rework)' }, 400)
      return
    }
    const decision: HumanDecision = parsed.decision
    void service.decideHuman(parsed.runId, decision).then((result) => {
      sendJson(res, result.ok
        ? { ok: true, runId: parsed.runId, status: result.status }
        : { ok: false, error: result.error }, result.ok ? 200 : 409)
    }, (error) => {
      sendJson(res, { ok: false, error: (error as Error).message }, errorStatus(error))
    })
  }, (error) => {
    sendJson(res, { ok: false, error: (error as Error).message }, 400)
  })
}

/** GET /plugins/taskflow/run?runId=... — P8.1 run-detail projection. */
export function handleRunDetail(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendJson(res, { ok: false, error: 'taskflow: run detail requires GET' }, 405, { Allow: 'GET' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const runId = url.searchParams.get('runId')
    ?? /\/plugins\/taskflow\/run\/([^/?]+)/.exec(url.pathname)?.[1]
  if (typeof runId !== 'string' || runId === '') {
    sendJson(res, { ok: false, error: 'taskflow: run detail requires runId' }, 400)
    return
  }
  const detail = service.runDetail(runId)
  if (detail === undefined) {
    sendJson(res, { ok: false, error: `taskflow: unknown run ${runId}` }, 404)
    return
  }
  sendJson(res, { ok: true, run: detail })
}

/** Alias for the P8.1 run-detail handler. */
export const handleRun = handleRunDetail

/** GET /plugins/taskflow/board — read-only board snapshot; non-GET rejected. */
export function handleBoard(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendJson(res, { ok: false, error: 'taskflow: board requires GET' }, 405, { Allow: 'GET' })
    return
  }
  sendJson(res, { ok: true, columns: service.board().columns })
}

/** Serialize one taskflow event as an SSE data frame. */
function sseEvent(event: TaskFlowEvent): string {
  return `event: ${event.kind}
data: ${JSON.stringify(event)}

`
}

/** Heartbeat cadence for the SSE channel (comment frames keep proxies and
 * EventSource clients from timing the stream out). */
const SSE_HEARTBEAT_MS = 15_000

/** GET /plugins/taskflow/events — P8.3 SSE channel for whitelisted taskflow
 * events. Optional `?runId=` filters to one run. On connect the most recent
 * events are replayed, then new durable events are streamed as they occur. */
export function handleEvents(service: TaskFlowService, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendJson(res, { ok: false, error: 'taskflow: events requires GET' }, 405, { Allow: 'GET' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const runId = url.searchParams.get('runId') ?? undefined
  const initial = service.list()
    .filter((run) => runId === undefined || run.id === runId)
    .flatMap((run) => run.events ?? [])
    .sort((a, b) => (a.at - b.at) || (a.seq - b.seq))
    .slice(-100)

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  })
  res.write(': connected\n\n')
  for (const event of initial) res.write(sseEvent(event))

  const unsubscribe = service.subscribeEvents((event) => {
    if (runId === undefined || event.runId === runId) {
      res.write(sseEvent(event))
    }
  })
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
    unsubscribe()
  }
  heartbeat = setInterval(() => {
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': heartbeat\n\n')
      } else {
        dispose()
      }
    } catch {
      dispose()
    }
  }, SSE_HEARTBEAT_MS)
  // Unref so a stranded test/CLI process is not kept alive by the channel;
  // real server sockets keep the process alive and the timer still fires.
  if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
    (heartbeat as { unref?: () => void }).unref?.()
  }
  res.on('close', dispose)
  res.on('error', dispose)
}

/**
 * Mount the host half: open the durable domain, assemble the service, then
 * register the announcement section and HTTP routes (routes only when the
 * web server service exists).
 * @param ctx - plugin context (systemPrompt + storageDomain injected).
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): Promise<void> {
  const entry = resolveTaskFlowConfig(config)
  const currentConfig = installTaskFlowSettings(ctx, entry)
  if (!currentConfig().enabled) {
    return Promise.resolve()
  }
  const fiber = ctx.inject(['systemPrompt', 'storageDomain'], async (scope: Context) => {
    const initial = currentConfig()
    if (!initial.enabled) return
    const domain = await scope.storageDomain.open(TASKFLOW_DOMAIN)
    // Return the close promise so lifecycle disposal awaits the domain drain
    // and the name frees before a potential reopen.
    scope.effect(() => () => domain.close(), 'dsh-taskflow: domain close')
    const planner = new CodexPlanner(
      undefined,
      undefined,
      undefined,
      undefined,
      () => codexProfile(currentConfig(), 'planning'),
    )
    const executor = initial.automationEnabled
      ? new CodexIssueExecutor(
          undefined,
          undefined,
          undefined,
          undefined,
          () => currentConfig().codexCliPath,
        )
      : undefined
    const reviewer = new CodexReviewer(
      undefined,
      undefined,
      undefined,
      undefined,
      stage => codexProfile(currentConfig(), stage === 'CHECKPOINT' ? 'checkpoint' : 'final'),
    )
    const codexCli = new CodexCliBridge(() => currentConfig().codexCliPath)
    const service = new TaskFlowService(
      new DomainRepository(domain),
      undefined,
      planner,
      initial.allowedRepoRoots,
      executor,
      reviewer,
      {
        maxConcurrent: initial.maxConcurrent,
        integrationBranch: initial.integrationBranch,
        worktreesRoot: initial.worktreesRoot.trim() || undefined,
        automationEnabled: initial.automationEnabled,
        maxExecutorProcesses: initial.maxExecutorProcesses,
        autoPlan: initial.autoPlan,
        autoReview: initial.autoReview,
        maxReviewCycles: initial.maxReviewCycles,
        requireExecutionPermission: initial.requireExecutionPermission,
      },
    )

    // Optional integration: mirror taskflow's board into the non-taskflow
    // team-board service. The nested inject starts and stops with the
    // team-board provider, so load order and provider reloads are handled by
    // Cordis instead of a one-time ctx.get() lookup.
    if (initial.teamBoardSync) {
      scope.inject(['teamBoard'], (teamScope: Context) => {
        const teamBoard = teamScope.get('teamBoard') as TeamBoardService
        const teamBoardPrefix = initial.teamBoardTaskPrefix.trim() || undefined
        const teamBoardOwner = initial.teamBoardOwner.trim() || undefined
        const disposeTeamBoardSync = createTeamBoardSync(service, teamBoard, {
          prefix: teamBoardPrefix,
          owner: teamBoardOwner,
        })
        teamScope.effect(() => disposeTeamBoardSync, 'dsh-taskflow: team-board sync')
      })
    }

    if (initial.announceToAgent) {
      scope.effect(() => scope.systemPrompt.section({
        name: 'plugin:taskflow',
        order: SECTION_ORDER,
        text: buildTaskFlowGuidance(initial),
      }), 'dsh-taskflow: guidance section')
    }

    // Resume any planning/execution/automation flows persisted across a host restart.
    service.resumePlanning()
    service.resumeExecution()
    service.resumeAutomation()

    // Nested inject: routes only when the web server exists. Deliberately not
    // returned — an async inject callback's resolved value is collected as an
    // effect and a Fiber would be rejected as an invalid effect.
    scope.inject(['webServer'], (webScope: Context) => {
      webScope.effect(() => {
        const disposeRoutes = [
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/state',
            handler: (_req, res) => {
              sendJson(res, { ok: true, runs: service.list() })
            },
          }),
          webScope.webServer.register({
              kind: 'exact',
            path: '/plugins/taskflow/status',
            handler: (req, res) => {
              handleStatus(initial, currentConfig(), req, res)
            },
            }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/codex/models',
            handler: (req, res) => {
              handleCodexModels(codexCli, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/codex/auth',
            handler: (req, res) => {
              handleCodexAuth(codexCli, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/codex/login',
            handler: (req, res) => {
              handleCodexLogin(codexCli, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/board',
            handler: (req, res) => {
              handleBoard(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/run',
            handler: (req, res) => {
              handleRunDetail(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/events',
            handler: (req, res) => {
              handleEvents(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/submit',
            handler: (req, res) => {
              handleSubmit(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/command',
            handler: (req, res) => {
              handleCommand(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/delete',
            handler: (req, res) => {
              handleDelete(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/plan',
            handler: (req, res) => {
              handlePlan(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/execute',
            handler: (req, res) => {
              handleExecute(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/exec-result',
            handler: (req, res) => {
              handleExecResult(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/progress',
            handler: (req, res) => {
              handleProgress(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/review',
            handler: (req, res) => {
              handleReview(service, req, res)
            },
          }),
          webScope.webServer.register({
            kind: 'exact',
            path: '/plugins/taskflow/human-decision',
            handler: (req, res) => {
              handleHumanDecision(service, req, res)
            },
          }),
        ]
        return () => {
          for (const dispose of disposeRoutes) dispose()
        }
      }, 'dsh-taskflow: http routes')
    })
  })
  return Promise.resolve(fiber).then(() => {})
}
