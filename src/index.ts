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
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { TASKFLOW_DOMAIN } from './domain.ts'
import { AUTOMATION_CONTROL_ACTIONS, DEFAULT_AUTOMATION_CONFIG, EXECUTOR_PHASES, type TaskFlowEvent } from './contracts.ts'
import type { ExecutionResult } from './executor.ts'
import { CodexIssueExecutor } from './issue-executor.ts'
import { CodexPlanner } from './planner.ts'
import { DomainRepository } from './repository.ts'
import { TaskFlowService, type CommandAction, type HumanDecision, type SubmitRequest } from './service.ts'

/** P8.2 public adapter exports. */
export { CodexIssueExecutor, CodexExecutor } from './issue-executor.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Required services: systemPrompt for the announcement, storageDomain for the ledger. */
export const inject = ['systemPrompt', 'storageDomain']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASKFLOW_GUIDANCE = '本机已安装 dsh-taskflow 插件（DSH 全自动任务工作流编排）：任务提出后由 Codex CLI 规划拆分为 Issue 并发布看板，DSH 认领执行（串行/并行 + Git worktree 隔离），Codex 只读审查决定打回或通过，按依赖序推进，最终人工验收。当前为 P8.6 阶段：运行台账已持久化，Codex 规划引擎已接入（提交时带 repoRoot 后经 /plugins/taskflow/plan 触发规划，规划通过后运行进入 READY 并携带 Issue 清单）；执行引擎已启用（经 /plugins/taskflow/execute 启动执行，READY → EXECUTING，按 DAG 依赖每次认领最多 maxConcurrent 个可调度 Issue，响应含 currentIssues；每个 Issue 在独立 Git worktree 中执行，workDir/branch 可从 state/execute 响应读取；完成 currentIssue 后经 /plugins/taskflow/exec-result 上报 { runId, issueKey, ok, summary|error }，成功后自动合并到集成分支，全部完成后运行自动进入 INTEGRATION_REVIEW）；P4 审查门已启用（经 /plugins/taskflow/review 触发 Codex 只读审查，PASS 进入 AWAITING_HUMAN 等待人工验收，REVISE 打回 EXECUTING 并重置返工 Issue）；P6 看板已启用（GET /plugins/taskflow/board 返回五列看板快照，浏览器端状态卡片可打开看板）；P7 人工验收门已启用（POST /plugins/taskflow/human-decision 提交 { runId, decision: accept|rework }，accept 进入 ACCEPTED 终态，rework 回到 PLANNING 重新规划）；P8 自动化契约已冻结且默认开启（automationEnabled=true）；P8.1 已持久化控制元数据、进度事件与运行级 Git 隔离，并提供 GET /plugins/taskflow/run 详情投影与 pause/resume/takeover/release/retry 控制动作；P8.2 已内置 Codex Issue Executor（自动化开启时在独立 worktree 中以 workspace-write 非交互实现 Issue）；P8.3 已接入自动推进协调器（automationEnabled 开启且 autoPlan/autoReview 为 true 时自动完成规划、执行、审查），新增 GET /plugins/taskflow/events SSE 事件流，审查返工达到 maxReviewCycles 时进入 WAITING_DECISION 人工介入窗口（可用 resume 继续）；P8.4 已接入自动执行授权门（requireExecutionPermission=true 时，规划完成后进入 WAITING_PERMISSION，人工 release 后自动继续执行）；P8.5 已接入浏览器运行台与介入窗口（看板卡片打开运行详情抽屉，经 /plugins/taskflow/run 与 run-scoped SSE 实时刷新，按 allowedActions 渲染操作按钮并二次确认后调用 /plugins/taskflow/command 或 /plugins/taskflow/human-decision）。用户提到「工作流 / 任务流 / taskflow」时即指本插件，请据此协作。'

/** Plugin config; schema defaults are applied by the loader. */
export interface Config {
  /** When true (default), announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Master switch for the plugin. */
  enabled?: boolean
  /** Canonical repo roots the planner may inspect; empty = planning disabled. */
  allowedRepoRoots?: string[]
  /** Codex CLI entry override; default resolves via CODEX_CLI_PATH or platform. */
  codexCliPath?: string
  /** P5: maximum concurrent issues (default 1 = serial-compatible). */
  maxConcurrent?: number
  /** P5: persistent branch where successful issue worktrees are merged. */
  integrationBranch?: string
  /** P5: directory under the repo root that holds per-issue worktrees. */
  worktreesRoot?: string
  /** P8: master switch for the automated executor/automation; default on from P8.6. */
  automationEnabled?: boolean
  /** P8: when automation is enabled, automatically start planning. */
  autoPlan?: boolean
  /** P8: when automation is enabled, automatically trigger Codex review. */
  autoReview?: boolean
  /** P8: global cap on concurrent Codex executor processes. */
  maxExecutorProcesses?: number
  /** P8: max review/rework cycles before asking a human. */
  maxReviewCycles?: number
  /** P8.4: wait for human release before automatic execution starts. */
  requireExecutionPermission?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
  allowedRepoRoots: z.array(z.string()).default([]),
  codexCliPath: z.string().default(''),
  maxConcurrent: z.number().step(1).min(1).default(1),
  integrationBranch: z.string().default('taskflow/integration'),
  worktreesRoot: z.string().default('.taskflow/worktrees'),
  automationEnabled: z.boolean().default(DEFAULT_AUTOMATION_CONFIG.enabled),
  autoPlan: z.boolean().default(DEFAULT_AUTOMATION_CONFIG.autoPlan),
  autoReview: z.boolean().default(DEFAULT_AUTOMATION_CONFIG.autoReview),
  maxExecutorProcesses: z.number().step(1).min(1).default(DEFAULT_AUTOMATION_CONFIG.maxExecutorProcesses),
  maxReviewCycles: z.number().step(1).min(1).default(DEFAULT_AUTOMATION_CONFIG.maxReviewCycles),
  requireExecutionPermission: z.boolean().default(DEFAULT_AUTOMATION_CONFIG.requireExecutionPermission),
})

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
 * Reject requests that are not same-origin POST with a JSON body. The host
 * binds loopback by default but may be exposed on 0.0.0.0, and a CORS-safelisted
 * text/plain POST would otherwise mutate the ledger without a preflight.
 * @returns an error message when the request is rejected, else undefined.
 */
function guardMutation(req: IncomingMessage): string | undefined {
  if (req.method !== 'POST') {
    return 'taskflow: mutation routes require POST'
  }
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return 'taskflow: mutation routes require application/json'
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    const host = req.headers.host
    if (host === undefined || (origin !== `http://${host}` && origin !== `https://${host}`)) {
      return 'taskflow: cross-origin request rejected'
    }
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
  res.on('close', unsubscribe)
  res.on('error', unsubscribe)
}

/**
 * Mount the host half: open the durable domain, assemble the service, then
 * register the announcement section and HTTP routes (routes only when the
 * web server service exists).
 * @param ctx - plugin context (systemPrompt + storageDomain injected).
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): Promise<void> {
  if ((config?.enabled ?? true) === false) {
    return Promise.resolve()
  }
  const fiber = ctx.inject(['systemPrompt', 'storageDomain'], async (scope: Context) => {
    const domain = await scope.storageDomain.open(TASKFLOW_DOMAIN)
    // Return the close promise so lifecycle disposal awaits the domain drain
    // and the name frees before a potential reopen.
    scope.effect(() => () => domain.close(), 'dsh-taskflow: domain close')
    const configuredCli = config?.codexCliPath
    const cliPath = configuredCli !== undefined && configuredCli !== '' ? configuredCli : process.env.CODEX_CLI_PATH
    const planner = new CodexPlanner(undefined, undefined, undefined, cliPath)
    const executor = (config?.automationEnabled ?? DEFAULT_AUTOMATION_CONFIG.enabled)
      ? new CodexIssueExecutor(undefined, undefined, undefined, cliPath)
      : undefined
    const service = new TaskFlowService(
      new DomainRepository(domain),
      undefined,
      planner,
      config?.allowedRepoRoots ?? [],
      executor,
      undefined,
      {
        maxConcurrent: config?.maxConcurrent ?? 1,
        integrationBranch: config?.integrationBranch ?? 'taskflow/integration',
        worktreesRoot: config?.worktreesRoot ?? '.taskflow/worktrees',
        automationEnabled: config?.automationEnabled ?? DEFAULT_AUTOMATION_CONFIG.enabled,
        maxExecutorProcesses: config?.maxExecutorProcesses ?? DEFAULT_AUTOMATION_CONFIG.maxExecutorProcesses,
        autoPlan: config?.autoPlan ?? DEFAULT_AUTOMATION_CONFIG.autoPlan,
        autoReview: config?.autoReview ?? DEFAULT_AUTOMATION_CONFIG.autoReview,
        maxReviewCycles: config?.maxReviewCycles ?? DEFAULT_AUTOMATION_CONFIG.maxReviewCycles,
        requireExecutionPermission: config?.requireExecutionPermission ?? DEFAULT_AUTOMATION_CONFIG.requireExecutionPermission,
      },
    )

    if ((config?.announceToAgent ?? true) === true) {
      scope.effect(() => scope.systemPrompt.section({
        name: 'plugin:taskflow',
        order: SECTION_ORDER,
        text: TASKFLOW_GUIDANCE,
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
