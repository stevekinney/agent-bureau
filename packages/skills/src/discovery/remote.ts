import { sha256BytesHex } from '@lostgradient/cryptography';

import {
  createSkillArtifact,
  SKILL_MANIFEST_FILENAME,
  type SkillAdmissionLimits,
  type SkillArtifact,
} from '../artifact';
import type { SkillSource } from './source';

/**
 * What a remote source must present before any of its content is admitted.
 *
 * At least one of these is required. A remote source with neither is refused rather than fetched
 * optimistically: content arriving over a network with nothing to check it against is exactly the
 * case where "load it and see" is how untrusted instructions reach a model.
 */
export interface RemoteSkillIntegrity {
  /**
   * SHA-256 hex digests of the raw `SKILL.md` bytes, by skill name.
   *
   * A match admits that skill on its own. A mismatch is always a refusal — that is tamper
   * evidence, not an absent policy.
   */
  readonly expectedDigests?: Readonly<Record<string, string>>;
  /**
   * SPKI PEM-encoded Ed25519 public key.
   *
   * A skill with no pinned digest must then carry a valid detached signature at
   * `{location}/{name}/SKILL.md.sig`.
   */
  readonly publicKey?: string;
}

/** A source served over the network. */
export interface RemoteSkillSource extends SkillSource {
  readonly kind: 'remote';
  /** The skills to fetch. A remote source is an explicit list, never a wildcard crawl. */
  readonly names: readonly string[];
  /** Required. Its absence is what makes a remote source inadmissible. */
  readonly integrity?: RemoteSkillIntegrity;
  /** Bearer token sent as `Authorization`. Never surfaced in a catalog entry. */
  readonly authToken?: string;
}

/** Why a remote skill could not be admitted. */
export type RemoteAdmissionCode =
  | 'integrity-policy-missing'
  | 'cancelled'
  | 'unreachable'
  | 'digest-mismatch'
  | 'signature-missing'
  | 'signature-invalid'
  | 'admission-failed';

/** One remote admission failure. */
export interface RemoteAdmissionDiagnostic {
  readonly code: RemoteAdmissionCode;
  readonly message: string;
  readonly name?: string;
}

/** The outcome of materializing one remote source. */
export interface RemoteMaterialization {
  readonly artifacts: readonly { readonly name: string; readonly artifact: SkillArtifact }[];
  readonly diagnostics: readonly RemoteAdmissionDiagnostic[];
  /**
   * True when the abort signal stopped this before every name was attempted.
   *
   * Reported rather than inferred from a short artifact list: a caller that cannot tell a
   * cancelled fetch from a completed one will commit the truncated result as though it were the
   * whole catalog.
   */
  readonly cancelled: boolean;
}

/** Verifies a detached Ed25519 signature. Injected so a test need not hold a real key pair. */
export type RemoteSignatureVerifier = (
  content: Uint8Array,
  signature: string,
  publicKey: string,
) => boolean;

/** Options for {@link materializeRemoteSource}. */
export interface MaterializeRemoteSourceOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly limits?: SkillAdmissionLimits;
  readonly signal?: AbortSignal;
  /** Defaults to Node's Ed25519 verification. */
  readonly verifySignature?: RemoteSignatureVerifier;
  /**
   * Milliseconds allowed per request. Default 10 seconds; `0` disables the bound.
   *
   * Per request rather than for the whole source, so one unresponsive skill cannot consume the
   * budget of every other skill behind it.
   */
  readonly requestTimeoutMilliseconds?: number;
}

/** True when a rejection is an abort rather than a transport failure. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Reads an abort signal through a function call.
 *
 * `AbortSignal.aborted` is declared `readonly boolean`, so TypeScript narrows it after the first
 * check and treats later reads in the same scope as comparisons that cannot change — wrong for a
 * flag whose entire purpose is to flip underneath a running loop.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * The signal each request runs under: the caller's, plus this module's own timeout.
 *
 * Combined rather than chosen between, so a caller that supplied no signal still gets a bound and
 * one that did keeps their ability to cancel.
 */
function signalOption(
  options: MaterializeRemoteSourceOptions,
): { signal: AbortSignal } | Record<string, never> {
  const timeout = options.requestTimeoutMilliseconds ?? 10_000;
  if (timeout <= 0) return options.signal === undefined ? {} : { signal: options.signal };
  const bound = AbortSignal.timeout(timeout);
  return {
    signal: options.signal === undefined ? bound : AbortSignal.any([options.signal, bound]),
  };
}

function hasIntegrityPolicy(integrity: RemoteSkillIntegrity | undefined): boolean {
  if (integrity === undefined) return false;
  const digests = integrity.expectedDigests;
  const hasDigests = digests !== undefined && Object.keys(digests).length > 0;
  return hasDigests || typeof integrity.publicKey === 'string';
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function defaultVerifier(content: Uint8Array, signature: string, publicKey: string): boolean {
  // `node:crypto` through `process.getBuiltinModule` rather than a literal require, matching the
  // cryptography package's reasoning: a literal require forces a bundler shim into every browser
  // consumer of this package even when this path is never reached.
  const runtime: unknown = Reflect.get(globalThis, 'process');
  if (typeof runtime !== 'object' || runtime === null || !('getBuiltinModule' in runtime)) {
    return false;
  }
  const loader = runtime.getBuiltinModule;
  if (typeof loader !== 'function') return false;
  const cryptoModule: unknown = Reflect.apply(loader, runtime, ['node:crypto']);
  if (typeof cryptoModule !== 'object' || cryptoModule === null || !('verify' in cryptoModule)) {
    return false;
  }
  const verify = cryptoModule.verify;
  if (typeof verify !== 'function') return false;

  try {
    // The `null` algorithm is required for Ed25519.
    // `Uint8Array` rather than `Buffer`: reaching for the Node global here would defeat the very
    // reasoning above, which exists to keep this module loadable without a Node shim.
    return Reflect.apply(verify, cryptoModule, [
      null,
      content,
      publicKey,
      base64ToBytes(signature),
    ]) as boolean;
  } catch {
    return false;
  }
}

async function admitOne(
  source: RemoteSkillSource,
  name: string,
  options: MaterializeRemoteSourceOptions,
): Promise<
  | { readonly ok: true; readonly artifact: SkillArtifact }
  | { readonly ok: false; readonly diagnostic: RemoteAdmissionDiagnostic }
> {
  const headers: Record<string, string> = {};
  if (source.authToken !== undefined) headers['Authorization'] = `Bearer ${source.authToken}`;

  let bytes: Uint8Array;
  try {
    const response = await options.fetch(`${source.location}/${name}/${SKILL_MANIFEST_FILENAME}`, {
      headers,
      ...signalOption(options),
    });
    if (!response.ok) {
      return {
        ok: false,
        diagnostic: {
          code: 'unreachable',
          message: `Registry returned ${response.status} for skill '${name}'.`,
          name,
        },
      };
    }
    // Bytes, then decode. `response.text()` strips a BOM and replaces invalid UTF-8, so digesting
    // its output would verify something other than what the registry actually served — while the
    // field is documented as covering the raw `SKILL.md` bytes.
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        diagnostic: { code: 'cancelled', message: `Skill '${name}' fetch was cancelled.`, name },
      };
    }
    return {
      ok: false,
      diagnostic: {
        code: 'unreachable',
        message: `Skill '${name}' could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
        name,
      },
    };
  }

  const pinned = source.integrity?.expectedDigests?.[name];
  if (pinned !== undefined) {
    const actual = await sha256BytesHex(bytes);
    if (actual !== pinned) {
      return {
        ok: false,
        diagnostic: {
          code: 'digest-mismatch',
          message: `Skill '${name}' does not match its pinned digest.`,
          name,
        },
      };
    }
    // A matching pin is sufficient on its own: no signature is fetched, so an unrelated signature
    // outage cannot reject content whose bytes are already proven.
  } else {
    const publicKey = source.integrity?.publicKey;
    if (publicKey === undefined) {
      return {
        ok: false,
        diagnostic: {
          code: 'signature-missing',
          message: `Skill '${name}' has no pinned digest and the source configures no public key.`,
          name,
        },
      };
    }

    let signature: string | undefined;
    try {
      const response = await options.fetch(
        `${source.location}/${name}/${SKILL_MANIFEST_FILENAME}.sig`,
        { headers, ...signalOption(options) },
      );
      // Anything other than a clean 200 fails closed. A 404 is not "unsigned, therefore fine" when
      // a public key is configured; it is a missing signature.
      signature = response.ok ? await response.text() : undefined;
    } catch (error) {
      // An abort is not the registry serving unsigned content. Swallowing it into
      // `signature-missing` told an operator their publisher had stopped signing, when in fact
      // they had cancelled the poll themselves.
      if (isAbortError(error)) {
        return {
          ok: false,
          diagnostic: {
            code: 'cancelled',
            message: `Skill '${name}' signature fetch was cancelled.`,
            name,
          },
        };
      }
      signature = undefined;
    }

    if (signature === undefined) {
      return {
        ok: false,
        diagnostic: {
          code: 'signature-missing',
          message: `Skill '${name}' has no retrievable detached signature.`,
          name,
        },
      };
    }

    const verifier = options.verifySignature ?? defaultVerifier;
    if (!verifier(bytes, signature.trim(), publicKey)) {
      return {
        ok: false,
        diagnostic: {
          code: 'signature-invalid',
          message: `Skill '${name}' has an invalid detached signature.`,
          name,
        },
      };
    }
  }

  const admission = await createSkillArtifact(
    name,
    [{ path: SKILL_MANIFEST_FILENAME, bytes }],
    options.limits === undefined ? undefined : { limits: options.limits },
  );

  if (!admission.admitted) {
    return {
      ok: false,
      diagnostic: {
        code: 'admission-failed',
        message: `Skill '${name}': ${admission.diagnostics.map((entry) => entry.message).join('; ')}`,
        name,
      },
    };
  }

  return { ok: true, artifact: admission.artifact };
}

/**
 * Fetches and verifies a remote source's skills.
 *
 * Integrity is checked **before** the content becomes an artifact, so unverified bytes never
 * reach admission at all. A source with no integrity policy is refused outright without a single
 * request being made — there would be nothing to check the answer against.
 *
 * Every artifact produced here carries only `SKILL.md`, which is why a remote source declares
 * `bundleSupport: 'manifest-only'`: this transport genuinely cannot deliver `references/` or
 * `assets/`, and a catalog entry claiming otherwise would promise resources no load can return.
 */
export async function materializeRemoteSource(
  source: RemoteSkillSource,
  options: MaterializeRemoteSourceOptions,
): Promise<RemoteMaterialization> {
  if (!hasIntegrityPolicy(source.integrity)) {
    return {
      artifacts: [],
      diagnostics: [
        {
          code: 'integrity-policy-missing',
          message: `Remote source '${source.id}' configures neither pinned digests nor a public key, so nothing it serves can be verified.`,
        },
      ],
      cancelled: false,
    };
  }

  const artifacts: { name: string; artifact: SkillArtifact }[] = [];
  const diagnostics: RemoteAdmissionDiagnostic[] = [];

  let cancelled = false;
  for (const name of source.names.toSorted()) {
    if (isAborted(options.signal)) {
      cancelled = true;
      break;
    }
    const result = await admitOne(source, name, options);
    if (result.ok) artifacts.push({ name, artifact: result.artifact });
    else diagnostics.push(result.diagnostic);
  }

  return { artifacts, diagnostics, cancelled: cancelled || isAborted(options.signal) };
}
