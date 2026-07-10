import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';

import { sha256HexSync, timingSafeEqualHex } from 'interoperability';

import { parseSkillMarkdown, SkillParseError } from '../parse-skill-markdown';
import type { SkillProvider } from '../types';

export interface FetchFromRegistryOptions {
  /** Base URL of the skill registry. */
  baseUrl: string;
  /** Skill names to fetch. */
  names: string[];
  /** Skill provider to save fetched skills to. */
  provider: SkillProvider;
  /** Custom fetch function (for testing). Defaults to global fetch. */
  fetchFunction?: typeof fetch;
  /** Bearer token sent as `Authorization: Bearer <authToken>` on every registry request. */
  authToken?: string;
  /**
   * Expected SHA-256 hex digests of the raw `SKILL.md` content, keyed by skill name.
   * When a name has a pinned hash, the fetched content's digest must match it exactly —
   * a mismatch is always rejected, regardless of {@link FetchFromRegistryOptions.allowUnverified}.
   */
  expectedHashes?: Record<string, string>;
  /**
   * SPKI PEM-encoded Ed25519 public key used to verify detached signatures.
   * When set, each skill's signature is fetched from `{baseUrl}/{name}/SKILL.md.sig`
   * (a base64-encoded detached Ed25519 signature over the raw `SKILL.md` bytes) and
   * verified against this key. A present-but-invalid signature is always rejected,
   * regardless of {@link FetchFromRegistryOptions.allowUnverified}.
   */
  publicKey?: string;
  /**
   * Opt out of the default "reject unverified content" policy. When a skill has
   * neither a matching entry in `expectedHashes` nor a signature that verifies
   * against `publicKey`, it is rejected by default. Set this to `true` to allow
   * such content through anyway. This does NOT rescue a hash mismatch or a signature
   * that fails verification — those are always rejected as evidence of tampering.
   * Default: `false`.
   */
  allowUnverified?: boolean;
}

export interface FetchResult {
  /** Skills successfully fetched and saved. */
  loaded: string[];
  /** Errors encountered. */
  errors: Array<{ name: string; error: string }>;
}

/**
 * Verifies fetched skill content against integrity guards before it is saved.
 *
 * Signing/verification convention:
 * - Content hash pinning: callers may pass `expectedHashes[name]`, a SHA-256 hex
 *   digest of the raw `SKILL.md` bytes. A mismatch is always rejected.
 * - Detached signatures: when `publicKey` (SPKI PEM, Ed25519) is configured, the
 *   registry is expected to also serve a base64-encoded detached signature at
 *   `{baseUrl}/{name}/SKILL.md.sig`, computed over the raw `SKILL.md` bytes. An
 *   invalid signature is always rejected.
 * - Unverified content — no matching hash pin and no valid signature — is rejected
 *   by default. Pass `allowUnverified: true` to explicitly opt out.
 */
async function verifyContent(
  name: string,
  content: string,
  options: Pick<FetchFromRegistryOptions, 'expectedHashes' | 'publicKey' | 'allowUnverified'>,
  fetchSignature: () => Promise<string | undefined>,
): Promise<void> {
  const expectedHash = options.expectedHashes?.[name];
  const hashPinned = expectedHash !== undefined;

  if (hashPinned) {
    const actualHash = sha256HexSync(content);
    if (!timingSafeEqualHex(actualHash, expectedHash)) {
      throw new Error(`Content hash mismatch for skill "${name}": tampered or corrupted content`);
    }
  }

  let signatureVerified = false;
  if (options.publicKey) {
    const signature = await fetchSignature();
    if (signature !== undefined) {
      if (!verifyDetachedSignature(content, signature, options.publicKey)) {
        throw new Error(`Signature verification failed for skill "${name}"`);
      }
      signatureVerified = true;
    }
  }

  if (!hashPinned && !signatureVerified && !options.allowUnverified) {
    throw new Error(
      `Skill "${name}" has no content hash pin or valid signature; refusing unverified content (set allowUnverified to opt out)`,
    );
  }
}

/** Verifies a base64-encoded detached Ed25519 signature over `content` using an SPKI PEM public key. */
function verifyDetachedSignature(
  content: string,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureBase64.trim(), 'base64');
    return verifyEd25519(null, Buffer.from(content), publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Fetches skills from a remote registry and saves them to the provider.
 * The registry is expected to serve SKILL.md content at `{baseUrl}/{name}/SKILL.md`.
 *
 * See {@link FetchFromRegistryOptions.expectedHashes} and
 * {@link FetchFromRegistryOptions.publicKey} for the integrity/signing convention.
 * Unverified content is rejected by default — see {@link FetchFromRegistryOptions.allowUnverified}.
 */
export async function fetchFromRegistry(options: FetchFromRegistryOptions): Promise<FetchResult> {
  const { baseUrl, names, provider, fetchFunction = globalThis.fetch, authToken } = options;

  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const result: FetchResult = {
    loaded: [],
    errors: [],
  };

  for (const name of names) {
    const url = `${baseUrl}/${name}/SKILL.md`;

    try {
      const response = await fetchFunction(url, { headers });

      if (!response.ok) {
        result.errors.push({
          name,
          error: `Registry returned ${response.status} for skill "${name}"`,
        });
        continue;
      }

      const text = await response.text();

      await verifyContent(name, text, options, async () => {
        const signatureUrl = `${baseUrl}/${name}/SKILL.md.sig`;
        const signatureResponse = await fetchFunction(signatureUrl, { headers });
        if (!signatureResponse.ok) {
          return undefined;
        }
        return await signatureResponse.text();
      });

      const parsed = parseSkillMarkdown(text);

      await provider.saveSkill(parsed.metadata.name, parsed);
      result.loaded.push(parsed.metadata.name);
    } catch (error) {
      const message =
        error instanceof SkillParseError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      result.errors.push({ name, error: message });
    }
  }

  return result;
}
