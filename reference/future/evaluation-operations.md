# Evaluation Operations

## Goal

Take the `evaluation` package from library capability to release discipline. The target is a repeatable process for curating datasets, running evaluations, comparing results, and gating changes.

## In Scope

- canonical dataset storage and versioning
- named evaluation suites for product surfaces and agent profiles
- regression comparison and release thresholds
- CI integration and report publication
- operational dashboards for pass rate, cost, latency, and drift

## Out of Scope

- custom model training or fine-tuning pipelines
- a full analytics warehouse
- synthetic dataset generation as the primary evaluation strategy

## Acceptance Signals

- a release candidate can be gated on explicit evaluation thresholds
- historical reports can be compared by suite, agent configuration, and dataset version
- evaluation failures link back to the concrete prompts, tool traces, or outputs that failed
- cost and latency regressions are visible alongside accuracy regressions
