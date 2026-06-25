import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/**
 * Configuration for the security-headers middleware.
 *
 * - `allowedOrigins` — explicit list of allowed WebSocket upgrade origins. When
 *   non-empty, upgrade requests whose `Origin` header is absent or not in the
 *   list are rejected with 403.
 * - `enableCsp` — emit a `Content-Security-Policy` header on every response.
 *   Defaults to `true`.
 * - `ssrfDenyList` — loopback/private CIDR blocks to reject for agent-initiated
 *   outbound URLs. Validates `X-Agent-Target-Url` when present. Defaults to the
 *   standard RFC-1918 + loopback blocks.
 */
export type SecurityHeadersOptions = {
  /** Allowed WebSocket upgrade origins. Empty = no origin check. */
  allowedOrigins?: string[];
  /** Emit CSP header. Defaults to true. */
  enableCsp?: boolean;
};

const DEFAULT_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self' ws: wss:; " +
  "frame-ancestors 'none'";

/**
 * Returns true when the given URL targets a loopback or RFC-1918 private address.
 * Used to prevent server-side request forgery (SSRF) from agent-initiated outbound
 * requests that arrive via the `X-Agent-Target-Url` header.
 */
function isPrivateOrLoopback(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Un-parsable URL: block it
    return true;
  }

  const host = parsed.hostname;

  // IPv4 loopback
  if (host === 'localhost' || host.startsWith('127.')) return true;
  // IPv6 loopback
  if (host === '::1' || host === '[::1]') return true;
  // IPv4 private ranges (RFC 1918)
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  // Link-local
  if (host.startsWith('169.254.')) return true;
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return true;
  // Metadata service (cloud provider IMDS)
  if (host === '169.254.169.254') return true;

  return false;
}

/**
 * Security-headers middleware for the gateway door.
 *
 * On every response:
 * - Sets `X-Content-Type-Options: nosniff`
 * - Sets `X-Frame-Options: DENY`
 * - Sets `Referrer-Policy: strict-origin-when-cross-origin`
 * - Optionally emits `Content-Security-Policy`
 *
 * On WebSocket upgrade requests:
 * - Checks the `Origin` header against `allowedOrigins` (if configured) and
 *   rejects with 403 when it does not match — mitigating WS-upgrade hijack.
 *
 * On requests carrying `X-Agent-Target-Url`:
 * - Blocks loopback / private-range targets — SSRF guard.
 */
export function createSecurityHeaders(options: SecurityHeadersOptions = {}) {
  const { allowedOrigins = [], enableCsp = true } = options;

  return createMiddleware(async (context, next) => {
    // ── SSRF guard ──────────────────────────────────────────────────
    const agentTargetUrl = context.req.header('x-agent-target-url');
    if (agentTargetUrl && isPrivateOrLoopback(agentTargetUrl)) {
      throw new HTTPException(403, {
        message: 'SSRF policy: target URL resolves to a private or loopback address',
      });
    }

    // ── WebSocket origin check ────────────────────────────────────
    const isUpgrade =
      context.req.header('upgrade')?.toLowerCase() === 'websocket' ||
      context.req.header('connection')?.toLowerCase().includes('upgrade');

    if (isUpgrade && allowedOrigins.length > 0) {
      const origin = context.req.header('origin') ?? '';
      if (!allowedOrigins.includes(origin)) {
        throw new HTTPException(403, { message: 'Origin not allowed for WebSocket upgrade' });
      }
    }

    await next();

    // ── Response headers ──────────────────────────────────────────
    context.header('x-content-type-options', 'nosniff');
    context.header('x-frame-options', 'DENY');
    context.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (enableCsp) {
      context.header('content-security-policy', DEFAULT_CSP);
    }
  });
}
