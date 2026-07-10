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
# order (turbo resolves the graph). This step produces both gateway's own
# `dist/start.js` (the built process entrypoint the CMD below runs) and
# `dist/manifest.json` + `dist/public/*` (the browser UI's content-hashed
# asset bundle). Running `src/start.ts` from source instead would degrade
# `server/render.ts` to unhashed `/public/entry.js` URLs that the build
# never produces — see the comment on `start.ts` for why the built output
# is required, not just recommended, for this specific entrypoint.
RUN bunx turbo run build --filter=gateway

# Runtime configuration — see documentation/deployment.md for the full
# environment contract. Override AUTH_TOKEN and the provider API key at
# minimum for anything beyond local evaluation.
#
# STORAGE_PATH is deliberately NOT set here: start.ts's own per-STORAGE_TYPE
# default (`./data/agent-bureau.sqlite` for sqlite, `./data/agent-bureau-lmdb`
# for lmdb) resolves relative to WORKDIR below and lands inside the volume
# declared there. Hard-coding a sqlite-shaped path here would silently break
# the moment STORAGE_TYPE=lmdb is set without also overriding STORAGE_PATH —
# exactly the failure mode this comment exists to avoid.
ENV STORAGE_TYPE=sqlite
ENV PORT=5555
ENV GATEWAY_HOST=0.0.0.0

EXPOSE 5555

WORKDIR /app/packages/gateway

# The durable store lives at ./data relative to WORKDIR (start.ts's default
# for both sqlite and lmdb) — mount a volume there so runs and sessions
# survive container recreation. See "Backup and restore" in
# documentation/deployment.md.
VOLUME ["/app/packages/gateway/data"]

# "start" runs the BUILT dist/start.js (the process entrypoint), not
# dist/index.js (a library barrel with no bootstrap) and not src/start.ts
# from source (see packages/gateway/src/start.ts for why running from
# source would break the browser UI's asset bundle).
CMD ["bun", "run", "start"]
