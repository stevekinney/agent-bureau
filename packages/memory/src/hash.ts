/**
 * Re-exports the cross-platform SHA-256 hex digest from `@lostgradient/cryptography`.
 * Consumers within the memory package (`embedding-cache.ts`, `file-synchronizer.ts`)
 * continue importing from `./hash` with no changes required.
 */
export { sha256Hex } from '@lostgradient/cryptography';
