---
name: dsh-taskflow-use-console
description: Operate the browser console of an installed dsh-taskflow plugin. Use when opening the board or run-detail drawer, following live SSE updates, acting on allowedActions with confirmation, or diagnosing a browser-console action failure.
---

# dsh-taskflow browser console

Use this skill when operating taskflow through the browser board, run-detail drawer, or live SSE updates.

## Open and refresh

- Open the kanban board from the taskflow status card, then open a run card to see the run-detail drawer.
- The drawer refreshes from `GET /plugins/taskflow/run` and run-scoped SSE. Use the latest drawer state before acting.

## Act

- Only click buttons listed in `allowedActions`.
- The first click enters a confirmation state; the second click sends the actual POST.
- `accept`/`rework` route to `/human-decision`; other actions route to `/command`.

## On failure

- Keep the error visible and refresh the drawer.
- If browser UI diagnosis is not enough, switch to `dsh-taskflow-control-run` for direct API actions.
