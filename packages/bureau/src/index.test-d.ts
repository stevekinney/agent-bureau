// Type-level tripwire (review finding, PRRT_kwDORvupsc6elgnL): the package
// barrel presents `AgentRunForName` and `BureauRunOptions` as exported named
// types in the public API, but `index.ts` used to omit both from its
// re-export lists — `AgentRunForName` from `./agent-catalog`, `BureauRunOptions`
// from `./types` — so a consumer naming either type had to reach past the
// barrel into an internal module path. `export type { X } from './module'`
// only fails to compile if `X` doesn't exist in `./module` at all — it does
// NOT fail if `X` exists but simply isn't re-exported from the barrel — so
// this file, which imports both ONLY from the barrel (`./index`), is the
// actual tripwire: it fails to compile if either re-export regresses.

import type { RunResult, SchedulerTaskLocation } from '@lostgradient/operative';

import type {
  AgentRunForName,
  AssembleReproductionArtifactOptions,
  Bureau,
  BureauFaultOperation,
  BureauFaultPlan,
  BureauFaultPlanEntry,
  BureauHarnessCapability,
  BureauIncompleteWork,
  BureauQuiescenceReport,
  BureauRunOptions,
  BureauStorageFixture,
  BureauTestHarness,
  BureauTestHarnessOptions,
  CreateLmdbStorageFixtureOptions,
  CreateMemoryStorageFixtureOptions,
  CreatePersistentStorageFixtureOptions,
  DurableEventHistoryFixture,
  DurableEventHistoryFixtureOptions,
  DurableEventHistoryFixtureRecord,
  DurableRunRegistration,
  ReproductionArtifact,
  ReproductionArtifactEnvironment,
} from './index';
import {
  assembleReproductionArtifact,
  assertBureauQuiescent,
  BureauFaultSelectorResolutionError,
  BureauHarnessUnsupportedError,
  createBureauTestHarness,
  createDurableEventHistoryFixture,
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
  DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE,
  locateWorkspaceRoot,
  selectAuditWriteFaultTarget,
  selectSchedulerTaskFaultTarget,
  selectWebhookDeliveryFaultTarget,
} from './index';

declare const runOptions: BureauRunOptions;
declare const runResult: AgentRunForName<Record<string, never>, never>;
void runOptions;
void runResult;
void assembleReproductionArtifact;
void assertBureauQuiescent;
void BureauFaultSelectorResolutionError;
void BureauHarnessUnsupportedError;
void createBureauTestHarness;
void createDurableEventHistoryFixture;
void createLmdbStorageFixture;
void createMemoryStorageFixture;
void createSqliteStorageFixture;
void DURABLE_EVENT_HISTORY_FIXTURE_SEQUENCE;
void locateWorkspaceRoot;
void selectAuditWriteFaultTarget;
void selectSchedulerTaskFaultTarget;
void selectWebhookDeliveryFaultTarget;

declare const artifactOptions: AssembleReproductionArtifactOptions;
declare const artifactEnvironment: ReproductionArtifactEnvironment;
declare const artifact: ReproductionArtifact;
declare const capability: BureauHarnessCapability;
declare const faultOperation: BureauFaultOperation;
declare const faultPlan: BureauFaultPlan;
declare const faultEntry: BureauFaultPlanEntry;
declare const incompleteWork: BureauIncompleteWork;
declare const quiescenceReport: BureauQuiescenceReport;
declare const storageFixture: BureauStorageFixture;
declare const harness: BureauTestHarness;
declare const harnessOptions: BureauTestHarnessOptions;
declare const persistentOptions: CreatePersistentStorageFixtureOptions;
declare const lmdbOptions: CreateLmdbStorageFixtureOptions;
declare const memoryOptions: CreateMemoryStorageFixtureOptions;
declare const historyFixture: DurableEventHistoryFixture;
declare const historyOptions: DurableEventHistoryFixtureOptions;
declare const historyRecord: DurableEventHistoryFixtureRecord;
declare const runRegistration: DurableRunRegistration;
void artifactOptions;
void artifactEnvironment;
void artifact;
void capability;
void faultOperation;
void faultPlan;
void faultEntry;
void incompleteWork;
void quiescenceReport;
void storageFixture;
void harness;
void harnessOptions;
void persistentOptions;
void lmdbOptions;
void memoryOptions;
void historyFixture;
void historyOptions;
void historyRecord;
void runRegistration;

// COR-636: the scheduler task locator surface returns operative's types
// unchanged, so each side is assignable to the other.
type LocateReturn = ReturnType<Bureau['locateSchedulerTask']>;
type AwaitReturn = ReturnType<Bureau['awaitSchedulerTask']>;
declare const locateFromBureau: LocateReturn;
declare const awaitFromBureau: AwaitReturn;
declare const locationFromOperative: SchedulerTaskLocation;
declare const awaitFromOperative: Promise<RunResult | null>;
export const locateToOperative: SchedulerTaskLocation = locateFromBureau;
export const locateFromOperative: LocateReturn = locationFromOperative;
export const awaitToOperative: Promise<RunResult | null> = awaitFromBureau;
export const awaitFromOperativeToBureau: AwaitReturn = awaitFromOperative;
