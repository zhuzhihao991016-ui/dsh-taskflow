---
name: dsh-taskflow-handle-review
description: Operate the read-only Codex review gate of an installed dsh-taskflow run. Use when INTEGRATION_REVIEW needs review, a PASS or REVISE verdict arrives, rework issues must be resumed, or review-cycle limits lead to WAITING_DECISION.
---

# dsh-taskflow review gate

Use this skill when a run reaches `INTEGRATION_REVIEW` or when a Codex review verdict must be handled.

## Trigger review

- With `autoReview=true`, observe the result; do not issue duplicate review calls.
- Manual mode: `POST /plugins/taskflow/review { runId }` returns `202` when background review starts. Poll `/run` or `/state` until the review finishes.

## Verdicts

- `PASS` → status becomes `AWAITING_HUMAN`; continue to `dsh-taskflow-control-run` for final human acceptance.
- `REVISE` → status returns to `EXECUTING`; the selected issue and its downstream dependencies are reset. Continue to `dsh-taskflow-execute-monitor` to re-run the rework.
- Reaching `maxReviewCycles` → status becomes `WAITING_DECISION`; do not decide for the human. Continue to `dsh-taskflow-control-run`.

## Distinguish rework types

- Codex `REVISE` rework happens inside the same run before final acceptance.
- Human `rework` via `/human-decision` returns the run to `PLANNING` and clears old execution/review state.
