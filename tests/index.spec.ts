/**
 * P6 host-route contract tests: the /plugins/taskflow/board handler enforces
 * GET-only access and returns the board projection without leaking internal
 * fields. Kept small because the rest of the HTTP surface is covered by the
 * service and integration tests.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleBoard } from '../src/index.ts'
import type { BoardSnapshot, TaskFlowService } from '../src/service.ts'

function captureResponse() {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (code: number, head: Record<string, string>) => {
      status = code
      headers = head
    },
    end: (payload: string) => {
      body = payload
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => status,
    headers: () => headers,
    body: () => body,
  }
}

function boardService(columns: BoardSnapshot['columns']): Pick<TaskFlowService, 'board'> {
  return { board: () => ({ columns }) }
}

describe('handleBoard', () => {
  it('returns the board columns for GET requests', () => {
    const { res, status, body } = captureResponse()
    const columns = [{ id: 'todo' as const, title: '待办', cards: [] }]
    handleBoard(boardService(columns) as TaskFlowService, { method: 'GET' } as IncomingMessage, res)

    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual({ ok: true, columns })
  })

  it('rejects non-GET requests with 405 and Allow: GET', () => {
    const { res, status, headers, body } = captureResponse()
    handleBoard(boardService([]) as TaskFlowService, { method: 'POST' } as IncomingMessage, res)

    expect(status()).toBe(405)
    expect(headers().Allow).toBe('GET')
    expect(JSON.parse(body())).toEqual({ ok: false, error: 'taskflow: board requires GET' })
  })
})
