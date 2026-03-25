import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteStorageAdapter } from '@/storage/adapters/sqlite-adapter.ts';

import { runStorageAdapterTests } from './adapter-test-suite.ts';

let tempDirectory: string;

runStorageAdapterTests(
  'SQLiteStorageAdapter',
  async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'vf-sqlite-test-'));
    return new SQLiteStorageAdapter({ filename: join(tempDirectory, 'test.db') });
  },
  async (adapter) => {
    await adapter.destroy();
    await rm(tempDirectory, { recursive: true, force: true });
  },
);
