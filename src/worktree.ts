/**
 * P5 Worktree manager: isolates each running Issue in its own Git worktree
 * and merges successful work back into a persistent integration branch. The
 * Git runner is injectable so contract tests drive the manager with fakes;
 * production uses the system `git` executable.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

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

/** Sibling directory that holds the default per-repo worktree roots. */
const DEFAULT_WORKTREES_DIR = '.dsh-taskflow-worktrees'

/** Number of hex characters taken from the normalized repoRoot hash. */
const REPO_ROOT_HASH_LENGTH = 8

/** Short stable hash of a normalized repo root (case-folded on Windows). */
function repoRootHash(repoRoot: string): string {
  let normalized = normalize(resolve(repoRoot)).replace(/\\/g, '/')
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, REPO_ROOT_HASH_LENGTH)
}

/**
 * Resolve the safe root that holds all managed worktrees for one repository.
 * An explicit absolute root is used as-is; an explicit relative root keeps the
 * legacy "relative to repoRoot" semantics; when no root is configured, the
 * root lives in a sibling directory of the repo keyed by a short hash of the
 * normalized repoRoot, so worktrees never pollute the main checkout and
 * same-named repos at different paths cannot collide.
 */
function resolveWorktreesRoot(repoRoot: string, worktreesRoot: string | undefined): string {
  const configured = worktreesRoot?.trim()
  if (configured !== undefined && configured !== '') {
    return isAbsolute(configured) ? resolve(configured) : join(resolve(repoRoot), configured)
  }
  return join(dirname(resolve(repoRoot)), DEFAULT_WORKTREES_DIR, repoRootHash(repoRoot))
}

/**
 * Worktree operations for one repository. The integration branch is the
 * persistent target where every successful Issue branch is merged.
 */
export class WorktreeManager {
  /**
   * @param worktreesRoot Explicit worktree root. Absolute values are used
   * as-is, relative values are resolved against each repoRoot; when omitted,
   * worktrees live outside the repo in a hashed sibling directory.
   */
  constructor(
    private readonly git: GitRunner = execGit,
    private readonly worktreesRoot?: string,
  ) {}

  /** Resolve the managed worktree root for one repository. */
  private worktreeRootFor(repoRoot: string): string {
    return resolveWorktreesRoot(repoRoot, this.worktreesRoot)
  }

  /** Ensure the integration branch exists; create it from baseSha (or HEAD)
   * when missing so the review range stays pinned to the run's captured base. */
  async ensureIntegrationBranch(repoRoot: string, branch: string, baseSha?: string): Promise<void> {
    const check = await this.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot)
    if (check.exitCode === 0) return
    const args = baseSha === undefined ? ['branch', branch] : ['branch', branch, baseSha]
    const create = await this.git.run(args, repoRoot)
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
    baseSha?: string,
  ): Promise<{ workDir: string; branch: string; branchBaseSha: string }> {
    await this.ensureIntegrationBranch(repoRoot, integrationBranch, baseSha)
    const branch = `taskflow/${runId}/${issueKey}`
    const workDir = join(this.worktreeRootFor(repoRoot), runId, issueKey)
    const branchBaseSha = await this.getBranchHeadSha(repoRoot, integrationBranch)
    const add = await this.git.run(['worktree', 'add', '-b', branch, workDir, branchBaseSha], repoRoot)
    if (add.exitCode === 0) return { workDir, branch, branchBaseSha }
    // Crash recovery: a previous attempt may have created the branch or the
    // worktree before the execution record was updated. Reuse a matching
    // existing worktree instead of failing the run.
    const attach = await this.git.run(['worktree', 'add', workDir, branch], repoRoot)
    if (attach.exitCode === 0) {
      return { workDir, branch, branchBaseSha: await this.getMergeBase(repoRoot, branch, integrationBranch) }
    }
    const check = await this.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], workDir)
    if (check.exitCode === 0 && check.stdout.trim() === branch) {
      return { workDir, branch, branchBaseSha: await this.getMergeBase(repoRoot, branch, integrationBranch) }
    }
    throw new WorktreeError(`create worktree for ${issueKey} failed: ${add.stderr.trim()}`)
  }

  /** Resolve the immutable common base of an issue and integration branch. */
  private async getMergeBase(repoRoot: string, branch: string, integrationBranch: string): Promise<string> {
    const result = await this.git.run(['merge-base', branch, integrationBranch], repoRoot)
    if (result.exitCode !== 0 || result.stdout.trim() === '') {
      throw new WorktreeError(`resolve merge base for '${branch}' failed: ${result.stderr.trim()}`)
    }
    return result.stdout.trim()
  }

  /** Resolve a branch's current head SHA (used to pin review to integration). */
  async getBranchHeadSha(repoRoot: string, branch: string): Promise<string> {
    const result = await this.git.run(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot)
    if (result.exitCode !== 0) {
      throw new WorktreeError(`resolve branch head '${branch}' failed: ${result.stderr.trim()}`)
    }
    const sha = result.stdout.trim()
    if (sha === '') {
      throw new WorktreeError(`resolve branch head '${branch}' returned an empty SHA`)
    }
    return sha
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
    baseSha?: string,
  ): Promise<void> {
    await this.ensureIntegrationBranch(repoRoot, integrationBranch, baseSha)
    const integrationWorktree = join(
      this.worktreeRootFor(repoRoot),
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
    // Paths from createIssueWorktree already live under the same resolved
    // root; legacy worktrees from older layouts are still removed as given.
    const root = this.worktreeRootFor(repoRoot)
    const resolved = isAbsolute(workDir) ? resolve(workDir) : resolve(repoRoot, workDir)
    const target = resolved.startsWith(root + sep) ? resolved : workDir
    await this.git.run(['worktree', 'remove', '--force', target], repoRoot)
    await this.git.run(['branch', '-D', branch], repoRoot)
  }

  /** Remove a run-scoped integration branch (used on human rework so the next
   * cycle starts from a clean baseline). Best-effort: a missing branch is not
   * an error. */
  async removeIntegrationBranch(repoRoot: string, branch: string): Promise<void> {
    await this.git.run(['branch', '-D', branch], repoRoot).catch(() => undefined)
  }
}
