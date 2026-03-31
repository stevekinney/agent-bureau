# Human-In-The-Loop Controls

## Goal

Build the operator-facing review surface for risky work: approvals, notifications, review queues, and audit trails. The intent is to make intervention explicit and inspectable instead of relying on ad hoc communication.

## In Scope

- approval queues for tool calls, delegated tasks, and release-affecting actions
- notification channels for review-required and failure-required attention
- review workflows for accept, reject, request changes, and escalate
- durable audit logs tied to sessions, runs, tools, and operator identity
- configurable policy tiers that determine when review is mandatory

## Out of Scope

- enterprise compliance frameworks beyond audit-friendly data capture
- generalized ticketing or incident management platforms
- custom messaging infrastructure outside the existing gateway ecosystem

## Acceptance Signals

- risky actions can be paused pending explicit human approval
- operators can see why a task was blocked and what evidence is attached to it
- approval and rejection decisions are durable and attributable
- review-required runs can resume from the exact approval boundary after a decision
