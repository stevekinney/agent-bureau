# Multi-Agent Workbench

## Goal

Turn the existing supervisor, subagent, and registry primitives into a first-class task orchestration product. The target is a workbench where one run can delegate bounded work to multiple child runs and show the state of that work clearly.

## In Scope

- explicit task objects with parent and child relationships
- delegated runs with ownership, status, and result summaries
- supervisor policies for fan-out, fan-in, and escalation
- a workbench UI that shows active tasks, blocked tasks, and completed tasks
- persistence for task graphs so an interrupted session can be resumed

## Out of Scope

- general-purpose workflow automation across external systems
- billing, quotas, or tenant-level scheduling policy
- arbitrary distributed execution beyond the current workspace runtime

## Acceptance Signals

- a parent run can create multiple child runs and wait on their results
- task graphs survive a process restart when persistent storage is configured
- the UI can distinguish queued, running, blocked, failed, and completed delegated work
- delegated work is traceable from the parent session and individual child sessions
