# Self-hosting the gateway (AB-80)

A deployment guide for running the `gateway` package as a standalone service:
the single-node Bun lane, storage backend choice, the durable-execution
defaults, API-key bootstrap, reverse-proxy/TLS notes, and backup/restore of
the durable store. Reference artifacts (`Dockerfile`,
`docker-compose.deployment.yaml`) live at the repository root and are
described in [Reference Dockerfile and compose file](#reference-dockerfile-and-compose-file)
below.

`gateway` is a private, unpublished workspace package — `"private": true`, no
`exports` map, consumed only as `workspace:*` inside this monorepo. There is
no `npm install gateway`. Per the roadmap's AB-81 decision, the supported
self-host path is **fork the repository**: clone (or fork) it, `bun install`,
`turbo run build --filter=gateway`, configure via `createBureau()`/
`createGateway()` options (or the environment-driven entrypoint described
below), and run it. This guide and the reference Dockerfile are that path,
made concrete.

## Single-node Bun deployment (the optimized lane)

The gateway is built for one thing to be true: **one Bun process, one durable
store, one node.** That is not a v1 limitation being apologized for — it is
the deliberate, documented shape of the current deployment story (see
[the one-engine-per-store constraint](#the-one-engine-per-store-constraint-ab-14)
below for exactly why horizontal scaling isn't safe yet).

Concretely:

- Run `gateway` under Bun (`typeof Bun !== 'undefined'`), not Node. `createGateway()`
  auto-detects the runtime and Bun is the first-class path — Bun's
  `Bun.serve()` WebSocket handling, `bun:sqlite`, and native TypeScript
  execution are all exercised directly with no transpile or polyfill layer.
  A Node adapter exists (`@hono/node-server` as an optional peer) for
  environments that require it, but it is not the tuned path.
- Run exactly one gateway process per durable store (sqlite file or LMDB
  directory). Do not point two processes, and do not point two replicas of
  an autoscaled deployment, at the same storage path.
- Scale vertically (bigger instance) rather than horizontally (more
  instances sharing one store) until the multi-engine coordination story
  lands upstream in Weft.
- Use `replicas: 1` with a `Recreate` (stop-then-start) deploy strategy, not
  `RollingUpdate` — a rolling update briefly runs the old and new process
  against the same store, which is exactly the overlap the one-engine
  constraint forbids. A single systemd unit or a single container with
  `restart: unless-stopped` (as in the reference compose file) has the same
  property by construction.

### The process entrypoint

`gateway`'s own `src/index.ts` is a **library barrel** — it exports
`createGateway`, `resolveGenerate`, and a few types. Importing it starts
nothing. The process entrypoint that actually boots a listening server from
environment variables is `packages/gateway/src/start.ts`. It:

1. Parses and validates `Bun.env` with a Zod schema (`parseStartEnvironment`).
2. Resolves that into `BureauOptions`/`GatewayOptions` (`resolveStartOptions`
   — a pure function, unit-tested directly).
3. Ensures the storage path's parent directory exists for file-backed
   backends (`bun:sqlite` creates the database file but not its containing
   directory).
4. Builds the bureau (`createBureau`), wraps it in a gateway
   (`createGateway`), and starts listening.
5. Installs `SIGTERM`/`SIGINT` handlers that stop the HTTP server, dispose
   the bureau, and exit cleanly — required for a container orchestrator's
   graceful-shutdown grace period to actually do something.

`bun run start` (the reference `Dockerfile`'s `CMD`) runs the **built**
`dist/start.js`, not this source file — see
[Reference Dockerfile and compose file](#reference-dockerfile-and-compose-file)
below for why that distinction is load-bearing, not just convention. `bun
run dev` runs source (`bun --watch run src/start.ts`) for a fast local
iteration loop; it shares the same environment contract but won't correctly
serve the browser UI's hashed asset bundle (see the same section).

If you are embedding the gateway in your own process rather than running it
standalone, call `createBureau()`/`createGateway()` directly (see the
package READMEs) — `start.ts` is just the reference bootstrap for the
"run this as a service" case, not a required abstraction layer.

### Environment variables

| Variable                       | Default                                                                   | Notes                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | `5555`                                                                    | HTTP port. `0` binds an OS-assigned ephemeral port.                                                                                                                                                                  |
| `GATEWAY_HOST`                 | runtime default                                                           | Bind address; set `0.0.0.0` in a container so it's reachable from outside. Deliberately NOT named `HOSTNAME` — see the code comment on `EnvironmentSchema` for why reading that ambient variable would be a footgun. |
| `AUTH_TOKEN`                   | unset                                                                     | Static bearer token, unrestricted admin scope. See [API key bootstrap](#api-key-bootstrap).                                                                                                                          |
| `STORAGE_TYPE`                 | `sqlite`                                                                  | `sqlite` \| `lmdb` \| `memory`. See [Storage backend choice](#storage-backend-choice-sqlite-vs-lmdb).                                                                                                                |
| `STORAGE_PATH`                 | `./data/agent-bureau.sqlite` (sqlite) / `./data/agent-bureau-lmdb` (lmdb) | Ignored for `memory`. The parent directory is created automatically if it doesn't exist (`mkdir -p` semantics) — `bun:sqlite` creates the database file but not its containing directory.                            |
| `EVALUATION_REPORTS_DIRECTORY` | unset                                                                     | Directory of evaluation report JSON files (written by `runEvaluationSuite`'s `output` option) for the read-only `/evaluations` trend page. Unset means the page renders empty — evaluation reporting is opt-in.      |
| `PROVIDER`                     | `anthropic`                                                               | `anthropic` \| `openai` \| `gemini`.                                                                                                                                                                                 |
| `MODEL`                        | provider-specific default                                                 | e.g. `claude-opus-4-5` for `anthropic`.                                                                                                                                                                              |
| `SYSTEM_PROMPT`                | unset                                                                     | Passed through to `BureauOptions.systemPrompt`.                                                                                                                                                                      |
| `ANTHROPIC_API_KEY`            | unset                                                                     | Read when `PROVIDER=anthropic`. A blank/whitespace-only value is treated as unset (matters for `${VAR:-}`-style Compose interpolation of an unset host variable).                                                    |
| `OPENAI_API_KEY`               | unset                                                                     | Read when `PROVIDER=openai`. Same blank-is-unset handling as above.                                                                                                                                                  |
| `GEMINI_API_KEY`               | unset                                                                     | Read when `PROVIDER=gemini`. Same blank-is-unset handling as above.                                                                                                                                                  |

Without an API key for the configured `PROVIDER`, the bureau boots anyway
with `ready: false` rather than crashing — see
[the liveness/readiness split](#liveness-vs-readiness) below. `parseStartEnvironment`
throws a readable error and exits if the environment fails validation (e.g. an
unrecognized `STORAGE_TYPE`), which is the correct failure mode for
configuration errors caught at boot.

This environment contract is greenfield — the repository had no Dockerfile,
no standalone process entrypoint, and no documented env-var surface before
this guide. `createBureau()`/`createGateway()` themselves are configured
entirely through their options objects; `start.ts` is the one place that
maps environment variables onto those options, and it is the only place you
need to extend if your deployment needs another knob (e.g. `allowedOrigins`
for the WebSocket origin allowlist, `enableCsp`, `idleTimeout` — all already
on `GatewayOptions`, just not yet threaded through an env var because no
consumer has needed one yet).

## Storage backend choice: sqlite vs. LMDB

Both are Weft `StorageConfiguration` types resolved by `createBureau({ storage })`.
Both back the durable execution engine (checkpoints, recovery) and the
session/cache/memory key-value layer from the _same_ backend — "one config →
one engine" is the deliberate design (see `PersistenceOptions` in
`packages/bureau/src/types.ts`).

|                       | `sqlite`                                                                                     | `lmdb`                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime dependency    | None — uses Bun's built-in `bun:sqlite`.                                                     | Requires the optional `lmdb` peer (`bun add lmdb`); not installed by default.                                                                                                                                                                         |
| Native compilation    | None under Bun.                                                                              | `lmdb-js` ships prebuilt binaries for common platforms; no compiler toolchain needed in the typical case.                                                                                                                                             |
| Configuration         | `{ type: 'sqlite', path: './data/agent-bureau.sqlite' }`                                     | `{ type: 'lmdb', path: './data/agent-bureau-lmdb' }` (a directory, not a file).                                                                                                                                                                       |
| Default in `start.ts` | Yes (`STORAGE_TYPE` defaults to `sqlite`).                                                   | Opt-in (`STORAGE_TYPE=lmdb`).                                                                                                                                                                                                                         |
| When to prefer it     | Default choice. Zero extra dependencies, one file to back up, well-understood operationally. | Write-heavy workloads where LMDB's memory-mapped reads and batched-transaction writes measurably outperform sqlite for your access pattern. Benchmark before switching — sqlite is the better default until you have a concrete reason not to use it. |

A third option, `{ type: 'memory' }`, exists for local experimentation only.
It still creates the API-key store and bootstraps an admin key (see below),
but every session, checkpoint, and key is lost on process exit — `start.ts`
prints a warning at boot when you select it. Do not use it for anything you
want to survive a restart.

## The one-engine-per-store constraint (AB-14)

**Weft supports exactly one engine process writing to a given durable store
at a time. Running two is unsafe today.** This is not a soft recommendation
— it is the actual, current limitation of the dependency the durable engine
is built on, and it is why this guide leads with "single-node."

Weft ships a **best-effort, warn-only** second-instance detector
(`createSecondInstanceDetector`, `@lostgradient/weft/core/engine`): each
engine writes a heartbeat under `liveness:<instanceId>` and watches for a
peer's heartbeat advancing concurrently with its own. If it sees one, it
emits a `process` `'warning'` event named `WeftSecondInstanceWarning`. That
is **liveness, not fencing** — the detector never blocks boot, never gates
recovery, never refuses a write, and never claims ownership. Two engines can
run against the same store today and both will happily execute concurrent,
uncoordinated writes; the detector just tells you (eventually, via a log
line) that it happened. There is no `MultiEngine` capability yet.

Consequences for a real deployment:

- **Do not run more than one gateway replica against the same storage path.**
  Not `replicas: 2` in Kubernetes, not two systemd units on two hosts
  pointed at the same NFS-mounted sqlite file, not a blue/green deploy with
  both colors briefly live.
- **Use `Recreate`, not `RollingUpdate`, for deploys** (stop the old process
  fully, then start the new one) — see [Single-node Bun deployment](#single-node-bun-deployment-the-optimized-lane)
  above.
- **Infrastructure-level enforcement is the real control**, not the
  detector. `replicas: 1` + `Recreate` (Kubernetes), or a single systemd
  unit with no parallel restart window, or the reference compose file's
  single-service, single-volume shape.
- If you subscribe to `process.on('warning', ...)` and filter on
  `warning.name === 'WeftSecondInstanceWarning'`, you can alert on a
  misconfiguration (an autoscaler set above one replica, overlapping
  deploys) — but treat that as an incident to fix, not a condition the
  system will recover from on its own.

This gap has a filed upstream ticket — **Weft ticket `941f39d6`** — requesting
either real lease-based coordination or a hardened fail-closed (not
warn-only) second-writer guard. Until that lands, single-node is the
supported shape. Revisit this section when that ticket resolves.

## Durable-execution defaults

`createBureau({ storage })` turns on durable execution **by default** for
persistent backends and **off by default** for `memory`:

- `sqlite` / `lmdb`: durable execution defaults to **on**. Every
  `createRun()` is checkpointed on the same backend and resumes from its
  last completed step after a crash or restart, through the standard
  `run()`/`createRun()` event surface — no special "recovery mode" API.
- `memory`: durable execution defaults to **off**, because an in-memory
  store loses its checkpoints with the process — there is nothing to
  recover from. Set `durableExecution: true` explicitly to force it on even
  for `memory` (useful for local testing of recovery behavior), or `false`
  to force a persistent backend to skip durability.

On recovery, in-flight runs resume against the **currently deployed code**,
not a snapshot of the code that was running when they checkpointed
(pin-and-warn versioning — see
[`documentation/workflow-versioning.md`](./workflow-versioning.md) for the
full mechanism and its own upstream ticket). If you deploy a breaking change
to an agent's tool schema or step logic while runs are in flight, read that
document before you ship.

## API key bootstrap

The gateway's authentication layer has two independent credentials, and a
real deployment uses both:

1. **`AUTH_TOKEN`** — a static bearer token you set via the environment. It
   is checked first on every request and, when it matches, acts as an
   unrestricted admin credential with no scope checks. Use this for
   infrastructure identities: a reverse proxy, a health check, a monitoring
   probe, a CI smoke test. Store it as a secret, not in source control.
2. **Managed API keys (`ab_live_...`)** — per-principal keys with scoped
   permissions (`runs:read`, `runs:write`, `sessions:read`,
   `sessions:write`, `config:read`, `keys:manage`, `hooks:write`,
   `schedules:read`, `schedules:write`), stored hashed (never plaintext) in
   the same key-value store as sessions. Use these for actual client
   traffic — a scoped key that can only read runs is a real security
   boundary an admin token is not.

On first boot with **any** storage backend configured (including `memory`),
`createGateway()` checks whether the key store is empty and, if so, creates
one admin-scoped bootstrap key and prints it to stdout **exactly once**:

```
[gateway] Bootstrap API key created: ab_live_<...>
```

This is the only time the plaintext is ever available — capture it from
your container logs / log aggregator on first boot, or `docker logs
<container>` before the ring buffer rotates it out. If you lose it, use
`AUTH_TOKEN` (already known to you, since you set it) to authenticate and
call `POST /api/v1/keys` to mint a replacement, then `DELETE
/api/v1/keys/:id` the orphaned bootstrap key.

To mint a new scoped key once you're authenticated:

```bash
curl -X POST http://localhost:5555/api/v1/keys \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-runner", "scopes": ["runs:read", "runs:write"]}'
```

**Important gotcha:** authentication is enforced on _every_ route, including
health checks, the moment _any_ auth is configured (`AUTH_TOKEN` set, or a
storage backend present so the key store exists). `GET
/api/v1/health/live` returns `401` without a valid credential. This is why
the reference compose file's `HEALTHCHECK` passes `AUTH_TOKEN` — a naive
`curl http://localhost:5555/api/v1/health/live` with no header will read as
unhealthy against any deployment that has persistence configured (i.e.
almost every real deployment).

### Liveness vs. readiness

The gateway exposes both, and a container orchestrator should probe both
distinctly:

- `GET /api/v1/health/live` → `200 { "status": "ok" }` whenever the process
  is up and serving HTTP, **regardless of whether a provider is
  configured**. Use this for a liveness probe (restart the container if
  this fails).
- `GET /api/v1/health/ready` → `200 { "status": "ok" }` when
  `bureau.ready` is `true` (a provider is configured and the runtime can
  actually dispatch runs), `503 { "status": "unavailable" }` otherwise. Use
  this for a readiness probe (stop routing traffic, but don't restart).

A bureau with no API key is a deliberately valid, partial boot state (it can
still serve session/config/scheduler routes) — `start.ts` warns about it
loudly rather than crashing, and the two health endpoints are how an
orchestrator is meant to tell the difference between "broken" and
"waiting for configuration."

## Reverse proxy / TLS notes

The gateway does not terminate TLS itself — put a reverse proxy (nginx,
Caddy, an ALB/Cloud Load Balancer, Traefik) in front of it for TLS and let
the gateway listen on plain HTTP behind it. A few gateway-specific things
the proxy config needs to account for:

- **WebSocket upgrade.** Live run/session updates use a `/ws` endpoint via
  Bun's native WebSocket support. Configure your proxy to forward the
  `Upgrade`/`Connection` headers for that path (e.g. nginx's
  `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection
"upgrade";`).
- **Origin allowlisting.** `GatewayOptions.allowedOrigins` restricts which
  `Origin` header values are accepted on a WebSocket upgrade — when set,
  requests with a missing or non-matching `Origin` are rejected with `403`.
  Set this to your actual public origin(s) once you're behind a proxy;
  leaving it unset performs no origin check at all.
- **SSE idle timeout vs. heartbeat.** Server-sent event streams (the
  Node-compatible live-update fallback) rely on a heartbeat that must fire
  before the connection's idle timeout, or the connection is silently
  dropped. `GatewayOptions.idleTimeout` (Bun default: 10s) and the SSE
  heartbeat interval (8s) are tuned against each other and against Bun's
  default. **If your proxy has its own idle/keepalive timeout shorter than
  the gateway's**, raise the proxy's timeout to match, or raise both
  `idleTimeout` and the heartbeat together — do not raise only one.
  (nginx's default `proxy_read_timeout` is 60s, comfortably above the
  gateway's defaults; a stricter edge proxy or serverless gateway in front
  may need explicit tuning.)
- **`Content-Security-Policy`.** `GatewayOptions.enableCsp` (default `true`)
  emits a CSP header on every response. If your proxy also sets a CSP
  header, make sure the two don't conflict — the last one applied wins, and
  a stricter proxy-level CSP can silently break the browser UI's inline
  hydration script.
- **Client IP / `Origin` behind a proxy.** The gateway trusts headers as
  presented to it; make sure your proxy is not forwarding a client-supplied
  `Origin` or auth header verbatim in a way that lets a client spoof
  another origin's WebSocket access.

## Backup and restore of the durable store

The durable store is the single source of truth for sessions, in-flight
runs, the scheduler, memory, skills, and API keys — back it up like you
would a database, because it is one.

### sqlite

- **Live backup:** `bun:sqlite`'s underlying file uses WAL mode
  (`agent-bureau.sqlite`, `-wal`, `-shm` alongside it, as seen when you
  inspect a running container's data volume). Do not `cp` the `.sqlite`
  file alone while the process is running — you can capture a torn,
  inconsistent snapshot. Use SQLite's own backup mechanism: either
  `sqlite3 agent-bureau.sqlite ".backup backup.sqlite"` (run from the same
  filesystem, no need to stop the process) or stop the container first and
  copy the file plus its `-wal`/`-shm` siblings together.
- **Restore:** stop the gateway, replace `agent-bureau.sqlite` (and remove
  any stale `-wal`/`-shm` from the old run — they'll be recreated), start
  the gateway. On boot, Weft's recovery path reattaches in-flight durable
  runs from the restored checkpoints.
- **Container/volume backup:** if you're using the reference compose file's
  named volume (mounted at `/app/packages/gateway/data` — matching `start.ts`'s
  default relative storage path resolved against the Dockerfile's `WORKDIR`,
  not `/data`), `docker run --rm -v <volume>:/data -v $(pwd):/backup alpine
tar czf /backup/agent-bureau-backup.tar.gz -C /data .` with the gateway
  container stopped is the simplest correct snapshot.

### LMDB

- LMDB's storage is a directory (memory-mapped file plus lock file), not a
  single file. Back up the whole directory. LMDB is generally safe to
  copy live (its on-disk format is designed for consistent reads without
  locking out writers), but this guide's verification only exercised the
  `sqlite` backend end to end — consult the `lmdb`/`lmdb-js` documentation
  for the specifics of an online-backup tool before relying on a live copy
  in production. Stop-copy-start is simplest and always correct if you'd
  rather not depend on that.
- **Restore:** stop the gateway, replace the LMDB directory wholesale,
  start the gateway.

### General

- **Test your restore path before you need it.** A backup you have never
  restored from is a hypothesis, not a backup.
- **The bootstrap admin key lives in the same store.** Restoring a backup
  restores whatever API keys existed at backup time — a key created after
  the backup and revoked before an incident will not silently come back
  (it's just gone with the rest of that data), but a key that existed at
  backup time and was later rotated will restore to its _old_ value. Rotate
  keys after any restore if you're not certain of that timeline.
- **Durable runs recovered from an old backup replay against current code**
  (see [Durable-execution defaults](#durable-execution-defaults) above) —
  a restore is a recovery event, not just a data rollback.

## Reference Dockerfile and compose file

`Dockerfile` and `docker-compose.deployment.yaml` at the repository root are
the reference artifacts for this guide. (`docker-compose.yaml`, also at the
root, is unrelated pre-existing test infrastructure — a redis/postgres pair
with no references anywhere in the workspace — and is untouched by this
guide; the deployment compose file is intentionally a separate, distinctly
named file.)

**Build shape.** `gateway` is consumed only via `workspace:*` inside this
monorepo, so the image is built from the **full workspace context**, not a
single package: `bun install`, then `turbo run build --filter=gateway` (which
builds every workspace dependency in dependency order first, since
`bureau`'s and `gateway`'s builds externalize their workspace and npm
dependencies rather than bundling them — see the comment in
`packages/bureau/scripts/build.ts` for why bundling `@lostgradient/weft`
specifically breaks storage resolution at runtime — filed upstream as weft
ticket `93540e30`). The container then runs `bun run start`, which executes
the **built** `packages/gateway/dist/start.js` — not
`src/start.ts` from source, and not `dist/index.js` (a library barrel with
no bootstrap). Bun can execute TypeScript directly, so running from source
would work for the HTTP layer alone, but `server/render.ts` only serves the
browser UI's content-hashed asset bundle (`dist/public/entry-<hash>.js`)
when it detects it is running from `dist/`; from `src/` it falls back to an
unhashed `/public/entry.js` URL the build never produces, and the UI fails
to hydrate. `scripts/build.ts` therefore builds `start.ts` as one of its
entrypoints (alongside `index.ts`/`events.ts`), with `bureau` added to that
build pass's `external` list so it isn't bundled — bundling it would
reintroduce the exact weft dynamic-import bug described above, one level up
the dependency graph.

**Verification performed for this guide** (2026-07-09/10, Docker Desktop
29.2.1 on this machine, `oven/bun:1.3.13-slim` base image). This ran twice:
an initial pass, then a second pass after PR review caught that the first
pass never actually loaded the browser UI (only health endpoints) and
missed a real bug — running `src/start.ts` from source serves a dashboard
whose script tag points at a content-hashed asset URL the build never
produces at that unhashed name, 404ing the client bundle. Fixed by building
`start.ts` as a real build entrypoint and running the built `dist/start.js`
in production (`bun run start`) — see the "Build shape" note above. The
evidence below is from the corrected second pass:

- `docker build -t agent-bureau-gateway:ab-80-test .` — succeeded, full
  workspace build (`interoperability`, `lifecycle`, `armorer`,
  `conversationalist`, `operative`, `memory`, `skills`, `bureau`, `gateway`)
  completed inside the image.
- `docker run` with `STORAGE_TYPE=sqlite` and `AUTH_TOKEN` set — booted,
  logged `[gateway] Bootstrap API key created: ...` and `[gateway]
listening on port 5555`, confirming it ran `bun run dist/start.js`.
- `GET /api/v1/health/live` with the bearer token → `200 {"status":"ok"}`;
  without a token → `401`.
- `GET /api/v1/health/ready` (no provider API key configured) → `503
{"status":"unavailable"}`, confirming the liveness/readiness split
  documented above.
- `GET /` → `302` to `/dashboard`; `GET /dashboard` (bearer token) → `200`
  with a `<script src="/public/entry-<hash>.js">` tag; a direct request for
  that exact hashed URL → `200` — confirming the browser UI actually
  hydrates, not just that the HTTP layer answers.
- Storage directory auto-creation: the default `./data` directory (resolved
  under the Dockerfile's `WORKDIR`) did not exist before boot and was
  created automatically — no `SQLITE_CANTOPEN` failure.
- `docker restart` on the same container → reattached to the same sqlite
  file, did **not** re-print a bootstrap key (confirming the admin key
  persisted across restart), and logged `[gateway] received SIGTERM,
shutting down` before restarting — confirming `server.stop()` and
  `bureau.dispose()` both run in the shutdown handler.
- `docker compose -f docker-compose.deployment.yaml up -d --build` — built
  and started the `gateway` service; `docker compose ps` reported
  `Up ... (healthy)` from the compose file's own bun-based `HEALTHCHECK`
  (no curl/wget in the slim base image, so the healthcheck uses `bun -e`
  with `fetch()` directly); direct requests against the published port
  confirmed `200` for both the dashboard and its hashed asset.
- Both containers, the named volume, and the built image were torn down
  after verification (`docker compose down -v`, `docker rm`, `docker rmi`)
  — nothing from this verification was left running.

This was a **real container build and boot**, not a source-only
approximation — Docker was available on the machine used to prepare this
guide.

## Embedding bureau in a sandbox image (AB-97)

The Dockerfile above packages `gateway` as a standalone HTTP service. A
different shape — the one this section documents — is embedding just the
agent loop (`operative` + a tool package + a provider) as a single bundled
file inside someone else's sandbox image: a code-execution sandbox, a CI
runner, a serverless function with a cold-start budget. No `gateway`, no
`bureau`, no HTTP server, no durable store — just a process that runs one
agent loop against stdin/env input and exits.

`packages/integration/test/fixtures/sandbox-runner.ts` is the reference
shape, exercised end-to-end by
`packages/integration/test/sandbox-embedding.test.ts`. It composes:

- `armorer`'s read-only `coding` toolbox (`createCodingToolbox({ root })`) —
  jailed to a declared root, so the tool surface itself enforces the
  filesystem boundary rather than relying on process-level sandboxing alone.
- `operative`'s agent loop (`createActiveRun` + `stopWhen.noToolCalls()`).
- `@lostgradient/operative/anthropic`'s `createAnthropicProvider`, pointed at a
  `baseURL` (a credential-injecting proxy in production, per AB-93's
  "Providers Behind a Proxy" pattern documented in `operative`'s README —
  the sandboxed process never needs a real API key, only a placeholder
  forwarded to the proxy).

### Entrypoint shape

Write the entrypoint as a plain async function driven entirely by
environment variables and/or stdin — no CLI framework, no config file
resolution. `sandbox-runner.ts`'s contract is representative:

```typescript
const root = requireEnv('SANDBOX_RUNNER_ROOT'); // declared filesystem jail
const baseURL = requireEnv('SANDBOX_RUNNER_BASE_URL'); // proxy/provider endpoint
const apiKey = requireEnv('SANDBOX_RUNNER_API_KEY'); // placeholder, forwarded verbatim

const toolbox = createToolbox(createCodingToolbox({ root }));
const generate = createAnthropicProvider({ model, apiKey, baseURL });
const result = await createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
}).result;
console.log(JSON.stringify({ content: result.content }));
```

Fail loudly on missing configuration (throw, don't default) — a sandboxed
process that boots half-configured and produces silently-wrong output is
worse than one that exits non-zero immediately.

### Bundling

Build with `bun build --target=bun <entry> --outfile=<outfile>` (or the
`Bun.build()` API — the integration test uses the latter, see
`sandbox-embedding.test.ts`). This produces **one file**: no `node_modules`
needs to travel with it inside the sandbox image.

The one thing worth verifying for your own entrypoint: `operative`'s
Anthropic provider (`@lostgradient/operative/anthropic`) lazily `import()`s
`@anthropic-ai/sdk` on first call — a zero-SDK-if-unused optimization for
consumers who only use OpenAI or Gemini. AB-97 proved this dynamic import
**survives** `bun build --target=bun` bundling: the SDK is inlined into the
single outfile, and the bundled process resolves it at runtime with no
`node_modules` on disk. If a future SDK version or bundler change breaks
that (the test would start failing at
`packages/integration/test/sandbox-embedding.test.ts`), the documented
fallback is to construct the provider's `client` explicitly and pass it via
`createAnthropicProvider({ client, ... })` — `operative`'s own top-level
`import { Anthropic } from '@anthropic-ai/sdk'` then becomes a normal
static import the bundler resolves at build time instead of a runtime
dynamic one, at the cost of always bundling the SDK regardless of which
provider you use.

### Env contract

Follow the same pattern as `gateway`'s `parseStartEnvironment`
(`packages/gateway/src/start.ts`): one Zod schema, parsed once at process
start, blank/whitespace treated as unset, throw a readable error on invalid
input rather than booting half-configured. `sandbox-runner.ts`'s contract
is deliberately minimal (three required variables) because it has no
storage, no HTTP port, and no multi-provider selection to configure — scale
the schema up only for what your embedding actually needs.

### SIGTERM handling

A sandboxed process is typically killed by its orchestrator sending
`SIGTERM` with a grace period, the same shape `gateway`'s AB-96 shutdown
handler uses. `sandbox-runner.ts` mirrors that pattern at the scale
appropriate to a process with no server or storage to close:

```typescript
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[sandbox-runner] received ${signal}, exiting`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

If your embedding runs a durable (Weft-backed) run rather than the
in-memory loop `createActiveRun` uses without a `durable` option, dispose
of the engine in `shutdown()` before `process.exit(0)` the same way
`gateway`'s handler calls `bureau.dispose()` — an abrupt `SIGKILL` still
produces a terminal `RunReport` on next recovery (AB-96's run-envelope
contract), but a clean `SIGTERM` path should still close the engine/storage
handle it opened rather than relying on that recovery path as the only
exit.

### What this proves, and what it does not

`sandbox-embedding.test.ts` is a **behavioral smoke test**, not a security
sandbox audit:

- **Filesystem isolation.** The test points `HOME`/`XDG_CONFIG_HOME`/
  `XDG_CACHE_HOME`/`XDG_DATA_HOME` at an empty temp directory and asserts it
  is still empty after the run, while a real file read _inside_ the
  declared coding-tool root succeeds. This proves the bundled runner, given
  this input, did not write outside its declared root — it does not prove
  the runner _could not_ under a different code path. There is no
  seccomp/landlock/namespace enforcement here; that's the sandbox image's
  job, not this test's.
- **Network isolation.** The mock server records every request it receives
  and the test asserts the only endpoint hit is `POST /v1/messages` at the
  configured `baseURL` — there is no second listener standing in for
  "everything else" to prove the runner _couldn't_ reach. Real network
  egress control (a network namespace, an egress allowlist/proxy) is the
  sandbox image's responsibility; this test proves the application-level
  code path issues no extra calls, which is what an embedder configuring an
  egress allowlist needs to know before locking it down to one host.

Treat the test as proof of the running code's shape, and pair it with your
sandbox platform's own filesystem/network enforcement — the two are
complementary, not substitutes for each other.

### AB-97 footprint numbers

Recorded from `sandbox-embedding.test.ts` on the machine used to prepare
this guide (Bun 1.3.13, `bun build --target=bun`, no minification):

| Metric                                                                                                                 | Value                      |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Bundle size (single outfile)                                                                                           | ~3.18 MB (3,184,923 bytes) |
| Build time (`Bun.build()`, cold, dependencies pre-built)                                                               | ~60–100 ms                 |
| Cold start (spawn bundled outfile → first stdout line, including a full two-step agent loop + mock network round trip) | ~140–200 ms                |

These are point-in-time numbers from one machine and one run shape (a
single-step tool call + final text response, in-memory loop, no durable
engine) — not a benchmark suite. **Regression threshold: noted, not
enforced.** The test asserts only a generous sanity ceiling (bundle size
under 50 MB) as a smoke check against something going obviously wrong (a
provider SDK newly bundling itself several times over, a stray large
asset); it does not fail the build on a size or timing regression. If
bundle size or cold-start time becomes a tracked concern, add a dedicated
budget/threshold as a follow-up decision, informed by these numbers as a
baseline — don't infer a hard gate from their presence here.

For a rough point of reference from the `gateway` Dockerfile's own
verification above (not a substitute for these numbers, which cover a
different bundling shape — a single-file `bun build --target=bun` runner,
not a full-workspace-context Docker image): `gateway`'s own build step
alone (client + server) reported a 271,826-byte CSS bundle across 731
client files and a 369-entry asset manifest; the full `docker build`
(dependency install + 9-package `turbo run build --filter=gateway`)
completed in well under a minute on this machine. Full cold-start
(`docker run` to first successful `/api/v1/health/live` response) was on
the order of a few seconds.
