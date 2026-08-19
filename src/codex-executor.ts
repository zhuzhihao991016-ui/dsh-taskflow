/**
 * P8.2 compatibility alias: the built-in Codex Issue Executor lives in
 * `src/issue-executor.ts`; this module keeps the conventional
 * `codex-*` adapter naming importable from either path.
 */
export {
  CodexIssueExecutor,
  CodexExecutor,
  IssueExecutorError,
  buildIssuePrompt,
  parseIssueResult,
  writeIssueExecutionSchema,
  ISSUE_EXECUTION_OUTPUT_SCHEMA,
  DEFAULT_ISSUE_EXECUTOR_TIMEOUT_MS,
  DEFAULT_ISSUE_EXECUTOR_MAX_RETRIES,
} from './issue-executor.ts'
export type { IssueExecutorErrorCode } from './issue-executor.ts'
