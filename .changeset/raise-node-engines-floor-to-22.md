---
'armorer': minor
'conversationalist': minor
'@lostgradient/operative': minor
---

Raises the declared minimum Node.js version to `>=22` (AB-283). CI has only ever installed and exercised Node 22 — the previous declarations (`armorer`'s `^20.16.0 || >=22.3.0`, `conversationalist`'s `^20.19.0 || ^22.12.0 || >=24`, `operative`'s `>=20.19.0`) claimed lower floors nothing in this repository's CI ever proved. `scripts/check-runtime-matrix.ts` is a new gate, wired into `bun run validate`, that reads every workspace manifest's `engines` field and fails if a declared floor is not exercised by a job in `.github/workflows/ci.yml`; it caught exactly this gap. A consumer already on Node 22 or newer is unaffected; a consumer on Node 20 or 21 that was relying on the unproven lower floor should upgrade to Node 22.

The Bun floor (`>=1.4.0`) is unchanged on all three packages.
