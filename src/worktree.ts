/**
 * P5 Worktree manager: isolates each running Issue in its own Git worktree
 * and merges successful work back into a persistent integration branch. The
 * Git runner is injectable so contract tests drive the manager with fakes;
 * production uses the system `git` executable.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)

/** One spawned git process result. */
export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Git command runner contract; production uses execGit, tests use fakes. */
export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<GitResult>
}

/** Production git runner: executes `git` in the given repository root. */
export const execGit: GitRunner = {
  async run(args, cwd) {
    try {
      const { stdout, stderr } = await execFileAsync('git', [...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      })
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const cause = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }
      return {
        exitCode: typeof cause.code === 'number' ? cause.code : 1,
        stdout: cause.stdout ?? '',
        stderr: cause.stderr ?? cause.message ?? '',
      }
    }
  },
}

/** Stable worktree error (surfaced in run transitions). */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(`taskflow: worktree ${message}`)
    this.name = 'WorktreeError'
  }
}

/**
 * Worktree operations for one repository. The integration branch is the
 * persistent target where every successful Issue branch is merged.
 */
export class WorktreeManager {
  constructor(
    private readonly git: GitRunner = execGit,
    private readonly worktreesRoot = '.taskflow/worktrees',
  ) {}

  /** Ensure the integration branch exists; create it from HEAD when missing. */
  async ensureIntegrationBranch(repoRoot: string, branch: string): Promise<void> {
    const check = await this.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot)
    if (check.exitCode === 0) return
    const create = await this.git.run(['branch', branch], repoRoot)
    if (create.exitCode !== 0) {
      throw new WorktreeError(`ensure integration branch '${branch}' failed: ${create.stderr.trim()}`)
    }
  }

  /** Create a worktree for one issue on its own branch based on the integration branch. */
  async createIssueWorktree(
    repoRoot: string,
    runId: string,
    issueKey: string,
    integrationBranch: string,
  ): Promise<{ workDir: string; branch: string }> {
    await this.ensureIntegrationBranch(repoRoot, integrationBranch)
    const branch = `taskflow/${runId}/${issueKey}`
    const workDir = join(resolve(repoRoot), this.worktreesRoot, runId, issueKey)
    const add = await this.git.run(['worktree', 'add', '-b', branch, workDir, integrationBranch], repoRoot)
    if (add.exitCode !== 0) {
      throw new WorktreeError(`create worktree for ${issueKey} failed: ${add.stderr.trim()}`)
    }
    return { workDir, branch }
  }

  /** Merge an issue branch into the integration branch (non-fast-forward). */
  async mergeIssueWorktree(
    repoRoot: string,
    branch: string,
    message: string,
    integrationBranch: string,
  ): Promise<void> {
    const current = await this.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
    const original = current.stdout.trim() || 'HEAD'
    const checkout = await this.git.run(['checkout', integrationBranch], repoRoot)
    if (checkout.exitCode !== 0) {
      throw new WorktreeError(`checkout integration branch failed: ${checkout.stderr.trim()}`)
    }
    const merge = await this.git.run(['merge', '--no-ff', branch, '-m', message], repoRoot)
    if (merge.exitCode !== 0) {
      if (original !== integrationBranch) {
        await this.git.run(['checkout', original], repoRoot)
      }
      throw new WorktreeError(`merge ${branch} failed: ${merge.stderr.trim()}`)
    }
    if (original !== integrationBranch) {
      const restore = await this.git.run(['checkout', original], repoRoot)
      if (restore.exitCode !== 0) {
        throw new WorktreeError(`restore original branch '${original}' failed: ${restore.stderr.trim()}`)
      }
    }
  }

  /** Remove a merged worktree and its branch (best-effort cleanup). */
  async removeIssueWorktree(repoRoot: string, workDir: string, branch: string): Promise<void> {
    await this.git.run(['worktree', 'remove', '--force', workDir], repoRoot)
    await this.git.run(['branch', '-D', branch], repoRoot)
  }
}
