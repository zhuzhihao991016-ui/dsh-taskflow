---
name: dsh-taskflow-control-run
description: Control and complete an installed dsh-taskflow run at human intervention points. Use when allowedActions includes pause, resume, cancel, takeover, release, retry, accept, or rework, or when handling WAITING_PERMISSION, WAITING_DECISION, PAUSED, FAILED, or AWAITING_HUMAN.
---

# dsh-taskflow control & human decisions

Use this skill when a run needs a control action or a final human decision.

## Read live state first

- Always `GET /plugins/taskflow/run?runId=<id>` before acting.
- Only use actions present in `run.allowedActions`; a stale action can return `409`.

## Commands

- `pause`, `resume`, `cancel`, `takeover`, `release`, and `retry` go to `POST /plugins/taskflow/command { runId, action }`.
- `accept` and `rework` go to `POST /plugins/taskflow/human-decision { runId, decision }` and are valid only at `AWAITING_HUMAN`.
- Human decisions and destructive controls require an explicit human decision. Do not invent one.
- On `409`, re-read `/run` and re-evaluate; do not blindly retry the same action.

## Outcome map

- `release` or execution `resume` → back to `EXECUTING` when applicable.
- `retry` resumes the failed phase: planning, execution, or integration review.
- `accept` → `ACCEPTED`.
- `rework` → `PLANNING` and clears old execution/review state.
- Continue to the relevant lifecycle skill after the state changes.
