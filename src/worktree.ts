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

/** Upper bound for a single Git subprocess (worktree/merge/cleanup operations). */
const GIT_TIMEOUT_MS = 60_000

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
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
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

  /** Resolve the repository's current HEAD SHA (used as the review base). */
  async getHeadSha(repoRoot: string): Promise<string> {
    const result = await this.git.run(['rev-parse', 'HEAD'], repoRoot)
    if (result.exitCode !== 0) {
      throw new WorktreeError(`resolve HEAD failed: ${result.stderr.trim()}`)
    }
    const sha = result.stdout.trim()
    if (sha === '') {
      throw new WorktreeError('resolve HEAD returned an empty SHA')
    }
    return sha
  }

  /** Commit uncommitted worktree edits onto the issue branch before merging. */
  async commitWorktreeEdits(workDir: string, message: string): Promise<void> {
    const status = await this.git.run(['status', '--porcelain'], workDir)
    if (status.exitCode !== 0) {
      throw new WorktreeError(`worktree status failed: ${status.stderr.trim()}`)
    }
    if (status.stdout.trim() === '') return
    const add = await this.git.run(['add', '-A'], workDir)
    if (add.exitCode !== 0) {
      throw new WorktreeError(`worktree add failed: ${add.stderr.trim()}`)
    }
    const commit = await this.git.run(['commit', '-m', message], workDir)
    if (commit.exitCode !== 0) {
      throw new WorktreeError(`worktree commit failed: ${commit.stderr.trim()}`)
    }
  }

  /** Merge an issue branch into the integration branch (non-fast-forward).
   * The merge runs in a dedicated integration worktree so the user's active
   * checkout is never switched. */
  async mergeIssueWorktree(
    repoRoot: string,
    branch: string,
    message: string,
    integrationBranch: string,
  ): Promise<void> {
    await this.ensureIntegrationBranch(repoRoot, integrationBranch)
    const integrationWorktree = join(
      resolve(repoRoot),
      this.worktreesRoot,
      '_integration',
      branch.replace(/[^A-Za-z0-9._-]/g, '-'),
    )
    const add = await this.git.run(['worktree', 'add', integrationWorktree, integrationBranch], repoRoot)
    if (add.exitCode !== 0) {
      // A previous failed merge may have left the path; force-remove and retry once.
      await this.git.run(['worktree', 'remove', '--force', integrationWorktree], repoRoot).catch(() => undefined)
      const retry = await this.git.run(['worktree', 'add', integrationWorktree, integrationBranch], repoRoot)
      if (retry.exitCode !== 0) {
        throw new WorktreeError(`create integration worktree failed: ${retry.stderr.trim()}`)
      }
    }
    const merge = await this.git.run(['merge', '--no-ff', branch, '-m', message], integrationWorktree)
    if (merge.exitCode !== 0) {
      await this.git.run(['merge', '--abort'], integrationWorktree).catch(() => undefined)
      await this.git.run(['worktree', 'remove', '--force', integrationWorktree], repoRoot).catch(() => undefined)
      throw new WorktreeError(`merge ${branch} failed: ${merge.stderr.trim()}`)
    }
    // Merge succeeded; cleanup of the temporary integration worktree is
    // best-effort so a leftover path does not fail an already-merged issue.
    await this.git.run(['worktree', 'remove', '--force', integrationWorktree], repoRoot).catch(() => undefined)
  }

  /** Remove a merged worktree and its branch (best-effort cleanup). */
  async removeIssueWorktree(repoRoot: string, workDir: string, branch: string): Promise<void> {
    await this.git.run(['worktree', 'remove', '--force', workDir], repoRoot)
    await this.git.run(['branch', '-D', branch], repoRoot)
  }
}
