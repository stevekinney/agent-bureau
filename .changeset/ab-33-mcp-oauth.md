---
'armorer': minor
---

Add MCP OAuth client support (`armorer/mcp`), implemented against the MCP Authorization spec (base revision 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), plus RFC 9207 issuer-response validation as defined in the current draft revision (https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-response-validation).

- `createMcpOAuthProvider`: builds an `OAuthClientProvider` for `@modelcontextprotocol/sdk`'s `auth()` orchestrator and `StreamableHTTPClientTransport`, backed entirely by a caller-supplied `McpOAuthTokenStorage` hook — this module never persists tokens, PKCE verifiers, client registration, or discovery state itself. PKCE, RFC 9728/8414 discovery, dynamic client registration, and token refresh are all handled by the SDK's `client/auth.js`; this factory just wires a storage-agnostic provider around it.
- `createInMemoryMcpOAuthTokenStorage`: a non-persistent `McpOAuthTokenStorage` for tests, scripts, and other single-process use.
- `validateMcpAuthorizationResponseIssuer` / `McpAuthorizationIssuerValidationError`: validates an authorization redirect's `iss` parameter per RFC 9207 §2.4 against the issuer recorded during discovery, applying the MCP spec's `authorization_response_iss_parameter_supported` decision table. Guards against authorization-server mix-up attacks.
- `parseMcpAuthorizationCallback`: parses `code`/`state`/`iss`/`error` off an authorization redirect URL.
- `completeMcpOAuthAuthorization`: orchestrates finishing a flow after the redirect — validates `iss` (before ever inspecting `error`, per spec), verifies `state`, then exchanges the code for tokens.
- `connectMcpClientWithOAuth` / `fromMcpClientTools`: connects an MCP `Client` over Streamable HTTP with the OAuth provider wired in, and lists+converts its tools into executable Toolbox `Tool`s via the existing `fromMcpTools`.
- `isMcpUnauthorizedError`: a dual-package-hazard-safe check for the SDK's `UnauthorizedError` (compares `error.constructor.name` rather than `instanceof`, since this module lazily loads the SDK's CJS build while a consumer may have imported its ESM build directly).

Covered by a test suite against a mock OAuth authorization server + protected resource server built with `Bun.serve` in-test (no live endpoints): full PKCE authorization-code flow through to a tool call, token refresh, and two RFC 9207 rejection cases (mismatched `iss`, missing `iss` when the server advertises support).
