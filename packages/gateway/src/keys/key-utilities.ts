const KEY_PREFIX = 'ab_live_';
const KEY_ID_LENGTH = 8;

/**
 * Generates a new API key in `ab_live_<64 hex chars>` format (32 random bytes).
 */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${KEY_PREFIX}${hex}`;
}

/**
 * Hashes an API key using SHA-256, returning a hex-encoded digest.
 * The plaintext key should never be stored; only the hash is persisted.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifies a plaintext key against a stored hash using constant-time comparison.
 * Returns true if the key matches the hash.
 */
export async function verifyApiKey(plaintext: string, hash: string): Promise<boolean> {
  const candidateHash = await hashApiKey(plaintext);

  // Constant-time comparison: compare every byte regardless of early mismatch
  const a = new TextEncoder().encode(candidateHash);
  const b = new TextEncoder().encode(hash);

  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return diff === 0;
}

/**
 * Extracts the key ID from a plaintext API key. The ID is the first 8 hex
 * characters after the `ab_live_` prefix.
 */
export function extractKeyId(key: string): string {
  return key.slice(KEY_PREFIX.length, KEY_PREFIX.length + KEY_ID_LENGTH);
}
