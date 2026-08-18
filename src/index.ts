/**
 * dsh-taskflow host half: opens the taskflow storage domain, mounts the
 * orchestration service over its repository, registers the same-origin JSON
 * routes (/plugins/taskflow/state|submit|command), and injects a
 * model-facing announcement section. P1 adds the durable run-aggregate
 * ledger (storage domain); the planner, executor, reviewer, and scheduler
 * adapters mount in later phases without changing the service surface.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { TASKFLOW_DOMAIN } from './domain.ts'
import { DomainRepository } from './repository.ts'
import { TaskFlowService, type CommandAction, type SubmitRequest } from './service.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Required services: systemPrompt for the announcement, storageDomain for the ledger. */
export const inject = ['systemPrompt', 'storageDomain']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASKFLOW_GUIDANCE = '本机已安装 dsh-taskflow 插件（DSH 全自动任务工作流编排）：任务提出后由 Codex CLI 规划拆分为 Issue 并发布看板，DSH 认领执行，Codex 只读审查决定打回或通过，按依赖序推进，最终人工验收。当前为 P1 阶段：运行台账已持久化（重启不丢，支持幂等提交与取消），规划与执行引擎将在后续阶段启用。用户提到「工作流 / 任务流 / taskflow」时即指本插件，请据此协作。'

/** Plugin config; schema defaults are applied by the loader. */
export interface Config {
  /** When true (default), announce the plugin in every agent's system prompt. */
  announceToAgent?: boolean
  /** Master switch for the plugin. */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/** JSON response writer (same-origin routes; no secrets ever enter bodies). */
function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
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

/** POST /plugins/taskflow/submit — create a run from { title, description?, idempotencyKey? }. */
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
    if (action !== 'cancel') {
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
    const service = new TaskFlowService(new DomainRepository(domain))

    if ((config?.announceToAgent ?? true) === true) {
      scope.effect(() => scope.systemPrompt.section({
        name: 'plugin:taskflow',
        order: SECTION_ORDER,
        text: TASKFLOW_GUIDANCE,
      }), 'dsh-taskflow: guidance section')
    }

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
        ]
        return () => {
          for (const dispose of disposeRoutes) dispose()
        }
      }, 'dsh-taskflow: http routes')
    })
  })
  return Promise.resolve(fiber).then(() => {})
}
