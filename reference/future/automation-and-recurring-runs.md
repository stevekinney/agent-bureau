# Automation And Recurring Runs

## Goal

Promote the scheduler from an administrative tool into a user-facing automation system. The outcome is repeatable and inspectable recurring work, not just ad hoc task submission.

## In Scope

- recurring schedules with cron-like expressions or interval definitions
- retry policy, failure backoff, and dead-letter handling
- run history and audit-friendly job history
- notification hooks for success, failure, and repeated failure
- operator controls for pause, resume, skip-next, and manual re-run

## Out of Scope

- cross-tenant orchestration and billing policy
- external workflow engines as a dependency for version one
- fully arbitrary DAG orchestration between recurring jobs

## Acceptance Signals

- a recurring job can create runs on schedule without manual intervention
- operators can cancel, pause, and resume recurring jobs through the gateway
- job history survives restart and distinguishes scheduled runs from manual runs
- failed jobs expose retry counts, latest error, and next scheduled attempt
