---
name: dsh-taskflow-configure-automation
description: Configure an installed dsh-taskflow plugin for automatic or manual operation. Use when setting automationEnabled, autoPlan, autoReview, requireExecutionPermission, concurrency, review-cycle limits, allowedRepoRoots, or verifying the mode recorded on a run.
---

# dsh-taskflow automation configuration

Use this skill when changing or verifying how a taskflow run behaves: automatic vs manual, permission gates, concurrency, or repo allowlist.

## P8.6 defaults

- `automationEnabled=true`, `autoPlan=true`, `autoReview=true`.
- `requireExecutionPermission=true`, `maxReviewCycles=3`, `maxExecutorProcesses=2`.
- Set `automationEnabled=false` to restore manual/agent-driven mode.
- Set `requireExecutionPermission=false` only when unattended automatic execution is intended.

## Settings

- `maxConcurrent` controls parallel issues within one run.
- `maxExecutorProcesses` is the global cap on concurrent Codex executor processes.
- `autoReview=true` enables both per-Issue `CHECKPOINT` review and the all-Issue `FINAL` review.
- `maxReviewCycles` limits automated `FIX` / `REPLAN` revision decisions across both stages before human intervention.
- `allowedRepoRoots=[]` disables planning because no repo root is allowed.
- `requireExecutionPermission=true` makes runs wait in `WAITING_PERMISSION` until a human `release`.

## Apply and verify

- Configuration is applied through the host's live config patch (`hotReload=config-patch-live`); there is no HTTP config route. If the host reports that live reload failed, restart that host before relying on the new values.
- After a new run is created, verify `GET /plugins/taskflow/run?runId=<id>` and check `automation.enabled` / `automation.mode`.
