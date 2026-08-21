---
name: dsh-taskflow-execute-monitor
description: Operate and monitor execution of an installed dsh-taskflow run. Use when claiming planned issues in manual mode, working in taskflow worktrees, reporting execution or progress, reading state, board, run detail, or SSE events, and handling READY, EXECUTING, INTEGRATION_REVIEW, or FAILED.
---

# dsh-taskflow execute & monitor

Use this skill after a run is `READY`, during `EXECUTING`, or when observing execution output. It covers manual claiming, result reporting, and progress events.

## Observe

- `GET /plugins/taskflow/state` returns `{ runs: [...] }`; use `runs[].executions` as the authoritative parallel-issue list.
- `GET /plugins/taskflow/board` returns the kanban columns.
- `GET /plugins/taskflow/run?runId=<id>` returns automation mode, current issue, allowed actions, and recent events.
- `GET /plugins/taskflow/events?runId=<id>` opens an SSE stream for run-scoped live events.

## Execute (manual mode)

- In automatic mode, only observe; the coordinator drives execution.
- In manual mode, call `POST /plugins/taskflow/execute { runId }` to claim the next schedulable issues. The HTTP response exposes `currentIssue`; for parallel state, read `/state`.
- Work inside the returned `workDir`/`branch`, then report with `POST /plugins/taskflow/exec-result { runId, issueKey, ok, summary? }` or `{ runId, issueKey, ok: false, error }`.
- Call `/execute` again after each completed batch to claim more issues.
- Use `POST /plugins/taskflow/progress { runId, issueKey, phase, attemptId?, summary? }` only for automated-executor progress; `phase` must be one of the executor phases.

## Transitions

- All issues done → `INTEGRATION_REVIEW`; continue to `dsh-taskflow-handle-review`.
- Run `FAILED` → inspect the error and, if `retry` is available, continue to `dsh-taskflow-control-run`.

## Codex CLI compatibility

- The built-in automated executor invokes `codex exec --full-auto --sandbox workspace-write --json`.
- Do not use `--ask-for-approval`; current Codex CLI (0.146.x) does not accept it and exits with a process failure.
- The plugin spawns Codex through the Node entry directly, not through Git Bash or PowerShell, so Windows paths are passed as argv without shell escaping.
