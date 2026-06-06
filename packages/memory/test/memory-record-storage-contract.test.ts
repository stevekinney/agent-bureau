import { MemoryStorage } from '@lostgradient/weft/storage';

import { createWeftMemoryRecordStorage } from '../src/create-weft-memory-record-storage';
import { createInMemoryMemoryRecordStorage } from '../src/test/index';
import { runMemoryRecordStorageContract } from './contract-harness';

/**
 * Runs the single shared {@link runMemoryRecordStorageContract} suite against
 * the two local backends — the in-memory test helper and the Weft-backed local
 * backend — so both clear byte-identical assertions. Backend-specific concerns
 * (key-prefix isolation, physical-removal proof, shared-storage disposal) live
 * in `create-weft-memory-record-storage.test.ts`, not here.
 */

runMemoryRecordStorageContract({
  label: 'in-memory',
  makeBackend: () => createInMemoryMemoryRecordStorage(),
});

runMemoryRecordStorageContract({
  label: 'weft',
  makeBackend: () => createWeftMemoryRecordStorage(new MemoryStorage()),
});
