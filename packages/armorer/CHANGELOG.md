# Changelog

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
