# Releasing

Three packages publish to npm from this monorepo: **`armorer`**, **`conversationalist`**, and
**`@lostgradient/operative`**. They publish via
[npm **trusted publishing** (OIDC)](https://docs.npmjs.com/trusted-publishers) — no npm tokens are
stored anywhere. Every other package in the workspace is internal and never published. The full,
explicit inventory of publishable packages lives in `RELEASE_INVENTORY` in `scripts/release.ts`, as
`{ directory, packageName }` entries — `directory` is the path under `packages/`; `packageName` is
the name the package publishes under on npm (unscoped for `armorer`/`conversationalist`, scoped for
`operative`).

> [!NOTE] Why these three
> `armorer`, `conversationalist`, and `@lostgradient/operative` are the only package names owned on
> npm by the maintainer. Their shared internal primitives (`lifecycle`, `interoperability`) are
> **inlined into the published packages at build time** (both JavaScript and type declarations), so
> the published artifacts depend on none of them directly. `operative` additionally depends on the
> published `armorer` and `conversationalist` packages by ordinary semver range — not
> `workspace:*` — since consumers outside the monorepo cannot resolve a workspace protocol.
> Internally, every workspace package keeps depending on the others via `workspace:*`.

## Day-to-day: how to ship a change

1. In your feature branch, make the change to `armorer`, `conversationalist`, and/or `operative`.
2. Add a changeset describing the release:
   ```bash
   bun run changeset
   ```
   Pick the package(s), choose `patch` / `minor` / `major`, and write a one-line summary. Commit the
   generated file in `.changeset/`.
3. Open your PR. CI (`ci.yml`) runs `validate`, builds the publishable packages, and runs the
   package-shape gate. A change to an inlined foundation package that affects a product's output is
   captured by a changeset on the **product** — there is no changeset for `lifecycle`/`interoperability`.
4. Merge to `main`. The release workflow (`release.yml`) opens — or updates — a **"Version
   Packages"** PR that applies the version bumps and updates each `CHANGELOG.md`.
5. Review and merge the **Version Packages** PR. That merge triggers the publish: each changed
   package is published to npm with provenance. Unchanged packages are skipped automatically.
   (Publishing only happens once `RELEASE_ENABLED` is armed — see the next section.)

That's it. No manual `npm publish`, no version editing by hand, no tokens.

## Publishing is opt-in (the `RELEASE_ENABLED` switch)

The release workflow runs on every push to `main`, but `scripts/release.ts` **does not publish**
unless the `RELEASE_ENABLED` repository variable is `"true"`. This lets the pipeline land on `main`
(and run green) without shipping anything until you're ready.

To arm publishing once the trusted publishers are registered (below): GitHub repo → **Settings** →
**Secrets and variables** → **Actions** → **Variables** → add `RELEASE_ENABLED` = `true`. Until that
variable is set, merges run the workflow as a safe no-op for the publish step.

## One-time setup: register the trusted publisher (per package)

Trusted publishing has to be enabled once per package on npm, and npm will only let you register a
trusted publisher for a name that already exists on the registry — see
[Bootstrap versus trusted publication](#bootstrap-versus-trusted-publication) below for what that
means for a package's first version. `armorer` and `conversationalist` have been on the registry
since before this pipeline existed, so registration for them can happen immediately.
`@lostgradient/operative` reached the registry via its own bootstrap publish (`0.1.0`, published
manually to claim the name); its trusted publisher still needs to be registered before its first
publish through this pipeline.

For each package, on [npmjs.com](https://www.npmjs.com): open the package → **Settings** →
**Trusted Publisher** → **GitHub Actions**, and enter:

- **Organization or user:** `stevekinney`
- **Repository:** `agent-bureau`
- **Workflow filename:** `release.yml` (the file name only — not a path)
- **Allowed action:** `npm publish`

> [!IMPORTANT] The workflow file name is load-bearing
> npm pins the trusted publisher to the exact workflow filename `release.yml`. If that file is ever
> renamed, update the trusted-publisher configuration on npm or the next publish fails.

### Preflight before the first real release

Before arming `RELEASE_ENABLED` and merging the **first** Version Packages PR, confirm every package
in `RELEASE_INVENTORY` has its trusted-publisher entry pointing at `stevekinney/agent-bureau` +
`release.yml`. If OIDC is not configured, the publish step fails with an authentication/provenance
error (e.g. `404`/`401` from the registry or a provenance-generation error). Recovery is
fix-forward: configure the trusted publisher, then re-run the release workflow — already-published
versions are skipped, so re-running is safe.

> [!NOTE] Order of operations for going live
>
> 1. Register the trusted publishers on npm for every package in `RELEASE_INVENTORY`. 2. Set
>    `RELEASE_ENABLED=true`. 3. Add a changeset and merge it; merge the resulting Version Packages PR
>    to publish. Doing step 2 before step 1 makes the first publish fail auth (harmless, fix-forward).

> [!NOTE] Local versions are ahead of the registry
> At the time this pipeline was set up, the working tree carried `armorer@0.7.1` and
> `conversationalist@0.0.12` while the registry's latest were `0.6.1` / `0.0.11`. The first release
> publishes whatever version is in each `package.json` when the Version Packages PR merges. Going
> forward, **let changesets own the version numbers** — add a changeset rather than hand-editing
> `version`.

## Bootstrap versus trusted publication

Adding a brand-new package to the release pipeline is a two-stage sequence, because trusted
publishing can only be configured for a package name that **already exists** on npm — there is no
way to register a trusted publisher for a name nobody has claimed yet.

**Stage 1 — bootstrap-publish (one-time, manual, outside this pipeline).** Publish the package once
by hand to claim the name, from the package directory, after a clean build:
`npm publish --access public` — optionally with a short-lived granular token. This is a manual,
out-of-band step precisely because the automated pipeline can't publish a package it doesn't yet
know about, and npm can't register a trusted publisher for a name that isn't claimed. This is what
happened for `@lostgradient/operative`: version `0.1.0` was bootstrap-published manually to claim the
name before any of the wiring below existed.

**Stage 2 — wire into trusted publication (this document, done once per package).**

1. Register the trusted publisher for the package (see the section above) — this can only be done
   now that the bootstrap publish has claimed the name.
2. Add the package to the release pipeline: remove it from the `ignore` list in
   `.changeset/config.json` and add a `{ directory, packageName }` entry to `RELEASE_INVENTORY` in
   `scripts/release.ts`. Add the package's `packageName` to the `--filter` list in the "Build
   publishable packages" step of both `.github/workflows/release.yml` and `.github/workflows/ci.yml`.
   Make sure its build produces self-contained artifacts (the package-shape gate enforces this).

From then on, every subsequent version releases through the normal changeset flow — add a
changeset, merge to `main`, merge the resulting Version Packages PR — with no further manual
`npm publish` for that package. This is exactly the sequence `@lostgradient/operative` follows: the
bootstrap publish of `0.1.0` happened first and separately; this document's Stage 2 wires it into the
pipeline without publishing a version; its next release goes out entirely through trusted publication.

## How the pipeline is wired

- **`.changeset/config.json`** — `access: public`, `baseBranch: main`, and an `ignore` list of every
  package except the publishable ones. `changeset version` never touches ignored packages and
  preserves internal `workspace:*` references.
- **`.github/workflows/ci.yml`** — runs on PRs: `validate` + build + the package-shape gate.
- **`.github/workflows/release.yml`** — runs on push to `main`. Pins `npm@^11` (trusted publishing
  needs npm ≥ 11.5.1), then `changesets/action` opens the Version Packages PR or, once it merges,
  runs `bun run release`. Permissions include `id-token: write` for OIDC; no `NPM_TOKEN` is set.
- **`scripts/release.ts`** — exports `RELEASE_INVENTORY`, the explicit list of publishable packages
  as `{ directory, packageName }` entries, and is the idempotent publisher: skips already-published
  versions, runs the shape gate before each publish, and publishes with `npm publish --provenance
--access public --ignore-scripts` from the package directory (provenance requires publishing from
  a directory, not a prebuilt tarball). On partial failure it stops without unpublishing; re-running
  is safe.
- **`scripts/check-package-shape.ts`** — the fail-closed gate: asserts every `package.json` file
  target resolves, no shipped code imports `lifecycle`/`interoperability`, every other
  external is declared, no payload-mutating lifecycle script exists, and no source is shipped.
