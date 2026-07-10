/**
 * MCP OAuth client support.
 *
 * Implements the client side of the MCP Authorization flow described in the
 * MCP specification (base revision 2025-06-18:
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization),
 * plus the RFC 9207 authorization-response issuer validation defined in the
 * current draft revision
 * (https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-response-validation).
 *
 * All of the OAuth 2.1 mechanics — PKCE, RFC 9728 protected-resource
 * discovery, RFC 8414 / OpenID Connect authorization-server discovery,
 * dynamic client registration, and token refresh — are implemented by
 * `@modelcontextprotocol/sdk`'s `client/auth.js` module and its
 * `StreamableHTTPClientTransport`. This module supplies the missing pieces an
 * integrator would otherwise have to hand-roll:
 *
 * - An {@link OAuthClientProvider} implementation backed by a pluggable
 *   {@link McpOAuthTokenStorage} hook, so the integrator supplies *where*
 *   tokens/PKCE state/discovery state live without reimplementing the
 *   provider interface (this module never persists anything itself).
 * - RFC 9207 `iss` validation of the authorization redirect, applied via
 *   {@link validateMcpAuthorizationResponseIssuer} before any authorization
 *   code is transmitted to a token endpoint.
 * - Thin orchestration ({@link connectMcpClientWithOAuth},
 *   {@link completeMcpOAuthAuthorization}, {@link fromMcpClientTools}) that
 *   wires the provider, the SDK's Streamable HTTP transport, and
 *   {@link fromMcpTools} together into a connect → (maybe authorize) →
 *   list-tools flow.
 */
import type {
  AddClientAuthentication,
  AuthResult,
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  Client as McpClientClass,
  ClientOptions,
} from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Implementation } from '@modelcontextprotocol/sdk/types.js';

import type { Tool } from '../../is-tool';
import { fromMcpTools } from './index';

/**
 * The subset of OAuth client state that must survive across the redirect to
 * the authorization server and back. Callers provide the actual persistence
 * (memory, a database row, an encrypted cookie, ...) via
 * {@link McpOAuthTokenStorage}; this module only ever reads/writes through
 * that hook.
 */
export type McpOAuthStorageState = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discovery?: OAuthDiscoveryState;
};

/**
 * Pluggable token-storage hook. `createMcpOAuthProvider` reads and writes
 * OAuth state exclusively through this interface — it never persists tokens,
 * client registration, PKCE verifiers, or discovery state on its own.
 * Implement this against whatever storage the integrator already has
 * (in-memory map, database row, encrypted session, ...).
 */
export type McpOAuthTokenStorage = {
  load(): McpOAuthStorageState | Promise<McpOAuthStorageState>;
  save(patch: Partial<McpOAuthStorageState>): void | Promise<void>;
  clear?(keys: ReadonlyArray<keyof McpOAuthStorageState>): void | Promise<void>;
};

/**
 * An in-memory {@link McpOAuthTokenStorage} for tests, scripts, and other
 * single-process, non-persistent use. Production integrators should supply
 * their own hook backed by durable storage — state is lost when this
 * storage's owning process exits.
 */
export function createInMemoryMcpOAuthTokenStorage(): McpOAuthTokenStorage {
  let state: McpOAuthStorageState = {};
  return {
    load() {
      return { ...state };
    },
    save(patch) {
      state = { ...state, ...patch };
    },
    clear(keys) {
      const next = { ...state };
      for (const key of keys) {
        delete next[key];
      }
      state = next;
    },
  };
}

export type McpOAuthProviderOptions = {
  /** Redirect URI registered with the authorization server. */
  redirectUrl: string | URL;
  /** OAuth client metadata used for dynamic client registration / discovery. */
  clientMetadata: OAuthClientMetadata;
  /** Where PKCE verifiers, tokens, client registration, and discovery state are persisted. */
  tokenStorage: McpOAuthTokenStorage;
  /**
   * Invoked with the authorization URL the resource owner must visit. This
   * module never opens a browser or performs an HTTP redirect itself — the
   * integrator decides how to get the user there (send a link, open a
   * webview, redirect an HTTP response, ...).
   */
  onAuthorizationRequired: (authorizationUrl: URL) => void | Promise<void>;
  clientMetadataUrl?: string;
  addClientAuthentication?: AddClientAuthentication;
  validateResourceURL?: OAuthClientProvider['validateResourceURL'];
};

/**
 * Builds an {@link OAuthClientProvider} for use with the MCP SDK's `auth()`
 * orchestrator and `StreamableHTTPClientTransport`. All state (PKCE
 * verifier, tokens, dynamically-registered client information, and RFC
 * 9728/8414 discovery state) round-trips through the supplied
 * {@link McpOAuthTokenStorage} hook.
 */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
  const {
    redirectUrl,
    clientMetadata,
    tokenStorage,
    onAuthorizationRequired,
    clientMetadataUrl,
    addClientAuthentication,
    validateResourceURL,
  } = options;

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    async state() {
      const stored = await tokenStorage.load();
      if (stored.state) return stored.state;
      const generated = crypto.randomUUID();
      await tokenStorage.save({ state: generated });
      return generated;
    },
    async clientInformation() {
      const stored = await tokenStorage.load();
      return stored.clientInformation;
    },
    async saveClientInformation(clientInformation) {
      await tokenStorage.save({ clientInformation });
    },
    async tokens() {
      const stored = await tokenStorage.load();
      return stored.tokens;
    },
    async saveTokens(tokens) {
      await tokenStorage.save({ tokens });
    },
    async redirectToAuthorization(authorizationUrl) {
      await onAuthorizationRequired(authorizationUrl);
    },
    async saveCodeVerifier(codeVerifier) {
      await tokenStorage.save({ codeVerifier });
    },
    async codeVerifier() {
      const stored = await tokenStorage.load();
      if (!stored.codeVerifier) {
        throw new Error(
          'No PKCE code verifier has been saved for this MCP OAuth session; start the authorization flow before finishing it.',
        );
      }
      return stored.codeVerifier;
    },
    async saveDiscoveryState(discovery) {
      await tokenStorage.save({ discovery });
    },
    async discoveryState() {
      const stored = await tokenStorage.load();
      return stored.discovery;
    },
    async invalidateCredentials(scope) {
      if (!tokenStorage.clear) return;
      switch (scope) {
        case 'all': {
          await tokenStorage.clear([
            'clientInformation',
            'tokens',
            'codeVerifier',
            'state',
            'discovery',
          ]);
          break;
        }
        case 'client': {
          await tokenStorage.clear(['clientInformation']);
          break;
        }
        case 'tokens': {
          await tokenStorage.clear(['tokens']);
          break;
        }
        case 'verifier': {
          await tokenStorage.clear(['codeVerifier']);
          break;
        }
        case 'discovery': {
          await tokenStorage.clear(['discovery']);
          break;
        }
        // No default
      }
    },
  };
  if (clientMetadataUrl !== undefined) {
    provider.clientMetadataUrl = clientMetadataUrl;
  }
  if (addClientAuthentication) {
    provider.addClientAuthentication = addClientAuthentication;
  }
  if (validateResourceURL) {
    provider.validateResourceURL = validateResourceURL;
  }
  return provider;
}

/**
 * Thrown when an authorization redirect fails RFC 9207 issuer validation —
 * either the `iss` parameter is missing when the authorization server
 * advertised it would be sent, or it does not match the issuer recorded from
 * the authorization server's metadata document.
 */
export class McpAuthorizationIssuerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAuthorizationIssuerValidationError';
  }
}

function readAuthorizationServerIssuerInfo(metadata: AuthorizationServerMetadata | undefined): {
  issuer: string | undefined;
  issSupported: boolean;
} {
  if (!metadata) {
    return { issuer: undefined, issSupported: false };
  }
  const issuer = typeof metadata.issuer === 'string' ? metadata.issuer : undefined;
  const loose = metadata as unknown as Record<string, unknown>;
  const flag = loose['authorization_response_iss_parameter_supported'];
  return { issuer, issSupported: flag === true };
}

/**
 * Validates an authorization redirect's `iss` parameter per
 * {@link https://datatracker.ietf.org/doc/html/rfc9207#section-2.4 | RFC 9207 §2.4},
 * as required by the MCP authorization spec's
 * {@link https://modelcontextprotocol.io/specification/draft/basic/authorization#authorization-response-validation | Authorization Response Validation}
 * section:
 *
 * | `authorization_response_iss_parameter_supported` | `iss` in response | action  |
 * | ------------------------------------------------- | ------------------ | ------- |
 * | `true`                                             | present            | compare |
 * | `true`                                             | absent             | reject  |
 * | `false` or absent                                  | present            | compare |
 * | `false` or absent                                  | absent             | proceed |
 *
 * `discoveryState` is the value persisted by {@link createMcpOAuthProvider}'s
 * `saveDiscoveryState`/`discoveryState` hooks during the `auth()` call that
 * produced the authorization URL — it carries the authorization server
 * metadata (and therefore its `issuer` claim) that this comparison is
 * anchored to.
 *
 * @throws {McpAuthorizationIssuerValidationError} if validation fails.
 */
export function validateMcpAuthorizationResponseIssuer(options: {
  discoveryState: OAuthDiscoveryState | undefined;
  iss: string | undefined;
}): void {
  const { discoveryState, iss } = options;
  const { issuer, issSupported } = readAuthorizationServerIssuerInfo(
    discoveryState?.authorizationServerMetadata,
  );

  if (iss === undefined) {
    if (issSupported) {
      throw new McpAuthorizationIssuerValidationError(
        'Authorization server advertises authorization_response_iss_parameter_supported=true but the authorization response omitted the `iss` parameter (RFC 9207 section 2.4).',
      );
    }
    return;
  }

  if (!issuer) {
    throw new McpAuthorizationIssuerValidationError(
      'Authorization response included an `iss` parameter but no authorization-server issuer was recorded to validate it against. Ensure discovery ran (and its state was persisted) before redirecting for authorization.',
    );
  }

  // RFC 3986 section 6.2.1 simple string comparison — no scheme/host case
  // folding, default-port elision, trailing-slash, or percent-encoding
  // normalization.
  if (iss !== issuer) {
    throw new McpAuthorizationIssuerValidationError(
      `Authorization response \`iss\` ("${iss}") does not match the recorded authorization server issuer ("${issuer}"); rejecting per RFC 9207 to guard against authorization-server mix-up attacks.`,
    );
  }
}

export type McpAuthorizationCallbackParams = {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
};

/** Parses the query parameters of an MCP OAuth authorization redirect callback. */
export function parseMcpAuthorizationCallback(
  callbackUrl: string | URL,
): McpAuthorizationCallbackParams {
  const url = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
  const params = url.searchParams;
  const result: McpAuthorizationCallbackParams = {};
  const code = params.get('code');
  const state = params.get('state');
  const iss = params.get('iss');
  const error = params.get('error');
  const errorDescription = params.get('error_description');
  if (code !== null) result.code = code;
  if (state !== null) result.state = state;
  if (iss !== null) result.iss = iss;
  if (error !== null) result.error = error;
  if (errorDescription !== null) result.errorDescription = errorDescription;
  return result;
}

export type CompleteMcpOAuthAuthorizationOptions = {
  /** Canonical URI of the MCP server (used as the RFC 8707 `resource`). */
  serverUrl: string | URL;
  /** The full redirect URL (or just its query string) the authorization server sent the user agent back to. */
  callbackUrl: string | URL;
  /** The same storage hook passed to {@link createMcpOAuthProvider} for this session. */
  tokenStorage: McpOAuthTokenStorage;
  fetchFn?: FetchLike;
};

/**
 * Completes an MCP OAuth authorization flow after the resource owner has
 * been redirected back from the authorization server.
 *
 * 1. Parses `code`/`state`/`iss`/`error` from the callback URL.
 * 2. Validates `iss` per RFC 9207 ({@link validateMcpAuthorizationResponseIssuer})
 *    against the discovery state recorded when the flow started — this runs
 *    *before* any `error` field is inspected, per spec ("on mismatch the
 *    client MUST NOT act on or display `error`, `error_description`, or
 *    `error_uri`").
 * 3. Verifies the OAuth `state` parameter round-trips, discarding the
 *    response on mismatch.
 * 4. Exchanges the authorization code for tokens via the SDK's `auth()`
 *    orchestrator (PKCE verifier included automatically by the provider).
 */
export async function completeMcpOAuthAuthorization(
  provider: OAuthClientProvider,
  options: CompleteMcpOAuthAuthorizationOptions,
): Promise<AuthResult> {
  const { serverUrl, callbackUrl, tokenStorage, fetchFn } = options;
  const { code, state, iss, error, errorDescription } = parseMcpAuthorizationCallback(callbackUrl);

  const stored = await tokenStorage.load();
  validateMcpAuthorizationResponseIssuer({ discoveryState: stored.discovery, iss });

  if (stored.state !== undefined && state !== stored.state) {
    throw new Error(
      "Authorization response `state` does not match the value recorded for this session; discarding the response per the MCP spec's open-redirection guidance.",
    );
  }

  if (error !== undefined) {
    throw new Error(
      `Authorization server returned an error: ${error}${errorDescription ? ` (${errorDescription})` : ''}`,
    );
  }

  if (!code) {
    throw new Error('Authorization callback is missing the required `code` parameter.');
  }

  const { auth } = await requireMcpClientAuth();
  return auth(provider, {
    serverUrl,
    authorizationCode: code,
    ...(fetchFn ? { fetchFn } : {}),
  });
}

export type ConnectMcpClientWithOAuthOptions = {
  /** Canonical URI of the MCP server to connect to over Streamable HTTP. */
  serverUrl: string | URL;
  /** An {@link OAuthClientProvider}, typically from {@link createMcpOAuthProvider}. */
  provider: OAuthClientProvider;
  clientInfo?: Implementation;
  clientOptions?: ClientOptions;
  transportOptions?: Omit<StreamableHTTPClientTransportOptions, 'authProvider'>;
};

const DEFAULT_MCP_CLIENT_INFO: Implementation = {
  name: 'armorer-mcp-client',
  version: '0.0.0',
};

/**
 * Connects an MCP `Client` to a server over Streamable HTTP with the given
 * OAuth provider wired in.
 *
 * If no valid token is available and the server requires authorization, the
 * SDK's transport calls `provider.redirectToAuthorization` (i.e. the
 * `onAuthorizationRequired` callback passed to {@link createMcpOAuthProvider})
 * and then throws `UnauthorizedError` from this function — the caller
 * completes the flow with {@link completeMcpOAuthAuthorization} and calls
 * this function again to connect with the newly obtained token.
 */
export async function connectMcpClientWithOAuth(
  options: ConnectMcpClientWithOAuthOptions,
): Promise<McpClientClass> {
  const { serverUrl, provider, clientInfo, clientOptions, transportOptions } = options;
  const { StreamableHTTPClientTransport } = await requireMcpClientTransport();
  const { Client } = await requireMcpClient();
  const url = serverUrl instanceof URL ? serverUrl : new URL(serverUrl);
  const transport = new StreamableHTTPClientTransport(url, {
    ...transportOptions,
    authProvider: provider,
  });
  const client = new Client(clientInfo ?? DEFAULT_MCP_CLIENT_INFO, clientOptions);
  await client.connect(transport);
  return client;
}

/**
 * Reports whether `error` is the MCP SDK's `UnauthorizedError` — thrown by
 * {@link connectMcpClientWithOAuth} when authorization is required (after
 * `onAuthorizationRequired` has already been called with the URL to send the
 * resource owner to) or when a session has expired mid-connection.
 *
 * This checks `error.constructor.name` rather than `instanceof
 * UnauthorizedError` because `@modelcontextprotocol/sdk` ships both ESM and
 * CJS builds; an integrator that imports the SDK's ESM entry directly while
 * this module lazily `require()`s the CJS entry (to keep the SDK an optional
 * peer dependency) would otherwise be comparing against two distinct classes
 * for the same conceptual error.
 */
export function isMcpUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.constructor.name === 'UnauthorizedError';
}

/**
 * Lists tools from a connected MCP `Client` and converts them into executable
 * Toolbox {@link Tool}s via {@link fromMcpTools}, routing calls back through
 * the client's `callTool`.
 */
export async function fromMcpClientTools(client: McpClientClass): Promise<Tool[]> {
  const { tools } = await client.listTools();
  return fromMcpTools(tools, {
    callTool: (request) => client.callTool(request) as Promise<CallToolResult>,
  });
}

type McpClientAuthSdk = typeof import('@modelcontextprotocol/sdk/client/auth.js');
type McpClientTransportSdk = typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');
type McpClientSdk = typeof import('@modelcontextprotocol/sdk/client/index.js');

let cachedMcpClientAuthSdk: McpClientAuthSdk | undefined;
const defaultMcpClientAuthLoader = async (): Promise<McpClientAuthSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/client/auth.js') as McpClientAuthSdk;
};
let mcpClientAuthLoader: () => McpClientAuthSdk | Promise<McpClientAuthSdk> =
  defaultMcpClientAuthLoader;

async function requireMcpClientAuth(): Promise<McpClientAuthSdk> {
  if (cachedMcpClientAuthSdk) return cachedMcpClientAuthSdk;
  cachedMcpClientAuthSdk = await loadOptionalMcpModule(
    mcpClientAuthLoader,
    'armorer/mcp OAuth support',
  );
  return cachedMcpClientAuthSdk;
}

let cachedMcpClientTransportSdk: McpClientTransportSdk | undefined;
const defaultMcpClientTransportLoader = async (): Promise<McpClientTransportSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/client/streamableHttp.js') as McpClientTransportSdk;
};
let mcpClientTransportLoader: () => McpClientTransportSdk | Promise<McpClientTransportSdk> =
  defaultMcpClientTransportLoader;

async function requireMcpClientTransport(): Promise<McpClientTransportSdk> {
  if (cachedMcpClientTransportSdk) return cachedMcpClientTransportSdk;
  cachedMcpClientTransportSdk = await loadOptionalMcpModule(
    mcpClientTransportLoader,
    'armorer/mcp OAuth support',
  );
  return cachedMcpClientTransportSdk;
}

let cachedMcpClientSdk: McpClientSdk | undefined;
const defaultMcpClientLoader = async (): Promise<McpClientSdk> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return require('@modelcontextprotocol/sdk/client/index.js') as McpClientSdk;
};
let mcpClientLoader: () => McpClientSdk | Promise<McpClientSdk> = defaultMcpClientLoader;

async function requireMcpClient(): Promise<McpClientSdk> {
  if (cachedMcpClientSdk) return cachedMcpClientSdk;
  cachedMcpClientSdk = await loadOptionalMcpModule(mcpClientLoader, 'armorer/mcp OAuth support');
  return cachedMcpClientSdk;
}

async function loadOptionalMcpModule<T>(
  loader: () => T | Promise<T>,
  hintSuffix: string,
): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    const hint = `Missing peer dependency "@modelcontextprotocol/sdk". Install it to use ${hintSuffix}.`;
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.message = `${hint}\n${wrapped.message}`;
    throw wrapped;
  }
}

export const internalMcpOAuthTestUtilities = {
  resetModuleState() {
    cachedMcpClientAuthSdk = undefined;
    mcpClientAuthLoader = defaultMcpClientAuthLoader;
    cachedMcpClientTransportSdk = undefined;
    mcpClientTransportLoader = defaultMcpClientTransportLoader;
    cachedMcpClientSdk = undefined;
    mcpClientLoader = defaultMcpClientLoader;
  },
  setClientAuthLoader(loader: (() => McpClientAuthSdk | Promise<McpClientAuthSdk>) | undefined) {
    cachedMcpClientAuthSdk = undefined;
    mcpClientAuthLoader = loader ?? defaultMcpClientAuthLoader;
  },
};
