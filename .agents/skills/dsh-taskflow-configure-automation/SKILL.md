---
name: dsh-taskflow-configure-automation
description: Configure an installed dsh-taskflow plugin and its Codex CLI scenes. Use when choosing planning, checkpoint, or final-review models and reasoning effort; opening Codex login; setting CLI path, automation, permission gates, concurrency, review-cycle limits, allowedRepoRoots; or verifying effective mode.
---

# dsh-taskflow configuration

Use this skill when changing or verifying Taskflow's Codex scenes, CLI account readiness, automatic/manual behavior, permission gates, concurrency, or repo allowlist.

## P8.6 defaults

- Planning: `gpt-5.6-sol / max`; checkpoint: `gpt-5.6-sol / medium`; final: `gpt-5.6-sol / max`.
- `automationEnabled=true`, `autoPlan=true`, `autoReview=true`.
- `requireExecutionPermission=true`, `maxReviewCycles=3`, `maxExecutorProcesses=2`.
- Set `automationEnabled=false` to restore manual/agent-driven mode.
- Set `requireExecutionPermission=false` only when unattended automatic execution is intended.

## Settings

- `codexPlanningModel` / `codexPlanningEffort` configure initial planning and `REPLAN`.
- `codexCheckpointModel` / `codexCheckpointEffort` configure the per-Issue direction review.
- `codexFinalModel` / `codexFinalEffort` configure the all-Issue integration review.
- `codexCliPath` selects a `.js` or `.exe` CLI entry; an empty value uses normal discovery.
- `maxConcurrent` controls parallel issues within one run.
- `maxExecutorProcesses` is the global cap on concurrent Codex executor processes.
- `autoReview=true` enables both per-Issue `CHECKPOINT` review and the all-Issue `FINAL` review.
- `maxReviewCycles` limits automated `FIX` / `REPLAN` revision decisions across both stages before human intervention.
- `allowedRepoRoots=[]` disables planning because no repo root is allowed.
- `requireExecutionPermission=true` makes runs wait in `WAITING_PERMISSION` until a human `release`.

## Apply and verify

- Prefer the native `Settings → Plugins → Plugin configuration → Taskflow` card. It reads `codex debug models`, narrows effort choices to the selected model, and persists the `taskflow` settings namespace.
- Codex model, effort, and CLI-path changes apply on the next planning or review call. Restart the plugin before relying on changed automation, concurrency, repository, worktree, announcement, or team-board settings.
- `GET /plugins/taskflow/codex/auth` returns only CLI availability and a boolean login state. `POST /plugins/taskflow/codex/login {}` explicitly launches local browser login; wait for the human to finish OAuth, then refresh auth status.
- `GET /plugins/taskflow/codex/models?refresh=1` refreshes the sanitized model catalog. Treat a bundled fallback as usable but potentially older than the CLI-refreshed catalog.
- `GET /plugins/taskflow/status` reports next-invocation scenes in `status.codex`, effective runtime values in `status.automation`, and restart-only changes in `status.settings.pendingRestartFields`.
- After a new run is created, verify `GET /plugins/taskflow/run?runId=<id>` and check `automation.enabled` / `automation.mode`.
