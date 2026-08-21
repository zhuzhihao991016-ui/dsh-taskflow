---
name: dsh-taskflow-submit-plan
description: Operate an installed dsh-taskflow plugin to submit and plan work. Use when creating a run, choosing repoRoot or idempotencyKey, triggering manual planning, or handling RECEIVED, PLANNING, READY, and planning failures.
---

# dsh-taskflow submit & plan

Use this skill when the agent must create a taskflow run or move it through planning. The plugin API is the source of truth; this skill only orients the workflow.

## Submit

- `POST /plugins/taskflow/submit` with `{ title, description?, repoRoot?, idempotencyKey? }`.
- `title` is required. `repoRoot` must be in `allowedRepoRoots`; an empty allowlist disables planning.
- Reuse the same `idempotencyKey` only for the same request. A different request under the same key is rejected.

## Plan

- With P8.6 defaults, automation is on and `repoRoot` is set, so planning may start automatically after submit. Execution then waits in `WAITING_PERMISSION` until a human `release`. Observe `/plugins/taskflow/state` or `/plugins/taskflow/run` instead of issuing duplicate `plan` calls.
- Manual mode: `POST /plugins/taskflow/plan { runId }` returns `202` when background planning starts. Poll `/run` or `/state` until status becomes `READY` or `FAILED`.
- On `READY`, continue to `dsh-taskflow-execute-monitor`. On planning failure, read the error and decide whether to retry with a corrected request.
