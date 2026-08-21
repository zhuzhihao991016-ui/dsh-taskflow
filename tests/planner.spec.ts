/**
 * P2 planner tests: the Codex CLI adapter contract — exact argv, stdin
 * prompt, schema file materialization, JSONL parsing, exit-code handling,
 * timeout retry, and parse failures — all driven through a fake executor.
 */

import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexPlanner,
  PlannerError,
  buildPlanPrompt,
  lastAssistantText,
  parsePlanText,
  resolveCodexCli,
  spawnCodexProcess,
  type ProcessExecutor,
  type ProcessResult,
} from '../src/planner.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taskflow-plan-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

async function waitForPidFile(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, 'utf8')).trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`pid file not written within ${timeoutMs}ms: ${path}`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Fake executor recording requests and returning scripted results. */
class FakeExecutor implements ProcessExecutor {
  readonly requests: Array<{
    command: readonly string[]
    cwd: string
    stdinText: string
    signal?: AbortSignal
    maxOutputBytes?: number
  }> = []
  results: ProcessResult[] = []

  run(request: {
    command: readonly string[]
    cwd: string
    stdinText: string
    timeoutMs: number
    signal?: AbortSignal
    maxOutputBytes?: number
  }): Promise<ProcessResult> {
    this.requests.push({
      command: request.command,
      cwd: request.cwd,
      stdinText: request.stdinText,
      signal: request.signal,
      maxOutputBytes: request.maxOutputBytes,
    })
    const result = this.results.shift()
    if (result === undefined) {
      return Promise.reject(new Error('fake executor: no scripted result'))
    }
    return Promise.resolve(result)
  }
}

function assistantEvent(text: string): string {
  return JSON.stringify({
    timestamp: 1,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  })
}

/** Real `codex exec --json` event shape (verified against a live run). */
function agentMessageEvent(text: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text },
  })
}

const PLAN_JSON = JSON.stringify({
  issues: [
    { key: 'issue-001', acceptance: '验收 A', deps: [], risk: null },
    { key: 'issue-002', acceptance: '验收 B', deps: ['issue-001'], risk: 'L2' },
  ],
})

const INPUT = { title: '升级后端', description: 'agtscp2.0', repoRoot: 'C:/repo', workDir: '' }

describe('lastAssistantText', () => {
  it('extracts the last assistant output_text message from a JSONL stream', () => {
    const stream = [
      JSON.stringify({ timestamp: 1, type: 'event_msg', payload: { type: 'user_message', message: { role: 'user' } } }),
      assistantEvent('first'),
      assistantEvent(PLAN_JSON),
    ].join('\n')
    expect(lastAssistantText(stream)).toBe(PLAN_JSON)
  })

  it('extracts the agent_message text from the real codex exec event shape', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started', payload: {} }),
      agentMessageEvent('first'),
      agentMessageEvent(PLAN_JSON),
    ].join('\n')
    expect(lastAssistantText(stream)).toBe(PLAN_JSON)
  })

  it('parses the captured real transcript fixture', async () => {
    const { readFile } = await import('node:fs/promises')
    const fixture = await readFile(join(__dirname, 'fixtures', 'codex-exec-real.jsonl'), 'utf8')
    expect(lastAssistantText(fixture)).toBe('只回复两个字：收到')
  })

  it('ignores malformed lines and returns undefined without assistant output', () => {
    expect(lastAssistantText('not json\n{"type":"event_msg"}\n')).toBeUndefined()
  })
})

describe('parsePlanText', () => {
  it('parses a JSON object wrapped in prose', () => {
    expect(parsePlanText(`说明\n${PLAN_JSON}\n结束`)).toEqual(JSON.parse(PLAN_JSON))
  })

  it('throws a stable parse error on non-JSON output', () => {
    expect(() => parsePlanText('no braces here')).toThrow('no JSON object')
  })
})

describe('CodexPlanner', () => {
  it('runs codex exec with the gated argv, prompt on stdin, and returns the parsed plan', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(PLAN_JSON), stderr: '', timedOut: false }]
    const planner = new CodexPlanner(executor, 60_000)

    const plan = await planner.plan({ ...INPUT, workDir: join(root, 'spool') })

    expect(plan).toEqual(JSON.parse(PLAN_JSON))
    expect(executor.requests).toHaveLength(1)
    const request = executor.requests[0]
    const repoRoot = resolve(INPUT.repoRoot)
    expect(request.command).toEqual([
      expect.stringMatching(/codex\.js$/),
      'exec',
      '--model', 'gpt-5.6-sol',
      '--config', 'model_reasoning_effort="max"',
      '--strict-config',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--color', 'never',
      '--cd', repoRoot,
      '--output-schema', join(root, 'spool', 'plan.schema.json'),
      '--json',
      '-',
    ])
    expect(request.cwd).toBe(repoRoot)
    expect(request.stdinText).toContain('升级后端')
    expect(request.stdinText).toContain('agtscp2.0')
    // Schema file materialized in the spool dir with the strict-outputs contract.
    const schema = JSON.parse(await readFile(join(root, 'spool', 'plan.schema.json'), 'utf8')) as {
      required?: string[]
      additionalProperties?: boolean
      properties?: { issues?: { items?: { required?: string[]; additionalProperties?: boolean } } }
    }
    expect(schema.required).toContain('issues')
    expect(schema.additionalProperties).toBe(false)
    const issueItem = schema.properties?.issues?.items
    expect(issueItem?.required).toEqual(['key', 'acceptance', 'deps', 'risk'])
    expect(issueItem?.additionalProperties).toBe(false)
  })

  it('canonicalizes a relative repoRoot once for both cwd and --cd', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(PLAN_JSON), stderr: '', timedOut: false }]
    const planner = new CodexPlanner(executor, 60_000)
    const base = join(root, 'repo')

    await planner.plan({ ...INPUT, repoRoot: './repo', workDir: join(root, 's') })

    expect(executor.requests).toHaveLength(1)
    // The child's cwd is resolved relative to the parent cwd (process cwd),
    // so './repo' becomes an absolute path; both slots must be equal.
    expect(executor.requests[0].cwd).toBe(resolve('./repo'))
    expect(executor.requests[0].command).toContain('--cd')
    const cdIndex = executor.requests[0].command.indexOf('--cd')
    expect(executor.requests[0].command[cdIndex + 1]).toBe(executor.requests[0].cwd)
    void base
  })

  it('forwards an optional abort signal to the process executor', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: agentMessageEvent(PLAN_JSON), stderr: '', timedOut: false }]
    const controller = new AbortController()
    const planner = new CodexPlanner(executor, 60_000)

    await planner.plan({ ...INPUT, workDir: join(root, 'spool'), signal: controller.signal })

    expect(executor.requests).toHaveLength(1)
    expect(executor.requests[0].signal).toBe(controller.signal)
  })

  it('treats an abort/timeout race as cancellation without retrying', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: null, stdout: '', stderr: '', timedOut: true, aborted: true }]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 'spool') })).rejects.toMatchObject({
      code: 'process-failed',
      message: expect.stringContaining('aborted'),
    })
    expect(executor.requests).toHaveLength(1)
  })

  it('reports output-limit termination without retrying, ahead of timeout', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{
      exitCode: null,
      stdout: 'truncated',
      stderr: '',
      timedOut: true,
      outputLimitExceeded: true,
    }]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'process-failed',
      message: expect.stringContaining('output limit exceeded'),
    })
    expect(executor.requests).toHaveLength(1)
  })

  it('throws process-failed with stderr detail on a non-zero exit', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 2, stdout: '', stderr: 'boom', timedOut: false }]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      name: 'PlannerError',
      code: 'process-failed',
    })
  })

  it('retries once on timeout and fails with a stable timeout error after both attempts', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
    ]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(executor.requests).toHaveLength(2)
  })

  it('succeeds when the retry after a timeout returns a plan', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [
      { exitCode: null, stdout: '', stderr: '', timedOut: true },
      { exitCode: 0, stdout: assistantEvent(PLAN_JSON), stderr: '', timedOut: false },
    ]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 's') })).resolves.toEqual(JSON.parse(PLAN_JSON))
  })

  it('fails with no-plan-output when the stream has no assistant message', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: '{"type":"event_msg"}\n', stderr: '', timedOut: false }]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'no-plan-output',
    })
  })

  it('fails with parse-failed when the assistant text is not JSON', async () => {
    const root = await freshRoot()
    const executor = new FakeExecutor()
    executor.results = [{ exitCode: 0, stdout: assistantEvent('抱歉，无法完成'), stderr: '', timedOut: false }]
    const planner = new CodexPlanner(executor, 60_000)

    await expect(planner.plan({ ...INPUT, workDir: join(root, 's') })).rejects.toMatchObject({
      code: 'parse-failed',
    })
  })
})

describe('buildPlanPrompt', () => {
  it('carries title, description, and the JSON-only output requirement', () => {
    const prompt = buildPlanPrompt({ title: 'T', description: 'D', repoRoot: 'R', workDir: '' })
    expect(prompt).toContain('T')
    expect(prompt).toContain('D')
    expect(prompt).toContain('--output-schema')
    expect(prompt).not.toContain('重新规划反馈')
  })

  it('includes review feedback when a run is replanned', () => {
    const prompt = buildPlanPrompt({
      title: 'T',
      description: 'D',
      replanFeedback: '技术路线偏离目标，需要重新划分依赖。',
      repoRoot: 'R',
      workDir: '',
    })
    expect(prompt).toContain('重新规划反馈')
    expect(prompt).toContain('技术路线偏离目标')
    expect(prompt).toContain('不要机械复刻旧计划')
  })
})

describe('PlannerError', () => {
  it('carries a stable taskflow-prefixed message', () => {
    const error = new PlannerError('timeout', 'took too long')
    expect(error.message).toBe('taskflow: planner timeout: took too long')
    expect(error.code).toBe('timeout')
  })
})

describe('resolveCodexCli', () => {
  it('honors the CODEX_CLI_PATH override', () => {
    const previous = process.env.CODEX_CLI_PATH
    process.env.CODEX_CLI_PATH = 'C:/custom/codex.js'
    try {
      expect(resolveCodexCli()).toBe('C:/custom/codex.js')
    } finally {
      if (previous === undefined) delete process.env.CODEX_CLI_PATH
      else process.env.CODEX_CLI_PATH = previous
    }
  })

  it('falls back to a bare codex executable without APPDATA', () => {
    const previous = process.env.CODEX_CLI_PATH
    const appData = process.env.APPDATA
    delete process.env.CODEX_CLI_PATH
    process.env.APPDATA = ''
    try {
      expect(resolveCodexCli()).toBe('codex')
    } finally {
      if (previous === undefined) delete process.env.CODEX_CLI_PATH
      else process.env.CODEX_CLI_PATH = previous
      if (appData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = appData
    }
  })
})

describe('spawnCodexProcess', () => {
  it('executes a JS entry through the current Node runtime', async () => {
    const root = await freshRoot()
    const script = join(root, 'entry.js')
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
    const controller = new AbortController()
    const result = await spawnCodexProcess.run({
      command: [script, '--model', 'gpt-test'],
      cwd: root,
      stdinText: '',
      timeoutMs: 5000,
      signal: controller.signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('--model')
    expect(result.stdout).toContain('gpt-test')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('spawns a native executable path directly without prepending Node', async () => {
    const root = await freshRoot()
    const result = await spawnCodexProcess.run({
      command: [process.execPath, '-e', 'process.stdout.write("native-ok")'],
      cwd: root,
      stdinText: '',
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('native-ok')
  })

  it('rejects .cmd/.bat launchers instead of passing arguments through a shell', async () => {
    const root = await freshRoot()
    const script = join(root, 'echo-args.cmd')
    const printer = join(root, 'print-args.cjs')
    await writeFile(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n")\n', 'utf8')
    await writeFile(script, [
      '@echo off',
      `@"${process.execPath}" "%~dp0print-args.cjs" %*`,
      'exit /b %errorlevel%',
      '',
    ].join('\r\n'), 'utf8')
    const pending = spawnCodexProcess.run({
      command: [script, 'a&b', 'two words', 'x"y', 'model_reasoning_effort="high"'],
      cwd: root,
      stdinText: '',
      timeoutMs: 5000,
    })
    await expect(pending).rejects.toThrow('.cmd/.bat launchers are not supported')
  })

  it('settles with aborted when the signal is already aborted', async () => {
    const root = await freshRoot()
    const script = join(root, 'hang.js')
    await writeFile(script, 'setInterval(() => {}, 1000)\n', 'utf8')
    const controller = new AbortController()
    controller.abort()
    const result = await spawnCodexProcess.run({
      command: [script],
      cwd: root,
      stdinText: '',
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('terminates the whole child tree on a mid-run abort', async () => {
    const root = await freshRoot()
    const pidFile = join(root, 'grandchild.pid')
    const script = join(root, 'tree.js')
    await writeFile(script, [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const pidFile = ${JSON.stringify(pidFile)}`,
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])",
      "child.on('spawn', () => writeFileSync(pidFile, String(child.pid)))",
      'setInterval(() => {}, 1000)',
      '',
    ].join('\n'), 'utf8')
    const controller = new AbortController()
    const pending = spawnCodexProcess.run({
      command: [script],
      cwd: root,
      stdinText: '',
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    try {
      const grandchildPid = await waitForPidFile(pidFile, 5000)
      controller.abort()
      const result = await pending
      expect(result.aborted).toBe(true)
      expect(result.exitCode).toBeNull()
      await vi.waitFor(() => {
        expect(isProcessAlive(grandchildPid)).toBe(false)
      }, { timeout: 5000 })
    } finally {
      controller.abort()
      await pending.catch(() => undefined)
    }
  })

  it('kills the child and reports timedOut on timeout', async () => {
    const root = await freshRoot()
    const script = join(root, 'hang.js')
    await writeFile(script, 'setInterval(() => {}, 1000)\n', 'utf8')
    const result = await spawnCodexProcess.run({
      command: [script],
      cwd: root,
      stdinText: '',
      timeoutMs: 150,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.aborted).toBeUndefined()
  })

  it('settles once with outputLimitExceeded when combined output exceeds the cap', async () => {
    const root = await freshRoot()
    const script = join(root, 'noisy.js')
    await writeFile(script, "process.stdout.write('x'.repeat(8 * 1024 * 1024))\n", 'utf8')
    const result = await spawnCodexProcess.run({
      command: [script],
      cwd: root,
      stdinText: '',
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    })
    expect(result.outputLimitExceeded).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024)
  })
})
