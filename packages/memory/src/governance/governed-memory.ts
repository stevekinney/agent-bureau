import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';

import { createDeletionEngine } from './deletion';
import { settlePendingDerivations } from './derivation';
import { createGovernanceContext } from './governance-context';
import {
  createPolicyHistory,
  expireWorkingMemory,
  readDeletionReceipt,
  readEvents,
  sweepRetention,
} from './governed-administration';
import { deleteLocated, forget } from './governed-forgetting';
import type { CreateGovernedMemoryOptions, GovernedMemory } from './governed-memory-types';
import {
  exportRecords,
  getRecord,
  listRecords,
  recallForModel,
  searchRecords,
} from './governed-reads';
import {
  changeLegalHold,
  changeShare,
  promoteRecord,
  quarantineRecord,
  revokeRecord,
} from './governed-transitions';
import { admitWrite } from './governed-writes';

/**
 * Creates principal-aware, governed memory: the one surface Bureau, Agent,
 * child, tool, A2A, MCP, audit, and administrative projections use. Every
 * operation takes a {@link MemoryAuthority}, is decided by the shared resource
 * predicate, and is attributed in the durable governance ledger. The record
 * storage must belong to this instance alone and must support atomic
 * `deleteMany`; governance defaults fail closed.
 */
export function createGovernedMemory(options: CreateGovernedMemoryOptions): GovernedMemory {
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const policies = createPolicyHistory(() => context, options.policy);
  const context = createGovernanceContext({
    storage: options.storage,
    ledger: options.ledger,
    embedder: options.embedder,
    textSearchProvider: options.textSearchProvider,
    runtime,
    propagation: options.propagation ?? {},
    policy: () => policies.current(),
    onEvent: options.onEvent,
  });
  const governance = context;
  const deletion = createDeletionEngine(governance);

  return {
    get policyRevision() {
      return policies.current().revision;
    },
    async init() {
      await options.storage.init();
      await options.textSearchProvider?.init();
    },
    async close() {
      await options.storage.close();
      await options.textSearchProvider?.close();
    },
    write: (authority, content, writeOptions) =>
      admitWrite(governance, authority, content, writeOptions),
    get: (authority, locator) => getRecord(governance, authority, locator),
    list: (authority, listOptions) => listRecords(governance, authority, listOptions),
    search: (authority, query, searchOptions) =>
      searchRecords(governance, authority, query, searchOptions),
    recallForModel: (authority, query, recallOptions) =>
      recallForModel(governance, authority, query, recallOptions),
    promote: (authority, locator, promoteOptions) =>
      promoteRecord(governance, authority, locator, promoteOptions),
    share: (authority, locator, grantee) =>
      changeShare(governance, authority, locator, grantee, true),
    revokeShare: (authority, locator, grantee) =>
      changeShare(governance, authority, locator, grantee, false),
    export: (authority, exportOptions) => exportRecords(governance, authority, exportOptions),
    quarantine: (authority, locator, reason) =>
      quarantineRecord(governance, authority, locator, reason),
    revoke: (authority, locator, reason) => revokeRecord(governance, authority, locator, reason),
    delete: (authority, locator) => deleteLocated(governance, deletion, authority, locator),
    forget: (authority, request) => forget(governance, deletion, authority, request),
    placeLegalHold: (authority, locator) =>
      changeLegalHold(governance, deletion, authority, locator, true),
    releaseLegalHold: (authority, locator) =>
      changeLegalHold(governance, deletion, authority, locator, false),
    expireWorkingMemory: (authority, runId) =>
      expireWorkingMemory(governance, deletion, authority, runId),
    sweepRetention: (authority, sweepOptions) =>
      sweepRetention(governance, deletion, authority, sweepOptions),
    activatePolicy: (authority, policy) => policies.activate(authority, policy),
    rollbackPolicy: (authority) => policies.rollback(authority),
    async processDeletionPropagation() {
      await settlePendingDerivations(governance);
      return deletion.processOpen();
    },
    getDeletionReceipt: (authority, deletionId) =>
      readDeletionReceipt(governance, authority, deletionId),
    listEvents: (authority, filter) => readEvents(governance, authority, filter ?? {}),
  };
}
