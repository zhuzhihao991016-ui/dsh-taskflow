/**
 * P5 worktree manager tests: Git command construction for integration-branch
 * ensure, per-issue worktree creation, merge, and cleanup — all driven through
 * a fake Git runner.
 */

import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { WorktreeError, WorktreeManager, type GitResult, type GitRunner } from '../src/worktree.ts'

/** Scriptable fake git runner recording every command. */
class FakeGit implements GitRunner {
  calls: string[][] = []
  resultFor: (args: readonly string[]) => GitResult = () => ({ exitCode: 0, stdout: '', stderr: '' })

  async run(args: readonly string[], _cwd: string): Promise<GitResult> {
    this.calls.push([...args])
    return this.resultFor(args)
  }
}

const REPO = 'C:/repo'

describe('WorktreeManager', () => {
  it('creates the integration branch when it is missing', async () => {
    const git = new FakeGit()
    git.resultFor = (args) => (
      args[0] === 'rev-parse' && args[1] === '--verify'
        ? { exitCode: 1, stdout: '', stderr: 'unknown revision' }
        : { exitCode: 0, stdout: '', stderr: '' }
    )
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.ensureIntegrationBranch(REPO, 'taskflow/integration')

    expect(git.calls).toEqual([
      ['rev-parse', '--verify', 'refs/heads/taskflow/integration'],
      ['branch', 'taskflow/integration'],
    ])
  })

  it('does not create the integration branch when it already exists', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.ensureIntegrationBranch(REPO, 'taskflow/integration')

    expect(git.calls).toEqual([['rev-parse', '--verify', 'refs/heads/taskflow/integration']])
  })

  it('creates a per-issue worktree on its own branch', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    const result = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')

    expect(result.branch).toBe('taskflow/run-0001/issue-001')
    expect(result.workDir).toBe(join(resolve(REPO), '.taskflow', 'worktrees', 'run-0001', 'issue-001'))
    expect(git.calls).toContainEqual([
      'worktree', 'add', '-b', 'taskflow/run-0001/issue-001',
      join(resolve(REPO), '.taskflow', 'worktrees', 'run-0001', 'issue-001'),
      'taskflow/integration',
    ])
  })

  it('merges an issue branch in a dedicated integration worktree', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.mergeIssueWorktree(REPO, 'taskflow/run-0001/issue-001', 'taskflow run-0001 issue-001', 'taskflow/integration')

    const integrationWorktree = join(resolve(REPO), '.taskflow', 'worktrees', '_integration', 'taskflow-run-0001-issue-001')
    expect(git.calls).toContainEqual([
      'worktree', 'add', '--detach', integrationWorktree, 'taskflow/integration',
    ])
    expect(git.calls).toContainEqual([
      'merge', '--no-ff', 'taskflow/run-0001/issue-001', '-m', 'taskflow run-0001 issue-001',
    ])
    expect(git.calls).toContainEqual(['worktree', 'remove', '--force', integrationWorktree])
    expect(git.calls.some((args) => args[0] === 'checkout')).toBe(false)
  })

  it('throws a stable WorktreeError when merge fails and aborts the merge', async () => {
    const git = new FakeGit()
    git.resultFor = (args) => (
      args[0] === 'merge' ? { exitCode: 1, stdout: '', stderr: 'conflict' } : { exitCode: 0, stdout: '', stderr: '' }
    )
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await expect(manager.mergeIssueWorktree(REPO, 'taskflow/run-0001/issue-001', 'msg', 'taskflow/integration')).rejects.toBeInstanceOf(WorktreeError)
    expect(git.calls).toContainEqual(['merge', '--abort'])
  })

  it('resolves the repository HEAD SHA', async () => {
    const git = new FakeGit()
    git.resultFor = () => ({ exitCode: 0, stdout: 'abc123\n', stderr: '' })
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await expect(manager.getHeadSha(REPO)).resolves.toBe('abc123')
    expect(git.calls).toEqual([['rev-parse', 'HEAD']])
  })

  it('commits uncommitted worktree edits only when the worktree is dirty', async () => {
    const git = new FakeGit()
    git.resultFor = (args) => (
      args[0] === 'status' ? { exitCode: 0, stdout: ' M file.txt\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }
    )
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.commitWorktreeEdits('C:/worktree', 'taskflow run-0001 issue-001')

    expect(git.calls).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'taskflow run-0001 issue-001'],
    ])
  })

  it('skips commit when the worktree is clean', async () => {
    const git = new FakeGit()
    git.resultFor = () => ({ exitCode: 0, stdout: '', stderr: '' })
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.commitWorktreeEdits('C:/worktree', 'taskflow run-0001 issue-001')

    expect(git.calls).toEqual([['status', '--porcelain']])
  })

  it('removes a merged worktree and its branch', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.removeIssueWorktree(REPO, 'C:/worktree', 'taskflow/run-0001/issue-001')

    expect(git.calls).toEqual([
      ['worktree', 'remove', '--force', 'C:/worktree'],
      ['branch', '-D', 'taskflow/run-0001/issue-001'],
    ])
  })
})
