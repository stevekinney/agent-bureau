---
'@lostgradient/operative': minor
'conversationalist': minor
'armorer': minor
---

Raise the declared Bun floor from `>=1.3.13` to `>=1.4.0`.

The repository now pins Bun 1.4.0 everywhere it builds and tests: `packageManager`, both
CI jobs, the release workflow, and the Dockerfile. Continuing to advertise `>=1.3.13`
would leave a claim that no gate re-verifies on any pull request, which is the failure
mode AB-169 exists to close. The declared floor now matches the only version actually
tested.

Released as a minor rather than a major because `engines` is advisory: npm and Bun warn
rather than fail unless a consumer opts into strict engine checking. No runtime, type, or
API surface changed in any of these packages.

Consumers still on Bun 1.3.x should upgrade or pin an exact version. The full suite did
pass under 1.3.13 at the time of this change, so the raised floor states what is
supported going forward rather than a known incompatibility.

The same floor was raised on the eight private workspace packages (`bureau`,
`cloudflare`, `evaluation`, `gateway`, `interoperability`, `lifecycle`, `memory`,
`skills`) for internal consistency. Those are unpublished, so they carry no changeset.
