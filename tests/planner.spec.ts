/**
 * P2 planner tests: the Codex CLI adapter contract — exact argv, stdin
 * prompt, schema file materialization, JSONL parsing, exit-code handling,
 * timeout retry, and parse failures — all driven through a fake executor.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexPlanner,
  PlannerError,
  buildPlanPrompt,
  lastAssistantText,
  parsePlanText,
  resolveCodexCli,
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

/** Fake executor recording requests and returning scripted results. */
class FakeExecutor implements ProcessExecutor {
  readonly requests: Array<{ command: readonly string[]; cwd: string; stdinText: string }> = []
  results: ProcessResult[] = []

  run(request: { command: readonly string[]; cwd: string; stdinText: string; timeoutMs: number }): Promise<ProcessResult> {
    this.requests.push({ command: request.command, cwd: request.cwd, stdinText: request.stdinText })
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
