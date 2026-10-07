/**
 * COR-772 — Bureau's durable parent-child topology.
 *
 * `bureau.children` dispatches a catalog agent as the child of a run Bureau
 * already knows, records the relationship durably before the child starts,
 * and keeps that record truthful for the rest of the child's life: every
 * transition is a compare-and-swap write (`child-topology-store.ts`), and
 * every started, completed, failed, aborted, and reattached transition is
 * written to Bureau's audit trail.
 *
 * ## Addressing and authorization
 *
 * Every operation names both the parent and the child. A child is only
 * visible through the parent that owns it: naming an unrelated parent reads
 * as `not-found` — the same not-found-shaped denial `eventHistory` and the
 * session verbs use, so a caller cannot tell "wrong id" from "not yours".
 *
 * A child's record carries the parent run's principal or, when the parent
 * has none, the principal that dispatched it. `dispatch` compares the
 * caller's principal with the parent's; `list`, `get`, `wait`, `signal`,
 * and `cancel` compare it with the child record's, so under a parent
 * without a principal a child one principal dispatched reads as
 * `not-found` to another. A comparison passes when either side has no
 * principal: omitting it is a trusted, internal call.
 *
 * A child's identifier is its durable run identifier too, so dispatch
 * refuses one that already names any other run or workflow Bureau knows
 * (`child-run-id-conflict`) before it reserves, records, or starts
 * anything — a caller cannot take over another run's attribution, recovery
 * record, or place in the topology by naming it.
 *
 * ## Parent cancellation
 *
 * A child never receives its parent's abort signal. When a parent is
 * cancelled — `abortRun`, `cancelDurableRun`, `children.cancel` on a child
 * that is itself a parent, a durable `bureau.run` parent settling aborted
 * through its own handle, or recovery finding the parent cancelled or gone —
 * Bureau applies each running child's recorded `parentCancellation` policy
 * explicitly: `'cascade'` cancels the child (and so on down), `'detach'`
 * leaves it running and still addressable through the parent's identifier.
 *
 * From the moment its cancellation is requested, a parent admits no new
 * child (`parent-terminal`), even while its own run is still winding down,
 * and a dispatch already under way lands its record before the policy lists
 * the parent's children — so no child escapes a cascade that recovery would
 * apply to it. A `children.cancel` that fails, or finds the child already
 * finished, cancels nothing below it. A cascade the engine cannot perform is
 * diagnosed and leaves that child's subtree running; the policy runs again
 * when the parent settles, and retries it.
 *
 * ## Signals
 *
 * When `BureauOptions.children.signals` registers a COR-814 signal contract
 * for the child's agent, each dispatch opens one typed channel for that
 * parent-child pair and hands the child its port. Channels are in-memory by
 * design; a restarted process reopens one for every recovered child before
 * the child's workflow resumes, so the parent can signal it again by its
 * stable identifier.
 *
 * ## Recovery
 *
 * `prepareRecovery()` runs before Weft resumes workflows and loads every
 * non-terminal record. `reconcileRecovery()` runs after, and for each one
 * (parents before their children) never starts a workflow — it reads the
 * existing one: a missing workflow or a process-local child is recorded as
 * failed, a workflow that finished while nobody was watching (a child that
 * completed while its parent was unavailable) is recorded with its real
 * outcome, and a still-running workflow is re-authorized and reattached.
 *
 * ## Delegation grants (COR-336)
 *
 * With `BureauOptions.children.delegation` configured, each dispatch issues
 * a signed `DelegationGrant`, attenuated from the parent's own grant when
 * the parent is itself a child, and reserves budget against the parent's
 * grant in a durable ledger. Recovery re-verifies a recovered child's grant
 * (signature, expiry, revocation) and reconciles its budget counters from
 * that ledger before reattaching the child; a child whose parent cannot be
 * recovered has its grant revoked on recovery and is cancelled. An invalid
 * grant is a hard deny — there is no fallback authority to run under.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type AgentInput,
  type AgentRun,
  type AgentRunContext,
  attenuateDelegatedAuthority,
  attenuateDelegationBudget,
  attenuateDelegationCapabilities,
  type ChildSignalChannel,
  type ChildSignalContract,
  type ChildSignalRejectionCode,
  createChildSignalChannel,
  type DelegatedAuthority,
  DELEGATION_GRANT_VERSION,
  type DelegationBudget,
  type DelegationCapabilities,
  type DelegationDisclosurePolicy,
  type DelegationGrant,
  digestDelegationArtifact,
  isDelegationGrant,
  revokeDelegationGrant,
  signDelegationGrant,
  type UnsignedDelegationGrant,
  verifyDelegationGrant,
} from '@lostgradient/operative';
import type { WorkflowState } from '@lostgradient/weft';

import type {
  BureauChildOutcome,
  BureauChildParentCancellation,
  BureauChildRecord,
  BureauChildTerminalStatus,
  ChildTopologyStore,
} from './child-topology-store';
import { principalAllows } from './principal-allows';
import { reservedWorkflowIdentifierReason } from './reserved-identifiers';
import type { CancelDurableRunOutcome, DiagnosticSink } from './types';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Names one child through the parent that owns it. */
export interface BureauChildReference {
  readonly parentRunId: string;
  readonly childRunId: string;
  /**
   * The caller's principal. When both this and the child record's
   * principal are present they must match; omitting it is a trusted,
   * internal call, matching `eventHistory`'s rule. The record's principal
   * is the parent's, or the dispatching principal when the parent had none.
   */
  readonly principal?: string | undefined;
}

/** What a dispatch asks its child's delegation grant to carry. Every field narrows. */
export interface BureauChildAuthorityRequest {
  readonly capabilities?: DelegationCapabilities | undefined;
  readonly budget?: DelegationBudget | undefined;
  /** Remaining nesting depth below the child. Defaults to `0` for a top-level parent. */
  readonly depth?: number | undefined;
  readonly delegatedAuthority?: DelegatedAuthority | undefined;
  /** Defaults to `BureauChildDelegationOptions.defaultTimeToLiveMilliseconds`. */
  readonly timeToLiveMilliseconds?: number | undefined;
  /** Defaults to `'redacted'`. */
  readonly disclosurePolicy?: DelegationDisclosurePolicy | undefined;
}

export interface BureauChildDispatchRequest<TName extends string = string> {
  readonly parentRunId: string;
  readonly agentName: TName;
  readonly input: AgentInput;
  /**
   * The child's stable identifier. Supplying one makes dispatch idempotent:
   * a second dispatch with the same identifier returns `duplicate` and never
   * starts a second workflow. One that already names another run Bureau
   * knows is rejected as `child-run-id-conflict`. Generated when omitted.
   */
  readonly childRunId?: string | undefined;
  /**
   * The caller's principal. When both this and the parent's principal are
   * present they must match. The child records the parent's principal, or
   * this one when the parent has none.
   */
  readonly principal?: string | undefined;
  /** Defaults to `'cascade'`. */
  readonly parentCancellation?: BureauChildParentCancellation | undefined;
  /** Ignored unless `BureauOptions.children.delegation` is configured. */
  readonly authority?: BureauChildAuthorityRequest | undefined;
}

/** The grant a dispatch issued, as far as its disclosure policy allows. */
export interface BureauChildGrantSummary {
  readonly grantId: string;
  readonly policyVersion: string;
  readonly depth: number;
  readonly expiresAt: number;
  readonly artifactDigest?: string | undefined;
  /** Present only under a `'full'` disclosure policy. */
  readonly budget?: DelegationBudget | undefined;
}

export type BureauChildDispatchRejection =
  | 'unknown-agent'
  | 'parent-terminal'
  | 'child-run-id-conflict'
  /** The id begins with a prefix durable goals own; see `reserved-identifiers.ts`. */
  | 'reserved-child-run-id'
  | 'delegation-invalid'
  | 'depth-exhausted'
  | 'authority-exceeded'
  | 'budget-exhausted'
  | 'start-failed';

export type BureauChildDispatchOutcome =
  | {
      readonly outcome: 'started';
      readonly child: BureauChildRecord;
      readonly grant?: BureauChildGrantSummary | undefined;
    }
  | { readonly outcome: 'duplicate'; readonly child: BureauChildRecord }
  | { readonly outcome: 'not-found' }
  | {
      readonly outcome: 'rejected';
      readonly code: BureauChildDispatchRejection;
      readonly reason: string;
    };

export type BureauChildWaitOutcome =
  | { readonly outcome: 'settled'; readonly child: BureauChildRecord }
  | { readonly outcome: 'not-found' }
  /** Still running, but nothing in this process is observing it. */
  | { readonly outcome: 'unobservable'; readonly child: BureauChildRecord }
  | { readonly outcome: 'wait-aborted'; readonly child: BureauChildRecord };

export interface BureauChildSignalRequest extends BureauChildReference {
  readonly name: string;
  readonly payload?: unknown;
}

export type BureauChildSignalOutcome =
  | { readonly outcome: 'acknowledged'; readonly signalId: string; readonly sequence: number }
  | {
      readonly outcome: 'rejected';
      readonly code: ChildSignalRejectionCode;
      readonly reason: string;
      readonly delivered: boolean;
    }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'child-terminal'; readonly child: BureauChildRecord }
  | { readonly outcome: 'unsupported'; readonly reason: 'no-signal-contract' | 'child-not-live' };

export interface BureauChildCancelRequest extends BureauChildReference {
  readonly reason?: string | undefined;
}

export type BureauChildCancelOutcome =
  | { readonly outcome: 'requested'; readonly child: BureauChildRecord }
  | { readonly outcome: 'already-terminal'; readonly child: BureauChildRecord }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'failed'; readonly child: BureauChildRecord; readonly reason: string };

/**
 * `bureau.children` — typed operations over children owned by a run Bureau
 * knows. See this module's doc comment for the full contract.
 */
export interface BureauChildren<TName extends string = string> {
  dispatch(request: BureauChildDispatchRequest<TName>): Promise<BureauChildDispatchOutcome>;
  list(
    parentRunId: string,
    options?: { readonly principal?: string | undefined },
  ): Promise<readonly BureauChildRecord[]>;
  get(reference: BureauChildReference): Promise<BureauChildRecord | undefined>;
  wait(
    reference: BureauChildReference,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<BureauChildWaitOutcome>;
  signal(request: BureauChildSignalRequest): Promise<BureauChildSignalOutcome>;
  cancel(request: BureauChildCancelRequest): Promise<BureauChildCancelOutcome>;
}

/** `BureauOptions.children.delegation`. */
export interface BureauChildDelegationOptions {
  /** The HMAC secret every grant is signed and verified with. */
  readonly secret: string;
  /** Stamped on every grant. Defaults to `'bureau-delegation/1'`. */
  readonly policyVersion?: string | undefined;
  /** Defaults to one hour. */
  readonly defaultTimeToLiveMilliseconds?: number | undefined;
}

// ---------------------------------------------------------------------------
// Dependencies (supplied by `createBureau`)
// ---------------------------------------------------------------------------

/** The slice of the durable engine topology recovery reads. */
export interface ChildTopologyEngine {
  get(workflowId: string): Promise<WorkflowState | null>;
  getHandle(workflowId: string): { result(): Promise<unknown> };
}

/** What Bureau knows about a run that wants to own a child. */
export interface ChildTopologyParent {
  readonly agentName: string;
  readonly principal?: string | undefined;
  readonly live: boolean;
}

export interface ChildTopologyStart {
  readonly agentName: string;
  readonly input: AgentInput;
  readonly childRunId: string;
  readonly principal?: string | undefined;
  readonly context: Pick<AgentRunContext, 'parentSignals' | 'childCorrelation'>;
}

export interface ChildAuditEntry {
  readonly runId: string;
  readonly type: string;
  readonly detail: unknown;
  readonly principal?: string | undefined;
  readonly dedupeKey?: string | undefined;
}

export interface ChildTopologyDependencies {
  readonly store: ChildTopologyStore;
  readonly runtime: Pick<RuntimeServices, 'clock' | 'identifiers'>;
  readonly diagnose: DiagnosticSink;
  readonly recordAudit: (entry: ChildAuditEntry) => Promise<void>;
  readonly resolveParent: (parentRunId: string) => Promise<ChildTopologyParent | undefined>;
  /**
   * Whether `runId` already names a run or workflow Bureau knows, other than
   * through a child record — a child may not take that identifier.
   */
  readonly isKnownRun: (runId: string) => Promise<boolean>;
  /** `undefined` when the catalog has no agent by this name. */
  readonly planChild: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  readonly startChild: (start: ChildTopologyStart) => AgentRun<unknown, boolean>;
  readonly getEngine: () => ChildTopologyEngine | undefined;
  readonly cancelDurable: (workflowId: string) => Promise<CancelDurableRunOutcome>;
  readonly validateInput: (input: unknown) => void;
  readonly createBadRequest: (message: string) => Error;
  readonly signalContracts?: Readonly<Record<string, ChildSignalContract>> | undefined;
  readonly delegation?: BureauChildDelegationOptions | undefined;
}

/** Bureau's internal handle on the topology; `children` is the public surface. */
export interface ChildTopology {
  readonly children: BureauChildren;
  /**
   * Closes the parent to new children and applies the `parentCancellation`
   * policy of every running child not already asked to stop. Safe to call
   * again — when the parent settles, say — to retry a cascade that failed.
   * Never rejects; `drain()` waits for it.
   */
  parentCancelled(parentRunId: string, reason: string): Promise<void>;
  /** Loads non-terminal records and reopens their signal channels. Call before Weft recovery. */
  prepareRecovery(): Promise<void>;
  /** The context a recovered child's re-resolved run options must carry. */
  recoveredRunContext(
    runId: string,
  ): Pick<AgentRunContext, 'parentSignals' | 'childCorrelation'> | undefined;
  /** Settles, re-authorizes, or reattaches every record `prepareRecovery` loaded. */
  reconcileRecovery(): Promise<void>;
  /** Resolves once every in-flight settlement write has landed. */
  drain(): Promise<void>;
  /**
   * Resolves once every child result already being awaited has been written.
   * Unlike `drain()` it waits on the children's own results, so a child that
   * ignores its abort never settles it: callers must bound the wait.
   */
  settlementsKnown(): Promise<void>;
  /** How many child results are still being awaited, so a caller can skip a bounded wait. */
  awaitingSettlements(): number;
}

// ---------------------------------------------------------------------------
// Constants and pure helpers
// ---------------------------------------------------------------------------

export const CHILD_AGENT_RUN_WORKFLOW_TYPE = 'agentRun';
const DEFAULT_POLICY_VERSION = 'bureau-delegation/1';
const DEFAULT_TIME_TO_LIVE_MILLISECONDS = 60 * 60 * 1000;
const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);
const PARENT_CANCELLATIONS: readonly string[] = ['cascade', 'detach'];
const LIST_CAPABILITIES = ['tools', 'pathPatterns', 'secrets'] as const;
const SWITCH_CAPABILITIES = ['network', 'admin'] as const;

type ParentRecoveryState = 'live' | 'finished' | 'cancelled' | 'unrecoverable';

interface Settlement {
  readonly status: BureauChildTerminalStatus;
  readonly outcome: BureauChildOutcome;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusForFinishReason(finishReason: string): BureauChildTerminalStatus {
  if (finishReason === 'aborted') return 'aborted';
  return finishReason === 'stop-condition' ? 'completed' : 'failed';
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An `agentRun` workflow's result (`AgentRunWorkflowResult`), read defensively. */
function settlementFromWorkflowResult(result: unknown): Settlement | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const candidate = result as Record<string, unknown>;
  const finishReason = candidate['finishReason'];
  if (typeof finishReason !== 'string') return undefined;
  return {
    status: statusForFinishReason(finishReason),
    outcome: withoutUndefined({
      finishReason,
      content: optionalString(candidate['content']),
      reason: optionalString(candidate['errorMessage']) ?? optionalString(candidate['abortReason']),
    }),
  };
}

function settlementFromWorkflowState(state: WorkflowState): Settlement {
  if (state.status === 'completed') {
    return settlementFromWorkflowResult(state.result) ?? { status: 'completed', outcome: {} };
  }
  if (state.status === 'cancelled') {
    return { status: 'aborted', outcome: { reason: 'workflow cancelled' } };
  }
  return { status: 'failed', outcome: { reason: state.error ?? `workflow ${state.status}` } };
}

function settlementFromRunResult(
  result: { finishReason: string; content: string; error?: unknown },
  cancelReason: string | undefined,
): Settlement {
  const status = statusForFinishReason(result.finishReason);
  const reason =
    result.error === undefined
      ? status === 'aborted'
        ? cancelReason
        : undefined
      : describeError(result.error);
  return {
    status,
    outcome: withoutUndefined({
      finishReason: result.finishReason,
      content: result.content,
      reason,
    }),
  };
}

function exceedsSwitch(
  allowed: readonly string[] | boolean | undefined,
  asked: readonly string[] | boolean | undefined,
): boolean {
  if (asked === undefined || asked === false || allowed === undefined || allowed === true) {
    return false;
  }
  if (allowed === false || asked === true) return true;
  return asked.some((item) => !allowed.includes(item));
}

/**
 * The first dimension in which `authority` asks for more than `parent`
 * grants, or `undefined`. COR-336: a child asking outside its authority is
 * rejected, never silently clamped. Absent dimensions inherit instead.
 */
function findAuthorityExcess(
  parent: DelegationGrant,
  authority: BureauChildAuthorityRequest | undefined,
): string | undefined {
  if (authority?.depth !== undefined && authority.depth > parent.depth - 1) return 'depth';
  for (const [dimension, asked] of Object.entries(authority?.budget ?? {})) {
    const ceiling = parent.budget[dimension as keyof DelegationBudget];
    if (typeof asked === 'number' && ceiling !== undefined && asked > ceiling) {
      return `budget.${dimension}`;
    }
  }
  const asked = authority?.capabilities ?? {};
  const allowed = parent.effectiveCapabilities;
  for (const dimension of LIST_CAPABILITIES) {
    const list = allowed[dimension];
    if (list !== undefined && asked[dimension]?.some((item) => !list.includes(item))) {
      return `capabilities.${dimension}`;
    }
  }
  for (const dimension of SWITCH_CAPABILITIES) {
    if (exceedsSwitch(allowed[dimension], asked[dimension])) return `capabilities.${dimension}`;
  }
  return undefined;
}

function grantSummary(grant: DelegationGrant): BureauChildGrantSummary {
  return withoutUndefined({
    grantId: grant.id,
    policyVersion: grant.policyVersion,
    depth: grant.depth,
    expiresAt: grant.expiresAt,
    artifactDigest: grant.artifactDigest,
    budget: grant.disclosurePolicy === 'full' ? grant.budget : undefined,
  });
}

// ---------------------------------------------------------------------------
// The topology
// ---------------------------------------------------------------------------

interface TrackedChild {
  run?: AgentRun<unknown, boolean> | undefined;
  channel?: ChildSignalChannel | undefined;
  cancelReason?: string | undefined;
  readonly settlement: Promise<BureauChildRecord | undefined>;
  readonly resolve: (record: BureauChildRecord | undefined) => void;
}

interface BudgetCounters {
  /**
   * Dispatch attempts — by the child grant each issued — holding a
   * `concurrentChildren` reservation not yet released.
   */
  readonly active: Set<string>;
  /** Children ever reserved against `totalDescendants`. Never released. */
  readonly descendants: Set<string>;
}

type Authorization =
  | {
      readonly status: 'authorized';
      readonly grant: DelegationGrant;
      readonly chain: readonly DelegationGrant[];
    }
  | {
      readonly status: 'rejected';
      readonly code: BureauChildDispatchRejection;
      readonly reason: string;
    };

export function createChildTopology(dependencies: ChildTopologyDependencies): ChildTopology {
  const { store, runtime, diagnose } = dependencies;
  const contracts = dependencies.signalContracts ?? {};
  const delegation = dependencies.delegation;
  const policyVersion = delegation?.policyVersion ?? DEFAULT_POLICY_VERSION;
  const defaultTimeToLive =
    delegation?.defaultTimeToLiveMilliseconds ?? DEFAULT_TIME_TO_LIVE_MILLISECONDS;

  const tracked = new Map<string, TrackedChild>();
  const inFlight = new Set<Promise<unknown>>();
  const awaitingResult = new Set<Promise<unknown>>();
  const counters = new Map<string, Promise<BudgetCounters>>();
  /** Each child identifier's dispatch in flight in this process, and the parent it is under. */
  const dispatching = new Map<
    string,
    { readonly parentRunId: string; readonly attempt: Promise<unknown> }
  >();
  /** Parents whose cancellation has been requested: none admits another child. */
  const cancelledParents = new Set<string>();
  const pendingRecovery = new Map<string, BureauChildRecord>();

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  function trackInFlight(promise: Promise<unknown>): void {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  }

  function ensureTracked(childRunId: string): TrackedChild {
    const existing = tracked.get(childRunId);
    if (existing) return existing;
    let wake!: (record: BureauChildRecord | undefined) => void;
    const settlement = new Promise<BureauChildRecord | undefined>((resolve) => {
      wake = resolve;
    });
    const entry: TrackedChild = { settlement, resolve: wake };
    tracked.set(childRunId, entry);
    return entry;
  }

  function closeChannel(childRunId: string, status: BureauChildTerminalStatus): void {
    tracked.get(childRunId)?.channel?.close(status);
  }

  /**
   * Stops tracking a child and wakes every `wait()` on it. Called only once
   * the settlement's audit entry and ledger release have landed, so a
   * caller whose `wait()` resolves can read both back immediately.
   */
  function release(childRunId: string, record: BureauChildRecord | undefined): void {
    const entry = tracked.get(childRunId);
    if (!entry) return;
    entry.channel?.close(
      record === undefined || record.status === 'running' ? 'failed' : record.status,
    );
    tracked.delete(childRunId);
    entry.resolve(record);
  }

  function correlationOf(record: {
    parentAgentName: string;
    parentRunId: string;
    childAgentName: string;
    childRunId: string;
  }): NonNullable<AgentRunContext['childCorrelation']> {
    return {
      parentAgentName: record.parentAgentName,
      parentRunId: record.parentRunId,
      childAgentName: record.childAgentName,
      childRunId: record.childRunId,
    };
  }

  async function audit(
    type: string,
    record: BureauChildRecord,
    options: {
      readonly dedupeKey?: string;
      readonly principal?: string;
      readonly extra?: object;
    } = {},
  ): Promise<void> {
    try {
      await dependencies.recordAudit(
        withoutUndefined({
          runId: record.childRunId,
          type,
          detail: withoutUndefined({
            parentRunId: record.parentRunId,
            childRunId: record.childRunId,
            parentAgentName: record.parentAgentName,
            childAgentName: record.childAgentName,
            status: record.status,
            revision: record.revision,
            workflow: record.workflow,
            grantId: record.grantId,
            outcome: record.outcome,
            ...options.extra,
          }),
          principal: options.principal,
          dedupeKey: options.dedupeKey,
        }),
      );
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'child-topology',
        message: `[bureau] Could not record ${type} for child "${record.childRunId}" in the audit trail: ${describeError(error)}`,
        cause: error,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Budget ledger
  // -------------------------------------------------------------------------

  async function readCounters(grantId: string): Promise<BudgetCounters> {
    const entries = await store.listLedger(grantId);
    const active = new Set<string>();
    const released = new Set<string>();
    const descendants = new Set<string>();
    for (const entry of entries) {
      if (entry.dimension === 'totalDescendants') {
        if (entry.kind === 'reserve') descendants.add(entry.childRunId);
      } else if (entry.kind === 'reserve') {
        active.add(entry.childGrantId);
      } else {
        released.add(entry.childGrantId);
      }
    }
    for (const childGrantId of released) active.delete(childGrantId);
    return { active, descendants };
  }

  function loadCounters(grantId: string): Promise<BudgetCounters> {
    const cached = counters.get(grantId);
    if (cached) return cached;
    const loading = readCounters(grantId);
    counters.set(grantId, loading);
    // A failed read must not poison the cache for the life of the process.
    loading.catch(() => counters.delete(grantId));
    return loading;
  }

  /**
   * Reserves one `concurrentChildren` slot on the immediate parent's grant
   * and one `totalDescendants` slot on every grant in the chain. The check
   * and the in-memory increment run in one synchronous turn after the
   * counters load, which is what serializes concurrent sibling dispatches.
   * The `concurrentChildren` slot belongs to this attempt (`childGrantId`),
   * never to the child identifier, so only this attempt can release it.
   */
  async function reserve(
    childRunId: string,
    childGrantId: string,
    chain: readonly DelegationGrant[],
  ): Promise<string | undefined> {
    const [parentGrant] = chain;
    if (parentGrant === undefined) return undefined;
    const loaded = await Promise.all(chain.map((grant) => loadCounters(grant.id)));
    const parentCounters = loaded[0]!;
    const concurrentCeiling = parentGrant.budget.concurrentChildren;
    if (concurrentCeiling !== undefined && parentCounters.active.size >= concurrentCeiling) {
      return `grant ${parentGrant.id} has no concurrentChildren budget left`;
    }
    for (const [index, grant] of chain.entries()) {
      const ceiling = grant.budget.totalDescendants;
      if (ceiling !== undefined && loaded[index]!.descendants.size >= ceiling) {
        return `grant ${grant.id} has no totalDescendants budget left`;
      }
    }
    parentCounters.active.add(childGrantId);
    for (const entry of loaded) entry.descendants.add(childRunId);
    const at = runtime.clock.now();
    try {
      await store.appendLedgerEntry({
        grantId: parentGrant.id,
        childRunId,
        childGrantId,
        kind: 'reserve',
        dimension: 'concurrentChildren',
        amount: 1,
        at,
      });
      for (const grant of chain) {
        await store.appendLedgerEntry({
          grantId: grant.id,
          childRunId,
          childGrantId,
          kind: 'reserve',
          dimension: 'totalDescendants',
          amount: 1,
          at,
        });
      }
    } catch (error) {
      parentCounters.active.delete(childGrantId);
      for (const entry of loaded) entry.descendants.delete(childRunId);
      throw error;
    }
    return undefined;
  }

  /** Releases the `concurrentChildren` slot the attempt that wrote `record` reserved. */
  async function releaseReservation(record: BureauChildRecord): Promise<void> {
    const { parentGrantId, grantId } = record;
    if (parentGrantId === undefined || grantId === undefined) return;
    await store.appendLedgerEntry({
      grantId: parentGrantId,
      childRunId: record.childRunId,
      childGrantId: grantId,
      kind: 'release',
      dimension: 'concurrentChildren',
      amount: 1,
      at: runtime.clock.now(),
    });
    const cached = counters.get(parentGrantId);
    if (cached) {
      const loaded = await cached;
      loaded.active.delete(grantId);
    }
  }

  /**
   * Recovery-time reconciliation of one grant's live counters: releases
   * every reservation no running child holds — the crash landed between the
   * child settling and its release being written, or between an attempt
   * reserving and losing its registration race — then reloads the counters
   * from the repaired ledger.
   */
  async function reconcileLedger(grant: DelegationGrant): Promise<void> {
    const entries = await store.listLedger(grant.id);
    const released = new Set(
      entries
        .filter((entry) => entry.dimension === 'concurrentChildren' && entry.kind === 'release')
        .map((entry) => entry.childGrantId),
    );
    for (const entry of entries) {
      if (entry.dimension !== 'concurrentChildren' || entry.kind !== 'reserve') continue;
      if (released.has(entry.childGrantId) || dispatching.has(entry.childRunId)) continue;
      const child = await store.get(entry.childRunId);
      if (child?.status === 'running' && child.grantId === entry.childGrantId) continue;
      await store.appendLedgerEntry({ ...entry, kind: 'release', at: runtime.clock.now() });
    }
    counters.delete(grant.id);
    await loadCounters(grant.id);
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * The grants a dispatch under `parentRecord` must satisfy, nearest first:
   * the parent's own grant, then each ancestor's. Every one is re-verified —
   * revoking an ancestor denies its whole subtree.
   */
  async function loadGrantChain(
    parentRecord: BureauChildRecord | undefined,
    secret: string,
    now: number,
  ): Promise<{ chain: DelegationGrant[] } | { reason: string }> {
    const chain: DelegationGrant[] = [];
    const visited = new Set<string>();
    let record = parentRecord;
    while (record?.grantId !== undefined && !visited.has(record.childRunId)) {
      visited.add(record.childRunId);
      const load = await store.loadGrant(record.grantId);
      if (load.status !== 'found') return { reason: `grant ${record.grantId} is ${load.status}` };
      const verification = verifyDelegationGrant(load.grant, secret, now);
      if (!verification.valid) return { reason: verification.reason };
      chain.push(load.grant);
      record = await store.get(record.parentRunId);
    }
    return { chain };
  }

  function validateAuthority(authority: BureauChildAuthorityRequest | undefined): void {
    if (authority === undefined) return;
    const timeToLive = authority.timeToLiveMilliseconds;
    if (timeToLive !== undefined && !(Number.isFinite(timeToLive) && timeToLive > 0)) {
      throw dependencies.createBadRequest('authority.timeToLiveMilliseconds must be positive');
    }
    const probe = {
      version: DELEGATION_GRANT_VERSION,
      id: '',
      parentRunId: '',
      childRunId: '',
      agentName: '',
      agentVersion: '',
      objective: '',
      recipientId: '',
      policyVersion: '',
      signature: '',
      issuedAt: 0,
      expiresAt: 0,
      revoked: false,
      effectiveCapabilities: authority.capabilities ?? {},
      budget: authority.budget ?? {},
      depth: authority.depth ?? 0,
      delegatedAuthority: authority.delegatedAuthority ?? { policyVersion },
      disclosurePolicy: authority.disclosurePolicy ?? 'redacted',
    };
    if (!isDelegationGrant(probe)) {
      throw dependencies.createBadRequest('authority is not a valid delegation request');
    }
  }

  async function authorizeDispatch(
    request: BureauChildDispatchRequest,
    childRunId: string,
    agentVersion: string,
    parentRecord: BureauChildRecord | undefined,
    options: BureauChildDelegationOptions,
  ): Promise<Authorization> {
    const now = runtime.clock.now();
    const loaded = await loadGrantChain(parentRecord, options.secret, now);
    if ('reason' in loaded) {
      return { status: 'rejected', code: 'delegation-invalid', reason: loaded.reason };
    }
    const { chain } = loaded;
    const parentGrant = chain[0];
    const authority = request.authority;
    if (parentGrant) {
      if (parentGrant.depth === 0) {
        return {
          status: 'rejected',
          code: 'depth-exhausted',
          reason: `grant ${parentGrant.id} authorizes no further delegation`,
        };
      }
      const excess = findAuthorityExcess(parentGrant, authority);
      if (excess !== undefined) {
        return {
          status: 'rejected',
          code: 'authority-exceeded',
          reason: `requested ${excess} exceeds grant ${parentGrant.id}`,
        };
      }
    }
    const timeToLive = authority?.timeToLiveMilliseconds ?? defaultTimeToLive;
    const input = request.input;
    const unsigned: UnsignedDelegationGrant = {
      version: DELEGATION_GRANT_VERSION,
      id: `delegation:${runtime.identifiers.next('delegation')}`,
      parentRunId: request.parentRunId,
      childRunId,
      agentName: request.agentName,
      agentVersion,
      ...(typeof input === 'string'
        ? { objective: input }
        : { objective: 'conversation', artifactDigest: digestDelegationArtifact(input) }),
      recipientId: childRunId,
      effectiveCapabilities: attenuateDelegationCapabilities(
        parentGrant?.effectiveCapabilities,
        authority?.capabilities,
      ),
      delegatedAuthority:
        authority?.delegatedAuthority === undefined
          ? (parentGrant?.delegatedAuthority ?? { policyVersion })
          : attenuateDelegatedAuthority(
              parentGrant?.delegatedAuthority,
              authority.delegatedAuthority,
            ),
      budget: attenuateDelegationBudget(parentGrant?.budget, authority?.budget),
      depth:
        parentGrant === undefined
          ? (authority?.depth ?? 0)
          : Math.min(parentGrant.depth - 1, authority?.depth ?? parentGrant.depth - 1),
      policyVersion,
      issuedAt: now,
      expiresAt: Math.min(parentGrant?.expiresAt ?? Number.POSITIVE_INFINITY, now + timeToLive),
      revoked: false,
      disclosurePolicy: authority?.disclosurePolicy ?? 'redacted',
    };
    const exhausted = await reserve(childRunId, unsigned.id, chain);
    if (exhausted !== undefined) {
      return { status: 'rejected', code: 'budget-exhausted', reason: exhausted };
    }
    return { status: 'authorized', grant: signDelegationGrant(unsigned, options.secret), chain };
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /**
   * Moves a running record to a terminal status exactly once. A writer that
   * finds the record already terminal (a stale update) changes nothing and
   * records nothing.
   */
  async function settle(
    childRunId: string,
    status: BureauChildTerminalStatus,
    outcome: BureauChildOutcome,
  ): Promise<BureauChildRecord | undefined> {
    let current = await store.get(childRunId);
    while (current?.status === 'running') {
      const now = runtime.clock.now();
      const update = await store.update(current, {
        ...current,
        status,
        updatedAt: now,
        settledAt: now,
        outcome: withoutUndefined(outcome),
      });
      if (update.status === 'updated') {
        closeChannel(childRunId, status);
        await afterSettled(update.record);
        release(childRunId, update.record);
        return update.record;
      }
      current = update.current;
    }
    release(childRunId, current);
    return current;
  }

  async function afterSettled(record: BureauChildRecord): Promise<void> {
    await audit(`child.${record.status}`, record, {
      dedupeKey: `child.${record.status}:${record.childRunId}`,
    });
    try {
      await releaseReservation(record);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'child-topology',
        message: `[bureau] Could not release the budget reservation for child "${record.childRunId}": ${describeError(error)}`,
        cause: error,
      });
    }
    if (record.status === 'aborted') {
      await parentCancelled(record.childRunId, record.outcome?.reason ?? 'aborted');
    }
  }

  /**
   * Writes a settlement once it is known. Only the write is tracked for
   * `drain()`, never the wait for the run's result: a child that ignores
   * its abort must not be able to hold Bureau's shutdown open.
   */
  function settleWhenKnown(childRunId: string, known: Promise<Settlement>): void {
    const written = known.then(async ({ status, outcome }) => {
      const writing = writeSettlement(childRunId, status, outcome);
      trackInFlight(writing);
      return writing;
    });
    awaitingResult.add(written);
    void written.finally(() => awaitingResult.delete(written));
  }

  async function writeSettlement(
    childRunId: string,
    status: BureauChildTerminalStatus,
    outcome: BureauChildOutcome,
  ): Promise<BureauChildRecord | undefined> {
    try {
      return await settle(childRunId, status, outcome);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'child-topology',
        message: `[bureau] Could not record the terminal state of child "${childRunId}": ${describeError(error)}`,
        cause: error,
      });
      release(childRunId, undefined);
      return undefined;
    }
  }

  function monitorLive(childRunId: string, run: AgentRun<unknown, boolean>): void {
    settleWhenKnown(
      childRunId,
      (async (): Promise<Settlement> => {
        try {
          const result = await run.result();
          return settlementFromRunResult(result, tracked.get(childRunId)?.cancelReason);
        } catch (error) {
          return { status: 'failed', outcome: { reason: describeError(error) } };
        }
      })(),
    );
  }

  function monitorRecovered(
    record: BureauChildRecord,
    workflowId: string,
    engine: ChildTopologyEngine,
  ): void {
    settleWhenKnown(
      record.childRunId,
      (async (): Promise<Settlement> => {
        try {
          const result = await engine.getHandle(workflowId).result();
          return settlementFromWorkflowResult(result) ?? { status: 'completed', outcome: {} };
        } catch (error) {
          // The handle only says the workflow did not return a result; its
          // durable state says whether it was cancelled or failed.
          const state = await engine.get(workflowId).catch(() => null);
          if (state && TERMINAL_WORKFLOW_STATUSES.has(state.status)) {
            return settlementFromWorkflowState(state);
          }
          return { status: 'failed', outcome: { reason: describeError(error) } };
        }
      })(),
    );
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  async function cancelChild(
    record: BureauChildRecord,
    reason: string,
  ): Promise<BureauChildCancelOutcome> {
    const entry = tracked.get(record.childRunId);
    if (entry?.run) {
      entry.cancelReason = reason;
      entry.run.abort(reason);
      return { outcome: 'requested', child: record };
    }
    if (record.workflow.kind === 'process-local') {
      // Nothing in this process runs it, and a process-local child cannot
      // be running anywhere else.
      const settled = await settle(record.childRunId, 'aborted', { reason });
      return { outcome: 'requested', child: settled ?? record };
    }
    const outcome = await dependencies.cancelDurable(record.workflow.workflowId);
    if (outcome.status === 'requested') {
      const settled = await settle(record.childRunId, 'aborted', { reason });
      return { outcome: 'requested', child: settled ?? record };
    }
    if (outcome.status === 'already-terminal') {
      const state = await dependencies.getEngine()?.get(record.workflow.workflowId);
      const settlement = state
        ? settlementFromWorkflowState(state)
        : { status: 'failed' as const, outcome: { reason: 'workflow state unavailable' } };
      const settled = await settle(record.childRunId, settlement.status, settlement.outcome);
      return { outcome: 'already-terminal', child: settled ?? record };
    }
    if (outcome.status === 'not-found') {
      const settled = await settle(record.childRunId, 'failed', { reason: 'workflow missing' });
      return { outcome: 'already-terminal', child: settled ?? record };
    }
    return {
      outcome: 'failed',
      child: record,
      reason:
        outcome.status === 'failed'
          ? describeError(outcome.error)
          : 'no durable engine is available to cancel this child',
    };
  }

  /**
   * The parent-cancellation policy. The parent is closed to new children
   * synchronously, before anything here awaits, and every dispatch already
   * admitted under it is waited out, so the listing below sees every child
   * it will ever have in this process. Idempotent per child rather than per
   * parent: a child already asked to stop is skipped, and one whose
   * cancellation failed is left running (with its subtree) for the next
   * application — the one its parent's settlement makes — to retry.
   */
  async function parentCancelled(parentRunId: string, reason: string): Promise<void> {
    cancelledParents.add(parentRunId);
    try {
      const admitted = [...dispatching.values()].filter(
        (pending) => pending.parentRunId === parentRunId,
      );
      await Promise.allSettled(admitted.map((pending) => pending.attempt));
      const children = await store.listByParent(parentRunId);
      for (const child of children) {
        if (child.status !== 'running' || child.parentCancellation !== 'cascade') continue;
        // Already winding down from an earlier request, which cascaded its subtree.
        if (tracked.get(child.childRunId)?.cancelReason !== undefined) continue;
        const outcome = await cancelChild(child, `parent ${parentRunId} cancelled: ${reason}`);
        if (outcome.outcome === 'requested') {
          await parentCancelled(child.childRunId, reason);
        } else if (outcome.outcome === 'failed') {
          diagnose({
            level: 'error',
            scope: 'child-topology',
            message: `[bureau] Could not cancel child "${child.childRunId}" of cancelled parent "${parentRunId}"; it keeps running until the policy is applied again: ${outcome.reason}`,
          });
        }
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'child-topology',
        message: `[bureau] Could not apply the parent-cancellation policy for "${parentRunId}": ${describeError(error)}`,
        cause: error,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public operations
  // -------------------------------------------------------------------------

  function requireString(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw dependencies.createBadRequest(`${field} must be a non-empty string`);
    }
  }

  function validateReference(reference: BureauChildReference): void {
    requireString(reference.parentRunId, 'parentRunId');
    requireString(reference.childRunId, 'childRunId');
    if (reference.principal !== undefined) requireString(reference.principal, 'principal');
  }

  async function authorized(
    reference: BureauChildReference,
  ): Promise<BureauChildRecord | undefined> {
    validateReference(reference);
    const record = await store.get(reference.childRunId);
    if (!record || record.parentRunId !== reference.parentRunId) return undefined;
    return principalAllows(reference.principal, record.principal) ? record : undefined;
  }

  function validateDispatch(request: BureauChildDispatchRequest): void {
    requireString(request.parentRunId, 'parentRunId');
    requireString(request.agentName, 'agentName');
    if (request.childRunId !== undefined) requireString(request.childRunId, 'childRunId');
    if (request.principal !== undefined) requireString(request.principal, 'principal');
    if (
      request.parentCancellation !== undefined &&
      !PARENT_CANCELLATIONS.includes(request.parentCancellation)
    ) {
      throw dependencies.createBadRequest('parentCancellation must be "cascade" or "detach"');
    }
    dependencies.validateInput(request.input);
    if (delegation) validateAuthority(request.authority);
  }

  async function dispatch(
    request: BureauChildDispatchRequest,
  ): Promise<BureauChildDispatchOutcome> {
    validateDispatch(request);
    // A goal's ids are its own (see `reserved-identifiers.ts`): a child that
    // took one would be purged under the goal's audit trail or squat its run.
    const reserved =
      request.childRunId === undefined
        ? undefined
        : reservedWorkflowIdentifierReason('child run identifier', request.childRunId);
    if (reserved !== undefined) {
      return { outcome: 'rejected', code: 'reserved-child-run-id', reason: reserved };
    }
    const plan = dependencies.planChild(request.agentName);
    if (!plan) {
      return {
        outcome: 'rejected',
        code: 'unknown-agent',
        reason: `Unknown agent "${request.agentName}"`,
      };
    }
    const parent = await dependencies.resolveParent(request.parentRunId);
    if (!parent || !principalAllows(request.principal, parent.principal)) {
      return { outcome: 'not-found' };
    }
    if (!parent.live) {
      return parentTerminal(request.parentRunId, 'is no longer running');
    }
    const childRunId = request.childRunId ?? runtime.identifiers.next('child-run');
    // One dispatch per identifier at a time in this process: a concurrent
    // retry waits for the first, then finds its record and reads as a
    // duplicate instead of reserving budget against the first's slot.
    for (
      let pending = dispatching.get(childRunId);
      pending;
      pending = dispatching.get(childRunId)
    ) {
      await pending.attempt.catch(() => undefined);
    }
    // Checked in the same synchronous turn that records this attempt as in
    // flight: `parentCancelled` either sees the attempt and waits for its
    // record, or has already closed the parent and this attempt never starts.
    // The parent's own status can still read `running` while it winds down.
    if (cancelledParents.has(request.parentRunId)) {
      return parentTerminal(request.parentRunId, 'is being cancelled');
    }
    const attempt = dispatchChild(request, childRunId, plan, parent);
    dispatching.set(childRunId, { parentRunId: request.parentRunId, attempt });
    try {
      return await attempt;
    } finally {
      dispatching.delete(childRunId);
    }
  }

  function parentTerminal(parentRunId: string, why: string): BureauChildDispatchOutcome {
    return { outcome: 'rejected', code: 'parent-terminal', reason: `Run "${parentRunId}" ${why}` };
  }

  function identifierConflict(childRunId: string): BureauChildDispatchOutcome {
    return {
      outcome: 'rejected',
      code: 'child-run-id-conflict',
      reason: `Child run identifier "${childRunId}" is already in use`,
    };
  }

  function duplicateOutcome(
    existing: BureauChildRecord,
    request: BureauChildDispatchRequest,
  ): BureauChildDispatchOutcome {
    return existing.parentRunId === request.parentRunId
      ? { outcome: 'duplicate', child: existing }
      : identifierConflict(existing.childRunId);
  }

  async function dispatchChild(
    request: BureauChildDispatchRequest,
    childRunId: string,
    plan: { readonly durable: boolean; readonly agentVersion: string },
    parent: ChildTopologyParent,
  ): Promise<BureauChildDispatchOutcome> {
    const existing = await store.get(childRunId);
    if (existing) return duplicateOutcome(existing, request);
    if (await dependencies.isKnownRun(childRunId)) {
      // Either another run holds this identifier, or another process
      // registered and started this very child since the read above.
      const raced = await store.get(childRunId);
      return raced ? duplicateOutcome(raced, request) : identifierConflict(childRunId);
    }

    let grant: DelegationGrant | undefined;
    let parentGrantId: string | undefined;
    const parentRecord = await store.get(request.parentRunId);
    if (!delegation) {
      // Fail closed: a parent that holds a grant can only delegate under a
      // grant, and without the secret nothing here can verify or issue one.
      if (parentRecord?.grantId !== undefined) {
        return {
          outcome: 'rejected',
          code: 'delegation-invalid',
          reason: `grant ${parentRecord.grantId} cannot be verified without a delegation secret`,
        };
      }
    } else {
      const authorization = await authorizeDispatch(
        request,
        childRunId,
        plan.agentVersion,
        parentRecord,
        delegation,
      );
      if (authorization.status === 'rejected') {
        return { outcome: 'rejected', code: authorization.code, reason: authorization.reason };
      }
      grant = authorization.grant;
      parentGrantId = authorization.chain[0]?.id;
      await store.issueGrant(grant);
    }

    const now = runtime.clock.now();
    const record: BureauChildRecord = withoutUndefined({
      schemaVersion: 1 as const,
      parentRunId: request.parentRunId,
      childRunId,
      parentAgentName: parent.agentName,
      childAgentName: request.agentName,
      status: 'running' as const,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      recoveries: 0,
      workflow: plan.durable
        ? {
            kind: 'durable' as const,
            workflowType: CHILD_AGENT_RUN_WORKFLOW_TYPE,
            workflowId: childRunId,
          }
        : { kind: 'process-local' as const },
      parentCancellation: request.parentCancellation ?? 'cascade',
      principal: parent.principal ?? request.principal,
      grantId: grant?.id,
      parentGrantId,
    });

    const registration = await store.register(record);
    if (registration.status === 'duplicate') {
      // Lost a registration race (to another process) after the reservation
      // was made; give this attempt's slot back rather than leave it held by
      // a child that never started. The winner's reservation is its own.
      await releaseReservation(record);
      return registration.existing === undefined
        ? identifierConflict(childRunId)
        : duplicateOutcome(registration.existing, request);
    }
    await audit('child.started', record, {
      dedupeKey: `child.started:${childRunId}`,
      ...(record.principal === undefined ? {} : { principal: record.principal }),
    });

    const entry = ensureTracked(childRunId);
    const contract = contracts[request.agentName];
    if (contract) {
      entry.channel = createChildSignalChannel(contract, {
        parentRunId: request.parentRunId,
        childRunId,
      });
    }
    try {
      entry.run = dependencies.startChild({
        agentName: request.agentName,
        input: request.input,
        childRunId,
        ...(record.principal === undefined ? {} : { principal: record.principal }),
        context: {
          childCorrelation: correlationOf(record),
          ...(entry.channel === undefined ? {} : { parentSignals: entry.channel.child }),
        },
      });
    } catch (error) {
      const reason = describeError(error);
      await settle(childRunId, 'failed', { reason });
      return { outcome: 'rejected', code: 'start-failed', reason };
    }
    monitorLive(childRunId, entry.run);
    return grant === undefined
      ? { outcome: 'started', child: record }
      : { outcome: 'started', child: record, grant: grantSummary(grant) };
  }

  async function list(
    parentRunId: string,
    options?: { readonly principal?: string | undefined },
  ): Promise<readonly BureauChildRecord[]> {
    requireString(parentRunId, 'parentRunId');
    const records = await store.listByParent(parentRunId);
    return records.filter((record) => principalAllows(options?.principal, record.principal));
  }

  async function wait(
    reference: BureauChildReference,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<BureauChildWaitOutcome> {
    const record = await authorized(reference);
    if (!record) return { outcome: 'not-found' };
    if (record.status !== 'running') return { outcome: 'settled', child: record };
    const entry = tracked.get(record.childRunId);
    if (!entry) return { outcome: 'unobservable', child: record };
    const abortSignal = options?.signal;
    const aborted = Symbol('aborted');
    const settled = await new Promise<BureauChildRecord | undefined | typeof aborted>((resolve) => {
      if (abortSignal?.aborted) {
        resolve(aborted);
        return;
      }
      const onAbort = (): void => resolve(aborted);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      void entry.settlement.then((value) => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve(value);
        return value;
      });
    });
    const current =
      settled === aborted || settled === undefined ? await store.get(record.childRunId) : settled;
    const child = current ?? record;
    if (settled === aborted) return { outcome: 'wait-aborted', child };
    return child.status === 'running'
      ? { outcome: 'unobservable', child }
      : { outcome: 'settled', child };
  }

  async function signal(request: BureauChildSignalRequest): Promise<BureauChildSignalOutcome> {
    requireString(request.name, 'name');
    const record = await authorized(request);
    if (!record) return { outcome: 'not-found' };
    if (record.status !== 'running') return { outcome: 'child-terminal', child: record };
    const channel = tracked.get(record.childRunId)?.channel;
    if (!channel) {
      return {
        outcome: 'unsupported',
        reason: contracts[record.childAgentName] ? 'child-not-live' : 'no-signal-contract',
      };
    }
    const outcome = await channel.parent.send(request.name, request.payload);
    return outcome.status === 'acknowledged'
      ? { outcome: 'acknowledged', signalId: outcome.id, sequence: outcome.sequence }
      : {
          outcome: 'rejected',
          code: outcome.code,
          reason: outcome.reason,
          delivered: outcome.delivered,
        };
  }

  async function cancel(request: BureauChildCancelRequest): Promise<BureauChildCancelOutcome> {
    const record = await authorized(request);
    if (!record) return { outcome: 'not-found' };
    if (record.status !== 'running') return { outcome: 'already-terminal', child: record };
    const reason = request.reason ?? 'Cancelled via Bureau';
    const outcome = await cancelChild(record, reason);
    // Only a cancellation actually requested cancels the child's own
    // children. One that failed leaves the child — and so its subtree —
    // running; one that found the child already finished leaves a finished
    // parent, whose children recovery would reattach, not cancel.
    if (outcome.outcome === 'requested') await parentCancelled(record.childRunId, reason);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  async function classifyParent(
    parentRunId: string,
    engine: ChildTopologyEngine,
  ): Promise<ParentRecoveryState> {
    const parentRecord = await store.get(parentRunId);
    if (parentRecord) {
      if (parentRecord.status === 'running') return 'live';
      return parentRecord.status === 'aborted' ? 'cancelled' : 'finished';
    }
    const state = await engine.get(parentRunId);
    if (!state) return 'unrecoverable';
    if (state.status === 'cancelled') return 'cancelled';
    return TERMINAL_WORKFLOW_STATUSES.has(state.status) ? 'finished' : 'live';
  }

  async function deny(record: BureauChildRecord, code: string, reason: string): Promise<void> {
    await audit('delegation.rejected', record, { extra: { code, reason } });
    await cancelChild(record, `delegation ${code}: ${reason}`);
  }

  /**
   * COR-336's restart re-verification. `true` means the child is authorized
   * to keep running; `false` means it has already been denied and cancelled.
   */
  async function reauthorize(
    record: BureauChildRecord,
    grantId: string,
    parentState: ParentRecoveryState,
  ): Promise<boolean> {
    if (!delegation) {
      await deny(record, 'delegation-unavailable', 'no delegation secret is configured');
      return false;
    }
    const load = await store.loadGrant(grantId);
    if (load.status !== 'found') {
      await deny(record, load.status, `grant ${grantId} is ${load.status}`);
      return false;
    }
    if (parentState === 'unrecoverable') {
      const revoked = revokeDelegationGrant(load.grant, delegation.secret);
      await store.replaceGrant(load.grant, revoked);
      await audit('delegation.revoked', record, {
        extra: { reason: 'revoked-on-recovery', parentState },
      });
      await cancelChild(record, 'delegation revoked on recovery: the parent run is unrecoverable');
      return false;
    }
    const verification = verifyDelegationGrant(load.grant, delegation.secret, runtime.clock.now());
    if (!verification.valid) {
      await deny(record, verification.code, verification.reason);
      return false;
    }
    await reconcileLedger(load.grant);
    return true;
  }

  async function reattach(
    record: BureauChildRecord,
    workflowId: string,
    engine: ChildTopologyEngine,
  ): Promise<void> {
    const now = runtime.clock.now();
    const update = await store.update(record, {
      ...record,
      updatedAt: now,
      reattachedAt: now,
      recoveries: record.recoveries + 1,
    });
    if (update.status === 'stale') {
      release(record.childRunId, update.current);
      return;
    }
    await audit('child.reattached', update.record, {
      dedupeKey: `child.reattached:${record.childRunId}:${update.record.revision}`,
    });
    ensureTracked(record.childRunId);
    monitorRecovered(update.record, workflowId, engine);
  }

  async function reconcileDurable(
    record: BureauChildRecord,
    workflowId: string,
    engine: ChildTopologyEngine,
  ): Promise<void> {
    const state = await engine.get(workflowId);
    if (!state) {
      await settle(record.childRunId, 'failed', { reason: 'workflow missing on recovery' });
      return;
    }
    if (TERMINAL_WORKFLOW_STATUSES.has(state.status)) {
      // Finished while nothing was watching it — e.g. while its parent was unavailable.
      const settlement = settlementFromWorkflowState(state);
      await settle(record.childRunId, settlement.status, settlement.outcome);
      return;
    }
    const parentState = await classifyParent(record.parentRunId, engine);
    if (record.grantId !== undefined && !(await reauthorize(record, record.grantId, parentState))) {
      return;
    }
    if (
      (parentState === 'unrecoverable' || parentState === 'cancelled') &&
      record.parentCancellation === 'cascade'
    ) {
      await cancelChild(record, `parent ${record.parentRunId} is ${parentState} on recovery`);
      return;
    }
    await reattach(record, workflowId, engine);
  }

  async function reconcileOne(pending: BureauChildRecord): Promise<void> {
    const record = await store.get(pending.childRunId);
    if (record?.status !== 'running') {
      release(pending.childRunId, record);
      return;
    }
    if (record.workflow.kind === 'process-local') {
      await settle(record.childRunId, 'failed', { reason: 'process lost before recovery' });
      return;
    }
    const engine = dependencies.getEngine();
    if (!engine) {
      await settle(record.childRunId, 'failed', { reason: 'no durable engine on recovery' });
      return;
    }
    await reconcileDurable(record, record.workflow.workflowId, engine);
  }

  function depthOf(record: BureauChildRecord, visited = new Set<string>()): number {
    const parent = pendingRecovery.get(record.parentRunId);
    if (!parent || visited.has(record.childRunId)) return 0;
    visited.add(record.childRunId);
    return depthOf(parent, visited) + 1;
  }

  async function prepareRecovery(): Promise<void> {
    const records = await store.listAll();
    for (const record of records) {
      if (record.status !== 'running') continue;
      pendingRecovery.set(record.childRunId, record);
      if (record.workflow.kind !== 'durable') continue;
      const entry = ensureTracked(record.childRunId);
      const contract = contracts[record.childAgentName];
      if (contract && !entry.channel) {
        entry.channel = createChildSignalChannel(contract, {
          parentRunId: record.parentRunId,
          childRunId: record.childRunId,
        });
      }
    }
  }

  async function reconcileRecovery(): Promise<void> {
    const ordered = [...pendingRecovery.values()].toSorted(
      (left, right) => depthOf(left) - depthOf(right),
    );
    for (const record of ordered) {
      try {
        await reconcileOne(record);
      } catch (error) {
        release(record.childRunId, undefined);
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not recover child "${record.childRunId}" of "${record.parentRunId}": ${describeError(error)}`,
          cause: error,
        });
      }
    }
    pendingRecovery.clear();
  }

  function recoveredRunContext(
    runId: string,
  ): Pick<AgentRunContext, 'parentSignals' | 'childCorrelation'> | undefined {
    const record = pendingRecovery.get(runId);
    if (!record) return undefined;
    const channel = tracked.get(runId)?.channel;
    return {
      childCorrelation: correlationOf(record),
      ...(channel === undefined ? {} : { parentSignals: channel.child }),
    };
  }

  /** The public entry point: the policy write is tracked, so `drain()` lands it. */
  function applyParentCancellation(parentRunId: string, reason: string): Promise<void> {
    const applying = parentCancelled(parentRunId, reason);
    trackInFlight(applying);
    return applying;
  }

  async function settlementsKnown(): Promise<void> {
    while (awaitingResult.size > 0) {
      await Promise.allSettled(awaitingResult);
    }
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  }

  return {
    children: { dispatch, list, get: authorized, wait, signal, cancel },
    parentCancelled: applyParentCancellation,
    prepareRecovery,
    recoveredRunContext,
    reconcileRecovery,
    drain,
    settlementsKnown,
    awaitingSettlements: () => awaitingResult.size,
  };
}
