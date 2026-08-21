/**
 * P6 host-route contract tests: the /plugins/taskflow/board handler enforces
 * GET-only access and returns the board projection without leaking internal
 * fields. Kept small because the rest of the HTTP surface is covered by the
 * service and integration tests.
 */

import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { guardMutation, handleBoard, handleEvents } from '../src/index.ts'
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

describe('guardMutation', () => {
  function request(overrides: {
    method?: string
    contentType?: string
    host?: string
    origin?: string
    remoteAddress?: string
    encrypted?: boolean
  } = {}): IncomingMessage {
    const headers: Record<string, string> = {
      'content-type': overrides.contentType ?? 'application/json',
    }
    if (overrides.host !== undefined) headers.host = overrides.host
    if (overrides.origin !== undefined) headers.origin = overrides.origin
    const req = { method: overrides.method ?? 'POST', headers } as IncomingMessage
    if (overrides.remoteAddress !== undefined || overrides.encrypted !== undefined) {
      ;(req as { socket?: { remoteAddress?: string; encrypted?: boolean } }).socket = {
        remoteAddress: overrides.remoteAddress,
        encrypted: overrides.encrypted,
      }
    }
    return req
  }

  it('allows loopback JSON POSTs from local non-browser clients without Origin', () => {
    expect(guardMutation(request({ host: 'localhost' }))).toBeUndefined()
    expect(guardMutation(request({ host: 'localhost:8080' }))).toBeUndefined()
    expect(guardMutation(request({ host: '127.0.0.1' }))).toBeUndefined()
    expect(guardMutation(request({ host: '127.0.0.2:8080' }))).toBeUndefined()
    expect(guardMutation(request({ host: '[::1]' }))).toBeUndefined()
    expect(guardMutation(request({ host: '[::1]:8080' }))).toBeUndefined()
    expect(guardMutation(request({ host: '::1' }))).toBeUndefined()
  })

  it('allows browser POSTs whose Origin is strictly same-origin with the Host', () => {
    expect(guardMutation(request({ host: 'localhost', origin: 'http://localhost' }))).toBeUndefined()
    expect(guardMutation(request({ host: 'localhost:80', origin: 'http://localhost' }))).toBeUndefined()
    expect(guardMutation(request({ host: 'localhost', origin: 'http://localhost:80' }))).toBeUndefined()
    expect(guardMutation(request({ host: 'localhost:8080', origin: 'http://localhost:8080' }))).toBeUndefined()
    expect(guardMutation(request({ host: 'localhost:8080', origin: 'https://localhost:8080', encrypted: true }))).toBeUndefined()
    expect(guardMutation(request({ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }))).toBeUndefined()
    expect(guardMutation(request({ host: '[::1]:8080', origin: 'http://[::1]:8080' }))).toBeUndefined()
  })

  it('still requires POST with a JSON content type', () => {
    expect(guardMutation(request({ method: 'GET', host: 'localhost' }))).toMatch(/require POST/)
    expect(guardMutation(request({ contentType: 'text/plain', host: 'localhost' }))).toMatch(/require application\/json/)
    expect(guardMutation(request({ contentType: 'application/json-p', host: 'localhost' }))).toMatch(/require application\/json/)
    expect(guardMutation(request({ contentType: 'application/json; charset=utf-8', host: 'localhost' }))).toBeUndefined()
  })

  it('rejects missing or malformed Host values', () => {
    expect(guardMutation(request({}))).toMatch(/non-loopback host rejected/)
    expect(guardMutation(request({ host: '' }))).toMatch(/non-loopback host rejected/)
    expect(guardMutation(request({ host: 'localhost:99999' }))).toMatch(/non-loopback host rejected/)
    expect(guardMutation(request({ host: 'user@localhost' }))).toMatch(/non-loopback host rejected/)
    expect(guardMutation(request({ host: 'localhost/path' }))).toMatch(/non-loopback host rejected/)
  })

  it('rejects non-loopback Hosts', () => {
    for (const host of [
      'evil.com',
      'evil.com:8080',
      'localhost.evil.com',
      '127.0.0.1.evil.com',
      '127.0.0.1.evil.com:8080',
      '128.0.0.1',
      '[2001:db8::1]',
    ]) {
      expect(guardMutation(request({ host }))).toMatch(/non-loopback host rejected/)
    }
  })

  it('rejects Origins that are not strictly same-origin with the Host', () => {
    expect(guardMutation(request({ host: 'localhost', origin: 'http://evil.com' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost:8080', origin: 'http://localhost:9090' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost:8080', origin: 'https://localhost:8080' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost', origin: 'http://localhost.evil.com' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost', origin: 'null' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost', origin: 'http://' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost', origin: 'file:///etc/passwd' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost', origin: 'http://user@localhost' }))).toMatch(/cross-origin/)
    expect(guardMutation(request({ host: 'localhost', origin: 'http://localhost/path' }))).toMatch(/cross-origin/)
  })

  it('rejects non-loopback remote peers even with a loopback Host', () => {
    expect(guardMutation(request({ host: 'localhost', remoteAddress: '192.168.1.5' }))).toMatch(/non-loopback connection rejected/)
    expect(guardMutation(request({ host: 'localhost', remoteAddress: '2001:db8::1' }))).toMatch(/non-loopback connection rejected/)
  })

  it('allows IPv4-mapped loopback remote peers', () => {
    for (const remoteAddress of [
      '::ffff:127.0.0.1',
      '::ffff:127.0.0.2',
      '::ffff:127.255.255.255',
      '::ffff:7f00:1',
      '::ffff:7f00:2',
      '::ffff:7f00:0002',
      '::ffff:7fff:ffff',
    ]) {
      expect(guardMutation(request({ host: 'localhost', remoteAddress }))).toBeUndefined()
    }
  })

  it('rejects non-loopback IPv4-mapped remote peers', () => {
    for (const remoteAddress of [
      '::ffff:8.8.8.8',
      '::ffff:128.0.0.1',
      '::ffff:0808:0808',
      '::ffff:7e00:1',
      '::ffff:7f00:1:2',
      '::ffff:127.0.0.256',
      '::ffff:127.0.0.1.5',
      '::ffff:7f00:',
      '::ffff:7f00:00000',
    ]) {
      expect(guardMutation(request({ host: 'localhost', remoteAddress }))).toMatch(/non-loopback connection rejected/)
    }
  })
})

describe('handleEvents SSE heartbeat', () => {
  it('sends periodic heartbeats and cleans up the timer and subscription on close', () => {
    vi.useFakeTimers()
    try {
      const unsubscribe = vi.fn()
      const service = {
        list: () => [],
        subscribeEvents: () => unsubscribe,
      } as unknown as TaskFlowService
      const listeners = new Map<string, () => void>()
      const chunks: string[] = []
      const res = {
        writeHead: () => undefined,
        write: (chunk: string) => {
          chunks.push(chunk)
          return true
        },
        on: (event: string, listener: () => void) => {
          listeners.set(event, listener)
        },
      } as unknown as ServerResponse

      handleEvents(service, { method: 'GET', url: '/plugins/taskflow/events' } as IncomingMessage, res)

      expect(chunks.join('')).toContain(': connected')
      vi.advanceTimersByTime(15_000)
      expect(chunks.join('')).toContain(': heartbeat')

      listeners.get('close')?.()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      listeners.get('error')?.()
      expect(unsubscribe).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(60_000)
      expect(chunks.join('').match(/: heartbeat/g)?.length ?? 0).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
