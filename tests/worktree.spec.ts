/**
 * P5 worktree manager tests: Git command construction for integration-branch
 * ensure, per-issue worktree creation, merge, and cleanup — all driven through
 * a fake Git runner.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execGit, WorktreeError, WorktreeManager, type GitResult, type GitRunner } from '../src/worktree.ts'

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

/** Default sibling directory name used when no worktreesRoot is configured. */
const DEFAULT_WORKTREES_DIR = '.dsh-taskflow-worktrees'

/** Root that holds all worktrees for a repo: <sibling>/<repoRootHash>. */
function rootOf(workDir: string): string {
  return dirname(dirname(workDir))
}

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

  it('defaults worktrees to a stable sibling root outside the repo', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git)

    const first = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')
    const second = await manager.createIssueWorktree(REPO, 'run-0002', 'issue-001', 'taskflow/integration')

    const repoResolved = resolve(REPO)
    const root = rootOf(first.workDir)
    expect(first.workDir.startsWith(repoResolved + sep)).toBe(false)
    expect(basename(root)).toMatch(/^[0-9a-f]{8}$/)
    expect(root).toBe(join(dirname(repoResolved), DEFAULT_WORKTREES_DIR, basename(root)))
    expect(rootOf(second.workDir)).toBe(root)
    expect(git.calls).toContainEqual([
      'worktree', 'add', '-b', 'taskflow/run-0001/issue-001', first.workDir, 'taskflow/integration',
    ])
  })

  it('isolates same-named repos at different paths under the default root', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git)

    const repoA = 'C:/workspaces/alpha/project'
    const repoB = 'C:/workspaces/beta/project'
    const a = await manager.createIssueWorktree(repoA, 'run-0001', 'issue-001', 'taskflow/integration')
    const b = await manager.createIssueWorktree(repoB, 'run-0001', 'issue-001', 'taskflow/integration')

    expect(rootOf(a.workDir)).not.toBe(rootOf(b.workDir))
    expect(basename(rootOf(a.workDir))).not.toBe(basename(rootOf(b.workDir)))
  })

  it('uses an explicit absolute worktreesRoot as configured', async () => {
    const git = new FakeGit()
    const root = resolve('/custom/taskflow-worktrees')
    const manager = new WorktreeManager(git, root)

    const result = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')

    expect(result.workDir).toBe(join(root, 'run-0001', 'issue-001'))
    expect(git.calls).toContainEqual([
      'worktree', 'add', '-b', 'taskflow/run-0001/issue-001', result.workDir, 'taskflow/integration',
    ])
  })

  it('keeps an explicit relative worktreesRoot relative to the repo root', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git, 'custom/worktrees')

    const result = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')

    expect(result.workDir).toBe(join(resolve(REPO), 'custom', 'worktrees', 'run-0001', 'issue-001'))
  })

  it('reuses an existing worktree after a crashed create', async () => {
    const git = new FakeGit()
    const branch = 'taskflow/run-0001/issue-001'
    const workDir = join(resolve(REPO), '.taskflow', 'worktrees', 'run-0001', 'issue-001')
    git.resultFor = (args) => {
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes('-b')) {
        return { exitCode: 1, stdout: '', stderr: 'branch already exists' }
      }
      if (args[0] === 'worktree' && args[1] === 'add' && !args.includes('-b')) {
        return { exitCode: 1, stdout: '', stderr: 'worktree already exists' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { exitCode: 0, stdout: `${branch}\n`, stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    const result = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')

    expect(result).toEqual({ workDir, branch })
    expect(git.calls).toContainEqual(['worktree', 'add', '-b', branch, workDir, 'taskflow/integration'])
    expect(git.calls).toContainEqual(['worktree', 'add', workDir, branch])
    expect(git.calls).toContainEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
  })

  it('resolves a branch head SHA', async () => {
    const git = new FakeGit()
    git.resultFor = () => ({ exitCode: 0, stdout: 'abc123\n', stderr: '' })
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await expect(manager.getBranchHeadSha(REPO, 'taskflow/integration')).resolves.toBe('abc123')
    expect(git.calls).toEqual([['rev-parse', '--verify', 'refs/heads/taskflow/integration']])
  })

  it('merges an issue branch in a dedicated integration worktree', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git, '.taskflow/worktrees')

    await manager.mergeIssueWorktree(REPO, 'taskflow/run-0001/issue-001', 'taskflow run-0001 issue-001', 'taskflow/integration')

    const integrationWorktree = join(resolve(REPO), '.taskflow', 'worktrees', '_integration', 'taskflow-run-0001-issue-001')
    expect(git.calls).toContainEqual([
      'worktree', 'add', integrationWorktree, 'taskflow/integration',
    ])
    expect(git.calls).toContainEqual([
      'merge', '--no-ff', 'taskflow/run-0001/issue-001', '-m', 'taskflow run-0001 issue-001',
    ])
    expect(git.calls).toContainEqual(['worktree', 'remove', '--force', integrationWorktree])
    expect(git.calls.some((args) => args[0] === 'checkout')).toBe(false)
  })

  it('keeps default integration worktrees outside the repo on the same root', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git)
    const issue = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')
    await manager.mergeIssueWorktree(REPO, 'taskflow/run-0001/issue-001', 'msg', 'taskflow/integration')

    const add = git.calls.find((args) => args[0] === 'worktree' && args[1] === 'add' && args.length === 4)
    expect(add).toBeDefined()
    const integrationWorktree = add![2]
    expect(integrationWorktree.startsWith(resolve(REPO) + sep)).toBe(false)
    expect(rootOf(integrationWorktree)).toBe(rootOf(issue.workDir))
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

  it('resolves issue cleanup through the same default root', async () => {
    const git = new FakeGit()
    const manager = new WorktreeManager(git)
    const created = await manager.createIssueWorktree(REPO, 'run-0001', 'issue-001', 'taskflow/integration')

    const forwardSlashPath = join(rootOf(created.workDir), 'run-0001', 'issue-001').replace(/\\/g, '/')
    await manager.removeIssueWorktree(REPO, forwardSlashPath, created.branch)

    expect(git.calls).toContainEqual(['worktree', 'remove', '--force', resolve(forwardSlashPath)])
    expect(git.calls).toContainEqual(['branch', '-D', created.branch])
  })

  it('real git merge advances the integration branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskflow-wt-'))
    try {
      const git = execGit
      const setup = [
        ['init'],
        ['config', 'user.email', 'test@example.com'],
        ['config', 'user.name', 'test'],
      ]
      for (const args of setup) {
        const result = await git.run(args, root)
        expect(result.exitCode).toBe(0)
      }
      await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
      expect((await git.run(['add', 'base.txt'], root)).exitCode).toBe(0)
      expect((await git.run(['commit', '-m', 'base'], root)).exitCode).toBe(0)

      const manager = new WorktreeManager(git, '.taskflow/worktrees')
      await manager.ensureIntegrationBranch(root, 'taskflow/integration')
      const created = await manager.createIssueWorktree(root, 'run-0001', 'issue-001', 'taskflow/integration')
      await writeFile(join(created.workDir, 'feature.txt'), 'feature\n', 'utf8')
      await manager.commitWorktreeEdits(created.workDir, 'taskflow run-0001 issue-001')

      const before = await git.run(['rev-parse', 'taskflow/integration'], root)
      expect(before.exitCode).toBe(0)
      await manager.mergeIssueWorktree(root, created.branch, 'taskflow run-0001 issue-001', 'taskflow/integration')
      const after = await git.run(['rev-parse', 'taskflow/integration'], root)
      expect(after.exitCode).toBe(0)
      expect(after.stdout.trim()).not.toBe(before.stdout.trim())

      await manager.removeIssueWorktree(root, created.workDir, created.branch)
      const log = await git.run(['log', '--oneline', 'taskflow/integration'], root)
      expect(log.stdout).toContain('taskflow run-0001 issue-001')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
