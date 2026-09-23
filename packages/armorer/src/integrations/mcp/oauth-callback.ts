import type {
  AuthorizationServerMetadata,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/client';

/**
 * Thrown when an authorization redirect fails RFC 9207 issuer validation.
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
 * Validates an authorization redirect's `iss` parameter per RFC 9207.
 *
 * The discovery state carries the authorization server metadata recorded
 * before redirecting. An advertised-but-missing issuer, a response issuer
 * without a recorded comparison value, or a mismatch is rejected before the
 * authorization code reaches a token endpoint.
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

  // RFC 3986 section 6.2.1 requires simple string comparison.
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

/** Parses an MCP OAuth redirect callback's query parameters. */
export function parseMcpAuthorizationCallback(
  callbackUrl: string | URL,
): McpAuthorizationCallbackParams {
  const params = extractCallbackSearchParams(callbackUrl);
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

function extractCallbackSearchParams(callbackUrl: string | URL): URLSearchParams {
  if (callbackUrl instanceof URL) {
    return callbackUrl.searchParams;
  }
  try {
    return new URL(callbackUrl).searchParams;
  } catch {
    const queryString = callbackUrl.startsWith('?') ? callbackUrl.slice(1) : callbackUrl;
    return new URLSearchParams(queryString);
  }
}
