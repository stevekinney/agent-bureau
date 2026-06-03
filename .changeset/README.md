# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It drives
releases for the two published packages — **`armorer`** and **`conversationalist`**. Every other
workspace package is listed under `ignore` in `config.json` and is never versioned or published.

## Add a changeset

When a pull request changes `armorer` or `conversationalist` in a way that should ship, add a
changeset:

```bash
bun run changeset
```

Pick the package(s) and the bump type (patch / minor / major) and write a one-line summary. The
generated markdown file is committed with your PR.

> A change to an inlined foundation package (`lifecycle`, `interoperability`, `storage`) that
> alters a published package's output is captured by a changeset on the **product** (`armorer` /
> `conversationalist`) — not on the foundation package, which is never published.

## What happens next

Merging to `main` runs the release workflow, which opens (or updates) a **"Version Packages"** pull
request applying the bumps and updating changelogs. Merging that pull request publishes the changed
packages to npm with provenance via trusted publishing. See `RELEASING.md` at the repo root.
