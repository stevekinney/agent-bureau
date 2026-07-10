# syntax=docker/dockerfile:1
#
# Reference Dockerfile for self-hosting the agent-bureau gateway (AB-80).
# See documentation/deployment.md for the full deployment guide.
#
# `gateway` is a private, unpublished workspace package (no `exports` map,
# consumed only via `workspace:*`), so the image is built from the FULL
# monorepo context rather than a single package — there is no "install the
# gateway package" path. This mirrors the fork-the-template posture the
# project has settled on (see the roadmap's AB-81 decision record).
FROM oven/bun:1.3.13-slim

WORKDIR /app

# Full workspace context: turbo's build pipeline needs the root config
# (turbo.json, tsconfig.base.json, eslint.config.base.ts) alongside every
# package, and gateway's build externalizes its workspace dependencies
# rather than bundling them (see packages/bureau/scripts/build.ts's comment
# for why bundling weft specifically breaks), so those dependencies must be
# built too. `.dockerignore` strips node_modules, dist, .git, and other
# non-source content from the build context first.
COPY . .

# `--ignore-scripts` skips the root package's `prepare` script (`lefthook
# install`, this workspace's git-hooks manager) — it needs a real git
# repository and git-hook installation is meaningless in a container image
# anyway. No workspace dependency needs a lifecycle script under Bun: sqlite
# storage uses Bun's built-in `bun:sqlite` (no native module to build), and
# lmdb (native, optional) is not installed by default — see
# documentation/deployment.md's storage backend section.
RUN bun install --frozen-lockfile --ignore-scripts

# Build gateway and every workspace package it depends on, in dependency
# order (turbo resolves the graph). This step also produces gateway's own
# `dist/manifest.json` and `dist/public/*`, which the server needs to serve
# the browser UI's hashed asset bundle — `bun run src/start.ts` runs the
# SERVER from source (Bun executes TypeScript directly, no bundling
# required for the process entrypoint itself), but the client asset
# manifest is only ever produced by the build.
RUN bunx turbo run build --filter=gateway

# Runtime configuration — see documentation/deployment.md for the full
# environment contract. Override AUTH_TOKEN, the provider API key, and
# STORAGE_PATH at minimum for anything beyond local evaluation.
ENV STORAGE_TYPE=sqlite
ENV STORAGE_PATH=/data/agent-bureau.sqlite
ENV PORT=5555
ENV HOSTNAME=0.0.0.0

# The durable store lives here — mount a volume at /data so runs and
# sessions survive container recreation. See "Backup and restore" in
# documentation/deployment.md.
VOLUME ["/data"]

EXPOSE 5555

WORKDIR /app/packages/gateway

# Runs src/start.ts (the process entrypoint), NOT dist/index.js — the
# gateway package's dist is a library barrel with no bootstrap. See
# packages/gateway/src/start.ts.
CMD ["bun", "run", "start"]
