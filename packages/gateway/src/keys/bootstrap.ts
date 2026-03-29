import type { ApiKeyStore } from './types';

/**
 * Bootstraps an admin API key on first startup. If the key store already
 * contains at least one key, this is a no-op. The bootstrap key has no
 * scope restrictions (admin) and no expiry.
 *
 * The plaintext key is printed to stdout exactly once — this is the only
 * opportunity to capture it.
 */
export async function bootstrapApiKey(store: ApiKeyStore): Promise<void> {
  const existing = await store.list();
  if (existing.length > 0) return;

  const { plaintext } = await store.create({
    name: 'bootstrap-admin',
  });

  console.log(`[gateway] Bootstrap API key created: ${plaintext}`);
}
