# @lostgradient/lifecycle

## 0.0.3

### Patch Changes

- 95de2e2: `createManualRuntimeServices` throws a `RangeError` at construction when its `clockOrigin` is not a parsable ISO-8601 timestamp, instead of admitting `NaN` into the virtual wall clock.

## 0.0.2

### Patch Changes

- 1b5a7af: Publish these four packages through `release.yml` with npm provenance. Their first versions were claimed by a one-time interactive publish so that trusted publishing could be registered for them, and those versions carry no provenance attestation. This release carries the same source.
