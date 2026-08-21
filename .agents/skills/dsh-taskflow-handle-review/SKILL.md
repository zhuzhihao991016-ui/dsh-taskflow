---
name: dsh-taskflow-handle-review
description: Operate the two-stage read-only Codex review gate of an installed dsh-taskflow run. Use when an EXECUTING checkpoint or INTEGRATION_REVIEW final review is active, PASS or REVISE arrives with CONTINUE, FIX, or REPLAN, rework must resume, or review-cycle limits lead to WAITING_DECISION.
---

# dsh-taskflow review gate

Use this skill when an automatic review is active or when its structured decision must be routed.

## Review stages

- `CHECKPOINT`: after each successful Issue and before merge, the configured checkpoint model/effort checks direction and scope (default `gpt-5.6-sol / medium`). It runs automatically when `autoReview=true`.
- `FINAL`: after every Issue has merged, the configured final model/effort reviews the complete integration diff (default `gpt-5.6-sol / max`).
- Both stages are read-only. With `autoReview=true`, observe instead of issuing duplicate calls. `POST /plugins/taskflow/review { runId }` manually starts only `FINAL` while the run is in `INTEGRATION_REVIEW`.

## Route decisions

- `PASS / CONTINUE`: a checkpoint permits merge; a final review enters `AWAITING_HUMAN`.
- `REVISE / FIX`: a checkpoint preserves the worktree and requeues the same Issue; a final review resets the selected Issue and its downstream dependencies.
- `REVISE / REPLAN`: stop the current execution wave, clean its run-level Git artifacts, return to `PLANNING`, and pass the review findings to the planner.
- Reaching `maxReviewCycles` across revision decisions enters `WAITING_DECISION`; do not decide for the human.

## Continue the workflow

- After `FIX`, continue to `dsh-taskflow-execute-monitor`.
- After `REPLAN`, continue to `dsh-taskflow-submit-plan` and observe the existing run.
- After final `PASS`, continue to `dsh-taskflow-control-run` for human acceptance.
- Human `rework` via `/human-decision` returns the run to `PLANNING` and clears old execution/review state.
