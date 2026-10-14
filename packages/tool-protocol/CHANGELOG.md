# @lostgradient/tool-protocol

## 0.0.3

### Patch Changes

- 95de2e2: Bound async tool-result materialization by cancellation: an already-aborted signal rejects immediately with its reason, and an abandoned iterator is asked to close in the background, so a `return()` that never settles no longer holds an aborted materialization open and one that rejects no longer surfaces as an unhandled rejection.
- Updated dependencies [95de2e2]
  - @lostgradient/lifecycle@0.0.3

## 0.0.2

### Patch Changes

- 4ea2a5a: Publish the current Corvidae mirror's tool materialization, authorization and idempotency, conversation persistence, and durable agent execution changes.

## 0.0.1

### Patch Changes

- 1b5a7af: Publish these four packages through `release.yml` with npm provenance. Their first versions were claimed by a one-time interactive publish so that trusted publishing could be registered for them, and those versions carry no provenance attestation. This release carries the same source.
- Updated dependencies [1b5a7af]
  - @lostgradient/lifecycle@0.0.2
