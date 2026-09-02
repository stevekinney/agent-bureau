# Changelog

## 2.3.0

### Minor Changes

- 380da79: `ToolExecuteOptions` gains two optional per-call fields: `traceContext?: unknown` and `executionContext?: Record<string, unknown>`. `createToolbox` threads both into the per-call `RuntimeToolContext` (`context.traceContext`/`context.executionContext`), falling back to the toolbox's own base context when a call supplies neither (AB-233).

  `packages/operative/src/run-step.ts`'s toolbox execute call site now passes the run's active trace context through `traceContext`, and this run's own `childRegistry`/`runId` through `executionContext: { childRegistry, parentRunId }`. A `createSubagentTool` reached through the ordinary `createAgent`-driven agent loop now observes the parent run's trace context automatically — no more building a toolbox with a matching `context: { traceContext }` to make `context.traceContext` reach a subagent tool (the operative README's documented limitation is removed).

  This also closes an AB-50 reuse gap: `createSubagentTool` previously captured `parentContext.registry`/`parentContext.parentRunId` once at tool construction, so one tool instance reused across two `agent.run()` calls shared a child registry (either run's `abortChild` could cancel the other's child) and nested dispatch stamped every child with the same frozen `parentRunId`. `createSubagentTool` now reads `childRegistry`/`parentRunId` from `ToolContext.executionContext` at execute time, in preference to `parentContext.registry`/`parentContext.parentRunId`, which remain supported as construction-time defaults for a direct `dispatchChildRun` caller or a tool built outside the ordinary loop.

  `RunOptions` (operative) gains a new optional `childRegistry?: ChildRunRegistry` field, threaded automatically from `AgentRunContext.childRegistry` when a run is started through `createAgent`'s returned agent.

- 6ae0ef0: `instrument()` (`armorer/instrumentation`) no longer calls `span.recordException(...)` for a cancelled tool call, closing a gap AB-230 left open (AB-237, grounded in AB-87's telemetry redaction column).

  A cancellation error is derived from a caller-supplied abort reason and can itself carry tool-argument content — for example an `Error` whose `message` embeds the reason. Passing that `Error` to OpenTelemetry's `recordException` serializes it verbatim onto the exception event's `exception.message`/`exception.stacktrace` attributes, which leaked the reason even though AB-230's changelog claimed "a genuine `Error` on any error/cancelled path is still recorded via `recordException`, unchanged." That claim no longer holds for the cancelled path specifically — the error/denied paths are unaffected and still call `recordException` for a genuine `Error`.

  On a cancellation, only the non-privileged category now reaches the span, on both `error.type` (unchanged) and a new attribute, `armorer.tool.cancellation_category`, added so a cancellation is queryable without colliding with the `error`/`denied` use of `error.type`.

  If a downstream telemetry consumer read `exception.message`/`exception.stacktrace` off a cancelled tool span's exception event, that event no longer fires for cancellations; `armorer.tool.cancellation_category` (or `error.type`) is the replacement signal.

  The same reason also reached `span.status.message` through a second path: a tool created without `telemetry: true` never emits `tool.finished` at all (`create-tool.ts`'s `finishTelemetry` returns early), so its cancellation was previously reported only through the toolbox-level `error` event fallback, which copied `result.error.message` verbatim onto the span status. That fallback now applies the same sanitization — a fixed `status.message` of `Cancelled` plus `error.type`/`armorer.tool.cancellation_category`, regardless of whether the tool opted into `telemetry: true`.

## 2.2.0

### Minor Changes

- 5739368: `instrument()` (`armorer/instrumentation`) no longer attaches privileged tool-argument or tool-result content to OpenTelemetry span attributes (AB-230, auditing the gap AB-87 declared: "a privileged tool argument must not become a span attribute, and nothing today verifies that").

  Four attributes are removed rather than redacted with a placeholder — `gen_ai.tool.call.arguments`/`gen_ai.tool.call.result` are Opt-In under the OTel GenAI semantic conventions specifically because they can carry sensitive data, so this package no longer opts in:

  - `gen_ai.tool.call.arguments` — previously attached on the `execute_tool` span (from `call.arguments`) and as an attribute on the span's `tool.started` event (from `params`). Both sites now omit it; the `tool.started` event still fires as a timing marker, with no attributes.
  - `gen_ai.tool.call.result` — previously attached on a successful `tool.finished` close (from `result`).
  - `armorer.tool.cancellation_reason` — previously attached on a cancelled `tool.finished` close, serializing the cancellation error (which is derived from a caller-supplied abort reason and can itself carry argument content).
  - `armorer.tool.error` — previously attached on an error/denied `tool.finished` close for a thrown/returned value that was not an `Error` instance (which can itself carry argument or result content).

  If a downstream telemetry consumer depended on any of these, `armorer.tool.input_digest`/`armorer.tool.output_digest` remain as the non-privileged correlation handle, and `error.type` (the error category, unchanged) remains for the error paths. A genuine `Error` on any error/cancelled path is still recorded via the standard OpenTelemetry `recordException` API, unchanged.

  No attribute name changed or was renamed — only content removed — so no dashboard query keyed on an attribute _name_ breaks; a query that projected the _value_ of one of the four attributes above will now see it absent.

- 0e00f2b: Add `RuntimeToolContext.progress()` (AB-217, ratifying AB-88's AC11) — a typed wrapper over the existing `progress` event so tool authors no longer hand-construct an `Event` and call `dispatch` themselves.

  `progress<TDetail = unknown>(update: { percent?; message?; checkpoint?: TDetail }): void` dispatches the same `ToolProgressEvent`/`DefaultToolEvents['progress']` event a hand-constructed `dispatch(new ToolProgressEvent(...))` call produces today, so every existing `progress` listener continues to fire unchanged. The event's `checkpoint` now carries whatever value the tool author passes through verbatim — never re-serialized or reconstructed from `percent`/`message` — so a downstream consumer (an activity-backed execution's heartbeat forwarder, or a liveness-ingestion point) can read it directly.

  Calling `progress()` outside of an active tool call (after it has completed or been aborted) is a no-op rather than a thrown error, matching the tolerant-context pattern of `RuntimeToolContext`'s other methods. `progress()` never resets or extends a tool's existing `timeout`.

- bbfe517: A `loop-blocked` toolbox rejection now dispatches a companion `error` event carrying the same rejected `ToolExecutionResult`, mirroring the existing `budget-exceeded`-then-`error` pattern (AB-231, ratifying AB-87's armorer-surface decision). Previously `loop-blocked` returned its `blocked` result directly with no companion `error` event, so operative's generic toolbox-event forwarding never observed a blocked call — the run layer saw no signal at all. `loop-warning`'s non-blocking, advisory-only semantics are unchanged.

  Also adds `TOOLBOX_BUDGET_EXCEEDED_MARKER` and `isToolboxBudgetExceededToolError` (with the `ToolboxBudgetExceededToolError` type), a provenance marker the toolbox's own `checkBudget` path stamps onto the `ToolError` it throws in `failFast` mode. `ToolError.code` alone is public, user-controlled data — a tool's own `execute()` can throw an error whose `code` also normalizes to `'BUDGET_EXCEEDED'` without being a toolbox-accounting rejection — so a consumer that needs to distinguish a genuine toolbox-level budget rejection (such as operative's `BudgetExceededError` reclassification, see the companion `@lostgradient/operative` changeset) checks for this marker instead of trusting `code` alone. The marker is symbol-keyed and therefore invisible to `JSON.stringify`, `Object.keys`, and structured-clone serialization, and is registered via `Symbol.for` (not a bare `Symbol()`) so it resolves to the identical runtime value across separate module instances of armorer — a mixed ESM/CJS host or a dependency graph resolving more than one armorer copy still classifies correctly.

## 2.1.0

### Minor Changes

- 5454047: Raise the declared Bun floor from `>=1.3.13` to `>=1.4.0`.

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

## 2.0.1

### Patch Changes

- 995734a: Keep a toolbox execution unfinished while its tool callback is still running. A request deadline arms two independent timers for the same instant — one on the toolbox's parent execution and one on the tool's own execution — and when the tool's timer won the race the parent was never marked `abort-requested`, so the toolbox settled it from the raced timeout result while a cancellation-ignoring callback was still in flight. `whenIdle()` and `shutdown({ policy: 'drain' })` could therefore report drained while a tool callback was still executing. The toolbox now tracks the callback itself rather than inferring it from the parent's abort state.
- c2ec10f: Document that `createTopicBoundaryDetector`'s `allowedTopics`/`blockedKeywords` matching is literal, case-insensitive substring matching, not semantic — a paraphrased, on-topic input that never uses the literal keyword is flagged as off-topic. No behavior change.
- 59f7642: Stop tool-result materialization from throwing on a self-referential array. `interoperability`'s non-JSON fallback called `String()` directly, which relies on `Array.prototype.join`'s cycle guard — an engine extension rather than a spec requirement. On Bun 1.3.13 that yields `'1,2,'`; on Bun 1.4.0 it recurses until the stack overflows and a `RangeError` escapes what is supposed to be a total normalization step. Cycles are now elided before coercion, so every supported runtime produces the documented result. Circular plain objects still render as `[object Object]`, unchanged. This ships to consumers because `interoperability` is inlined into these packages at build time.
- 3c45232: Correct the Gemini adapter JSDoc examples, which demonstrated `@google/generative-ai`'s removed `getGenerativeModel()` API. They now show `@google/genai`'s `client.models.generateContent({ model, contents, config })` form, matching the SDK these packages declare.

## 2.0.0

### Major Changes

- a6e18f2: Separate reusable Armorer catalogs from request-scoped execution authority. Add frozen effective execution contexts, privileged lifecycle inspection, versioned deny-by-default external projections, strongly bound single-use approvals, and tenant/revision-fenced idempotency with atomic durable-cache contracts and authorized unknown-outcome receipts.

## 1.0.0

### Major Changes

- ed70acf: Define an explicit runtime/export support matrix for Armorer public subpaths, remove misleading browser conditions from server-only integrations, and add packed-consumer verification across Bun, Node, TypeScript, and browser bundlers.

### Minor Changes

- aff071a: Add stable, revisioned execution handles and lifecycle snapshots for queued, active, waiting, streaming, abort-requested, cleanup-pending, terminal, and unknown-effect work. Compose caller, deadline, and owner cancellation, remove cancelled calls from concurrency queues, expose scoped abort and admission closure, and make tool and toolbox shutdown awaitable with explicit cleanup reports.

### Patch Changes

- 22de20a: Declare `"node": "^20.16.0 || >=22.3.0"` in `engines`. Armorer's `sha256HexSync`, `hmacSha256HexSync`, `timingSafeEqualHex`, and `createIncrementalHash` usage (via `interoperability`) now requires `process.getBuiltinModule`, which Node.js added in 20.16.0 on the 20.x line and in 22.3.0 (not earlier 22.x releases), in exchange for eliminating a bundler-injected `createRequire`/`node:module` shim from the published output (see the paired `conversationalist` changeset for the AB-31 context). This documents the real floor rather than narrowing it silently.

## 0.14.0

### Minor Changes

- 984173a: Bind satisfied approval pauses to their capability, registry, or tool policy tier during resume.

## 0.13.0

### Minor Changes

- af3bb6d: Export `EventIteratorOptions`, `ToolDefinition`, and `AnyToolDefinition` from the package root. The public `Tool` type structurally references the first two, so consumers previously could not name the inferred type of anything built with `createTool` — TypeScript 6 rejects that outright with TS2883 ("cannot be named without a reference to ... This is likely not portable").

  Also widens the optional peer ranges to the current releases: `@modelcontextprotocol/sdk` to `^1.30.0`, `@openai/agents` to `^0.14.3`, `@opentelemetry/api` to `^1.9.1`, and `zod` to `^4.4.3`. The `@openai/agents` move crosses several breaking releases; consumers pinned to `0.4.x` need to upgrade alongside.

## 0.12.0

### Minor Changes

- b6f2b94: Make `ToolPolicyDecision.allow` optional when `status` is present (fixes #226). A policy hook can now return `{ status: 'needs_approval', reason: '…' }` — the shape the README's Approval Flows example has always shown — and the effective `allow` is derived from the status (`'allow'` → `true`; `'deny'`, `'needs_approval'`, `'needs_input'` → `false`). Decisions that set `allow` explicitly behave exactly as before. The normalizer is exported as `resolveToolPolicyAllow` alongside the new `ResolvedToolPolicyDecision` type.

## 0.11.0

### Minor Changes

- 7bd0d01: Add `AnyToolbox`, an erased supertype for `Toolbox<TTools>`. `Toolbox` is invariant in its tool-tuple parameter `TTools` (the tuple appears in both input and output positions — the typed `execute` overloads, `extend`, `tools`, `getAvailable`, `getTool`), so a concretely-typed `Toolbox<ConcreteTools>` (what `createToolbox([...])` returns) was never assignable to the bare `Toolbox` default without a cast. `AnyToolbox` fixes that: every `Toolbox<TTools>`, for any `TTools`, structurally satisfies it with no cast and no `any`. Use `AnyToolbox` wherever a toolbox is accepted or stored but only ever executed generically — its tool tuple is never inspected for compile-time call/result typing.

### Patch Changes

- 2b6debf: Raise the declared `engines.bun` floor to `>=1.3.13` to match the Bun engine requirement declared by `@lostgradient/weft`.

## 0.10.1

### Patch Changes

- cee1695: Make the Anthropic adapters interoperate directly with the official Anthropic SDK types.

## 0.10.0

### Minor Changes

- ed8d1d6: Add a two-axis approval policy (AB-22): capability tier (`read-only` / `mutating` / `dangerous`, derived from existing tool metadata and OpenAPI verb-derived metadata without modification) x approval mode (`never` / `on-mutation` / `always` / `deny`), evaluated with `deny > ask > allow` precedence via `combineApprovalStatuses` and escalating unrecognized tools to `ask` under every mode. New `createToolbox({ approvalPolicy })` option and exports (`createApprovalPolicyHooks`, `evaluateCapabilityApproval`, `resolveCapabilityTier`, `resolveApprovalMode`, `evaluateApprovalStatus`, `combineApprovalStatuses`, `approvalStatusToDecision`). Runs before any registry- or tool-level `policy.beforeExecute` hook, so persona/skill tool policies (`operative`'s `createPolicyEnforcementHook`) can only narrow it, never bypass it. `ask` verdicts surface as the existing `needs_approval` status, so `PendingToolApproval`/`resumeApproval` and `bureau`'s review queue need no changes.
- f245bdd: Add MCP elicitation support in both directions, mapping onto the MCP spec's form/URL elicitation split.
  - `ToolElicitationRequest` / `ToolElicitationResult` / `ToolElicitationRequester` (`armorer`): a transport-agnostic elicitation shape. `context.elicit` is now threaded through `createTool`'s execute context and `ToolExecuteOptions`/`createToolbox().execute()`, alongside `signal`/`timeout`/`stream`.
  - `createMcpToolElicitationRequester` (`armorer/mcp`): the "MCP server" direction — lets a tool's `execute` ask the connected MCP client for approval or human input mid-execution via `extra.sendRequest`. Wired automatically into every tool registered through `createMCP`, so `context.elicit(...)` just works.
  - `createMcpElicitationHandler` (`armorer/mcp`): the "MCP client" direction — adapts a `ToolElicitationRequester` into an MCP client request handler for `elicitation/create`. Register it with `client.setRequestHandler(ElicitRequestSchema, ...)` to answer elicitation requests raised by a connected server, including ones raised while executing a tool imported via `fromMcpTools`.
  - `jsonSchemaToZod` is now exported from the package root (previously internal to the MCP integration only), so consumers can convert an elicitation's JSON Schema `requestedSchema` into a Zod schema.

  Also builds the operative-side bridge: `createMcpElicitationResponder` (`operative`, unpublished) adapts an MCP elicitation request into the loop's existing `onElicitation` mechanism, dispatching the same `ElicitationRequestedEvent`/`ElicitationResolvedEvent` the in-loop `elicit()` helper already emits.

- 824bc5b: Add MCP OAuth client support (`armorer/mcp`), implemented against the MCP Authorization spec (base revision 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), plus RFC 9207 issuer-response validation as defined in the current draft revision (https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-response-validation).
  - `createMcpOAuthProvider`: builds an `OAuthClientProvider` for `@modelcontextprotocol/sdk`'s `auth()` orchestrator and `StreamableHTTPClientTransport`, backed entirely by a caller-supplied `McpOAuthTokenStorage` hook — this module never persists tokens, PKCE verifiers, client registration, or discovery state itself. PKCE, RFC 9728/8414 discovery, dynamic client registration, and token refresh are all handled by the SDK's `client/auth.js`; this factory just wires a storage-agnostic provider around it.
  - `createInMemoryMcpOAuthTokenStorage`: a non-persistent `McpOAuthTokenStorage` for tests, scripts, and other single-process use.
  - `validateMcpAuthorizationResponseIssuer` / `McpAuthorizationIssuerValidationError`: validates an authorization redirect's `iss` parameter per RFC 9207 §2.4 against the issuer recorded during discovery, applying the MCP spec's `authorization_response_iss_parameter_supported` decision table. Guards against authorization-server mix-up attacks.
  - `parseMcpAuthorizationCallback`: parses `code`/`state`/`iss`/`error` off an authorization redirect URL.
  - `completeMcpOAuthAuthorization`: orchestrates finishing a flow after the redirect — validates `iss` (before ever inspecting `error`, per spec), verifies `state`, then exchanges the code for tokens.
  - `connectMcpClientWithOAuth` / `fromMcpClientTools`: connects an MCP `Client` over Streamable HTTP with the OAuth provider wired in, and lists+converts its tools into executable Toolbox `Tool`s via the existing `fromMcpTools`.
  - `isMcpUnauthorizedError`: a dual-package-hazard-safe check for the SDK's `UnauthorizedError` (compares `error.constructor.name` rather than `instanceof`, since this module lazily loads the SDK's CJS build while a consumer may have imported its ESM build directly).

  Covered by a test suite against a mock OAuth authorization server + protected resource server built with `Bun.serve` in-test (no live endpoints): full PKCE authorization-code flow through to a tool call, token refresh, and two RFC 9207 rejection cases (mismatched `iss`, missing `iss` when the server advertises support).

- b8a74af: Add MCP Tasks-extension support to `createMCP` (`armorer/mcp`), implemented against `@modelcontextprotocol/sdk`'s experimental Tasks module (MCP spec revision `2025-11-25`, methods `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` — there is no `tasks/update`; clients poll status via repeated `tasks/get` calls and fetch the final payload via `tasks/result`).

  A tool becomes task-backed by giving it an MCP `execution.taskSupport` of `'required'` or `'optional'` (via `tool.metadata.mcp.execution` or `createMCP`'s `toolConfiguration()` callback). `createMCP` then:
  - Registers the tool with `server.experimental.tasks.registerToolTask(...)` instead of `server.registerTool(...)`, and advertises the server `tasks` capability (`requests.tools.call`, `list`, `cancel`) required for clients to negotiate task-augmented `tools/call`.
  - Runs the tool's execution in the background against a per-task `AbortController`, recording the outcome via the request-scoped `RequestTaskStore` so `tasks/get` can poll status and `tasks/result` can retrieve the completed/failed result.
  - Defaults to a fresh `InMemoryTaskStore` when no `taskStore` is supplied in `CreateMCPOptions` (still overridable, since `taskStore` flows straight through the underlying `ServerOptions`/`ProtocolOptions`).
  - Wraps whichever `TaskStore` is in play so that a client's `tasks/cancel` — which the SDK implements as `taskStore.updateTaskStatus(taskId, 'cancelled', ...)` — actually aborts the tool's `AbortSignal` instead of only flipping a status flag, so cancellation stops real work.

  Covered by an in-memory client/server pair (`InMemoryTransport`) exercising the full lifecycle: create a task-backed tool call, poll `tasks/get` while it's `working`, resolve it and confirm `tasks/get` reports `completed` with the correct `tasks/result` payload; a second scenario cancels a running task via `tasks/cancel` and asserts the tool's `AbortSignal` actually fired (neuter-verified: reverting the cancel→abort wiring makes that assertion fail); a third confirms the `tasks` server capability is only advertised when at least one tool opts in.

  Bumps the `@modelcontextprotocol/sdk` peer/dev dependency floor to `^1.29.0` — the `types` export condition for the `./experimental/tasks` subpath (where the Tasks extension's runtime and types live) was only added in that release.

- b429d1b: Add a shared guardrail detector pipeline: `runDetectorPipeline` and the confidence-gate wrapper `scanContent`, plus the built-in `createPromptInjectionDetector`, `createTopicBoundaryDetector`, and `createInputLengthDetector` (moved from `operative`, same behavior). `DetectorContext` and `GuardrailTriggeredEvent` now carry a `provenance` tag (`'user-input' | 'recalled-memory' | 'ingested-document' | 'skill-resource'`), so the same pipeline can scan retrieved content — not just user input — while recording where it came from. `operative`'s guardrails re-export these from `armorer` so existing imports keep working.
- 0e3cc24: Export `withMinimumTripwireConfidence` from the guardrails module — a detector wrapper that suppresses a `triggered: true` result below a given confidence threshold. Previously duplicated as a private helper inside `bureau`'s default guardrail preset; now a single shared implementation, reusable for tuning any `InputDetector` before wiring it into `mode: 'tripwire'`.
- 5d7fe33: Align `armorer/instrumentation`'s tool span with the OTel GenAI semantic conventions (pinned to `open-telemetry/semantic-conventions-genai` commit `63f8200`): the span is renamed from `tool {name}` to `execute_tool {name}`, its kind changes from `CLIENT` to `INTERNAL`, and it now carries `gen_ai.operation.name: 'execute_tool'`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.description`, and `error.type` on failure. Non-standard fields (duration, digests, cancellation reason, internal status) move from `gen_ai.tool.*` to `armorer.tool.*` so they no longer squat the reserved `gen_ai.*` attribute namespace. This is a breaking rename for anyone matching on the old span name or attribute keys — see the mapping table in the `armorer`/`operative` READMEs.
- b2a800a: Add `createToolboxFromOpenAPI` at the `armorer/openapi` subpath: generates a schema-validated armorer tool for every operation in an OpenAPI 3.x document.
  - Parameter and request-body JSON Schemas become Zod input schemas via `jsonSchemaToZod`; local `$ref`s are resolved against `spec.components.schemas` before conversion.
  - Per-operation `ToolMetadata` follows the HTTP method: `GET`/`HEAD`/`OPTIONS`/`TRACE` are `readOnly`, the rest `mutates` (with `DELETE` additionally flagged `dangerous`).
  - `auth` supports bearer-token and API-key header injection; `allowOperations` filters the generated surface by `operationId` (a list or a predicate).
  - `baseUrl` defaults to `spec.servers[0].url`; `fetch` is injectable for testing.

  Tested against a vendored real-world OpenAPI 3.0 document (the Petstore-expanded example from `OAI/OpenAPI-Specification`), covering query/path parameters, a `$ref`-based request body, and `allOf` schema composition.

- d010dbe: `createTool`'s `input` now accepts any Standard Schema-conforming validator (Valibot, ArkType, ...), not just Zod. A non-Zod validator is wrapped as a `z.ZodTypeAny` transform internally, so the existing execute/diagnostics/serialization pipeline is unchanged — validation runs via `~standard.validate()` and the validator's transformed output (not the raw input) reaches `execute()`.

  Since a non-Zod Standard Schema has no general JSON Schema export, `createTool` now also accepts a sibling `inputSchema` option (a plain JSON Schema object) for provider serialization; `createTool` throws at creation time if a non-Zod `input` is supplied without one. Zod remains the documented default and needs no `inputSchema` — its JSON Schema is still derived automatically via `z.toJSONSchema`.

- 3818f24: Add a first-party read-only coding toolbox at the `armorer/coding` subpath: `read-file`, `grep`, and `glob`, all constrained to a caller-supplied root directory via `createRootJail`.

  `createRootJail(root)` resolves every requested path against a canonicalized root and rejects absolute paths, `..` traversal, and symlinks (at any path segment, including the leaf) that dereference outside the root, throwing a typed `PathTraversalError`.
  - `createReadFileTool` supports `offset`/`limit` line windows and caps the underlying read at `maxBytes` (default 256 KiB).
  - `createGrepTool` runs an in-process regular expression (no `child_process`) against files enumerated by `Bun.Glob`, with an optional `glob` scope filter and a `maxMatches` cap.
  - `createGlobTool` accepts repository-relative glob patterns only and caps results at `maxResults`.

  All three report an explicit `truncated: boolean` marker and carry `metadata: { readOnly: true, mutates: false, dangerous: false }`. `createCodingTools`/`createCodingToolbox` bundle all three under a shared jail. This is a read-only surface — write, edit, and shell tools are intentionally out of scope pending the AB-42 sandbox decision.

- 844fdba: Add a headless deny-by-default permission mode (AB-94), built on the AB-22 two-axis approval surface: `createHeadlessPermissionPolicyHooks({ allowList, denyList?, capability?, gate? })`. `allowList` is required — any tool name absent from it is denied outright, not merely hidden. `denyList` always wins over `allowList`. An optional `capability` (AB-22's `ApprovalPolicyConfiguration`) layers the capability-tier axis on top, with one headless-specific resolution: a combined `ask` verdict (this run never parks on a human) becomes `deny` instead. An optional synchronous `gate(toolName, input)` re-checks the parsed arguments per call — Tribunal's `canUseTool` parity — and can deny input-dependent violations (e.g. a path that escapes a jail root) that a static name list can't express. All three axes compose with `deny > ask > allow` precedence via the existing `combineApprovalStatuses`. A denial reaches the standard armorer deny path (`create-tool.ts`): the model receives a redacted tool-error result and the run loop continues — nothing here throws or parks on `needs_approval`. New exports: `createHeadlessPermissionPolicyHooks`, `evaluateHeadlessPermission`, and the `HeadlessPermissionPolicyConfiguration`/`HeadlessPermissionResult`/`PermissionGate`/`PermissionGateDecision` types.

## 0.9.0

### Minor Changes

- d3ec2a6: Add runtime availability hooks for Armorer tools and propagate the new unavailable tool error category through shared tool-result schemas.
- 9e86328: Add first-class untrusted-output risk tagging and fencing middleware for tool results.

## 0.8.2

### Patch Changes

- 3472e8b: Remove workspace-only development dependencies from published package manifests and fail package-shape validation when a packed manifest leaks `workspace:` dependency ranges.

## 0.8.1

### Patch Changes

- edaedae: Add regression test for durable cross-process approval round-trip: serializes a signed pending-approval descriptor to JSON, deserializes it in a fresh toolbox instance (simulating a separate process), and verifies the resume executes correctly with re-validation.
- edaedae: Add regression tests for externally-supplied idempotency keys with crash recovery, pinning the at-least-once executor safety contract: a caller-supplied key left in the durable "started" state (driven directly via the cache primitive, decoupled from any thrown-error path) reports unknown-outcome on retry rather than blindly re-running the side effect. A second test pins the thrown-uncategorized-error orphaned-start path explicitly.
- edaedae: Add regression test for OpenTelemetry parent context injection: with a single tracer it pins both halves of the contract — a call with no parentContext forwards `undefined` to `startSpan` (so the OTel SDK applies its own ambient/root context) while a sibling call with a sentinel parentContext forwards that exact value by identity, proving the `undefined` path is a genuine "no parent" decision rather than a shallow default.

## 0.8.0

### Minor Changes

- 5e0c4a9: Add durable approval resume, parent trace context, structured head/tail truncation, and explicit fresh/deduped/unknown idempotency outcomes for at-least-once tool executors.

  Pending approvals can now be signed with a toolbox `approvalSecret`. Approvals created before this release do not have an `approvalToken`, so recreate and re-approve them before resuming. The old `ToolExecuteOptions.approved` and `proposedArguments` policy bypass path has been removed; use `Toolbox.resumeApproval()` with a `SignedPendingToolApproval` instead. Cache keys produced by `withIdempotency()` and caller-supplied toolbox `idempotencyKey` values are now scoped as `toolName:key`; migrate those entries or clear affected idempotency caches before rollout.

- a999732: Add toolbox execution options for parent OpenTelemetry context and span links so instrumented tool spans can attach to orchestrator traces.

## 0.7.1

### Documentation

- **Common Patterns Guide**: Added comprehensive `documentation/patterns/` with practical examples for implementing advanced patterns using existing primitives:
  - Circuit breaker pattern for preventing cascading failures
  - Session management with context and middleware
  - Request deduplication for concurrent identical requests
  - Resource pooling for database connections and API clients
  - Fallback tools for graceful degradation
  - Tool dependency management and execution order
  - Audit trails for compliance and debugging
  - Cost tracking and per-user quotas
  - Conditional execution and multi-way branching
  - State management with persistence
  - Structured logging middleware
  - Streaming responses with events and async iterators

## 0.7.0

### Breaking Changes

- **Armorer → Toolbox Rename**: Complete rename of all Armorer-related APIs to Toolbox for improved clarity:
  - `createArmorer()` → `createToolbox()`
  - `isArmorer()` → `isToolbox()`
  - `combineArmorers()` → `combineToolboxes()`
  - `Armorer` type → `Toolbox`
  - `ArmorerTool` → `Tool`
  - `ArmorerContext` → `ToolboxContext`
  - All related types and interfaces updated accordingly

### Core Runtime Completeness

- **Dry-Run in Composition**: `pipe`, `compose`, `parallel`, `retry`, `when`, `tap`, `bind`, `preprocess`, and `postprocess` now correctly propagate `dryRun` mode to underlying tools.
- **Consistent Tool Identity**: The registry now indexes tools by ID (`namespace:name@version`) instead of just name, resolving collisions when multiple versions or namespaces share a name. `getTool` now accepts ID or name.
- **OpenAI Adapter Naming**: Added `naming: 'safe-id'` option to `toOpenAI` to solve name collisions by using sanitized IDs. Added `createNameMapper` helper to resolve sanitized names back to tool IDs.
- **Policy Outcomes**: Added first-class `action_required` outcome for policy decisions with `status: 'needs_approval'` or `'needs_input'`, and new event `policy-action-required`.
- **API Surface**: Exported `ToolboxExecuteOptions` and ensured `createTool` passes all options (including `outputShaping`, `telemetry`, `diagnostics`) when used with an Toolbox instance.

### Documentation

- **Common Patterns Guide**: Added comprehensive `documentation/patterns/` with practical examples for implementing advanced patterns using existing primitives:
  - Circuit breaker pattern for preventing cascading failures
  - Session management with context and middleware
  - Request deduplication for concurrent identical requests
  - Resource pooling for database connections and API clients
  - Fallback tools for graceful degradation
  - Tool dependency management and execution order
  - Audit trails for compliance and debugging
  - Cost tracking and per-user quotas
  - Conditional execution and multi-way branching
  - State management with persistence
  - Structured logging middleware
  - Streaming responses with events and async iterators

## 0.6.1

- Aligned build output paths with package exports so types and sourcemaps ship under `dist/`.
- Added a tag-driven GitHub Actions release workflow with npm trusted publishing.
- Added release tag/version verification for CI.

## 0.5.0

- Added `armorer/claude-agent-sdk` adapter helpers for Claude Agent SDK MCP tooling.
- Added `createClaudeToolGate` to generate SDK tool allow/deny policies.
- Added `metadata.dangerous` with registry-level `allowDangerous` enforcement.
- Auto-annotated read-only MCP tools with `readOnlyHint`.
