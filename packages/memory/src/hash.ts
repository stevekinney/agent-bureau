/**
 * Re-exports the cross-platform SHA-256 hex digest from interoperability.
 * Consumers within the memory package (`embedding-cache.ts`, `file-synchronizer.ts`)
 * continue importing from `./hash` with no changes required.
 */
export { sha256Hex } from 'interoperability';
