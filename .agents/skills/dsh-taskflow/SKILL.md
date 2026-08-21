---
name: dsh-taskflow
description: User entry point to the dsh-taskflow skill suite. Invoke this skill by name to choose the right taskflow workflow guide.
disable-model-invocation: true
user-invocable: true
---

# dsh-taskflow entry

## Invocation boundary

Run this skill only when the user explicitly invokes `dsh-taskflow` by name. It is a router for the model-invoked taskflow skills; do not auto-load it from ordinary taskflow work.

## What it routes

| User goal | Skill to use |
|---|---|
| Submit a task or plan Issues | `dsh-taskflow-submit-plan` |
| Execute or monitor a run | `dsh-taskflow-execute-monitor` |
| Handle checkpoint/final review or remediation | `dsh-taskflow-handle-review` |
| Pause, resume, cancel, accept, or rework | `dsh-taskflow-control-run` |
| Configure automation, Codex scenes, CLI path, or login | `dsh-taskflow-configure-automation` |
| Use the browser board or run console | `dsh-taskflow-use-console` |

The model loads the matching skill automatically when the conversation reaches that stage. This entry skill only helps the user name the area or confirm which workflow guide applies.
