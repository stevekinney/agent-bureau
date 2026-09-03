---
'@lostgradient/operative': minor
---

Add the framework-neutral reactive-source conformance suite (AB-92, delivered by AB-258).

`@lostgradient/operative/test` now exports `runReactiveSourceConformanceSuite<TSnapshot>(options, testRunner?)`, which registers one `describe` block and one `it` per case against any subject implementing `ReactiveSourceSubject<TSnapshot>` (`getSnapshot()`, `subscribeSnapshot(invalidate)`, and an optional `toLocator()`): `stableSnapshotIdentity`, `immutableReplacementAfterChange`, `multipleIndependentSubscribers`, `subscribeReadRaceClosure`, `earlyCompletionBeforeSubscription`, `subscribeUnsubscribeSubscribeNoDuplicateWork`, and — only when `options.reattach` is supplied — `serializableLocatorRoundTrip`.

Any resource that implements `getSnapshot()`/`subscribeSnapshot()` (`ActiveRun` and `AgentRun`'s upcoming snapshot surface, and any later reactive resource) now has a fixed conformance target to satisfy by calling this suite with an adapter, rather than a bespoke set of checks invented per resource.

The suite never imports from `packages/operative/src` outside its own generic parameter, so it stays usable against any conforming subject, in or out of this package. `ReactiveSourceConformanceOptions` and `ReactiveSourceConformanceTestRunner` are also newly exported; the test runner parameter defaults to `bun:test`'s real `describe`/`it` and exists so a caller can capture per-case pass/fail instead of failing the enclosing test file — used by this package's own self-test to prove the suite genuinely catches seven distinct kinds of violation.
