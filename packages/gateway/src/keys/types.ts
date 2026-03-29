/** Persistent representation of an API key. The plaintext is never stored. */
export type ApiKey = {
  id: string;
  name: string;
  keyHash: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  active: boolean;
  lastUsedAt?: string;
};

/** Options for creating a new API key. */
export type CreateApiKeyOptions = {
  name: string;
  scopes?: string[];
  expiresAt?: string;
};

/** A managed store for API key lifecycle operations. */
export type ApiKeyStore = {
  /** Create a new API key. The plaintext is returned exactly once. */
  create(options: CreateApiKeyOptions): Promise<{ key: ApiKey; plaintext: string }>;
  /** Verify a plaintext token and return the matching key, or null if invalid/expired/revoked. */
  verify(token: string): Promise<ApiKey | null>;
  /** Revoke a key by ID, marking it inactive. */
  revoke(id: string): Promise<void>;
  /** List all keys. Returned keys omit the hash for safety. */
  list(): Promise<ApiKey[]>;
  /** Revoke an existing key and create a new one with the same name and scopes. */
  rotate(id: string): Promise<{ key: ApiKey; plaintext: string }>;
};
