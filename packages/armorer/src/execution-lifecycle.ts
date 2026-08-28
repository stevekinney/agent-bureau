import {
  type EffectiveToolExecutionContext,
  freezeEffectiveToolExecutionContext,
} from './execution-context';

export type ExecutionState =
  | 'queued'
  | 'active'
  | 'waiting'
  | 'streaming'
  | 'abort-requested'
  | 'cleanup-pending'
  | 'terminal'
  | 'unknown-effect';

export type ExecutionAbortSource = 'caller' | 'deadline' | 'owner' | 'toolbox' | 'shutdown';

export interface ExecutionIdentity {
  executionId: string;
  toolName: string;
  callId: string;
  ownerId: string;
  parentExecutionId?: string;
}

export interface ExecutionCleanupOutcome {
  status: 'not-required' | 'completed' | 'failed' | 'unresolved';
  error?: unknown;
}

export interface ExecutionSnapshot extends ExecutionIdentity {
  revision: number;
  state: ExecutionState;
  queuedAt: number;
  startedAt?: number;
  deadline?: number;
  lastActivityAt: number;
  queuePosition?: number;
  capacity?: number;
  declaredWait?: string;
  abortSource?: ExecutionAbortSource;
  abortReason?: unknown;
  result?: unknown;
  cleanup?: ExecutionCleanupOutcome;
}

export interface ExecutionLifecycleEvent {
  type: 'execution.lifecycle';
  snapshot: ExecutionSnapshot;
}

export interface ExecutionSelector {
  executionId?: string;
  callId?: string;
  ownerId?: string;
  toolName?: string;
}

export interface ExecutionCleanupReport {
  admissionClosed: true;
  policy: 'abort' | 'drain';
  requested: number;
  terminal: number;
  unknownEffects: number;
  cleanupFailures: number;
  snapshots: readonly ExecutionSnapshot[];
}

export interface ExecutionHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  snapshot(): ExecutionSnapshot;
  privilegedSnapshot(): PrivilegedExecutionSnapshot;
  updatePrivilegedContext(context: EffectiveToolExecutionContext): void;
  queued(position: number, capacity?: number): void;
  activate(): void;
  waiting(declaredWait: string): void;
  streaming(): void;
  activity(): void;
  abort(source?: ExecutionAbortSource, reason?: unknown): boolean;
  cleanupPending(result?: unknown): void;
  settle(result?: unknown): void;
  cleanup(outcome?: ExecutionCleanupOutcome): void;
  unknownEffect(result?: unknown): void;
  whenSettled(): Promise<ExecutionSnapshot>;
}

export interface BeginExecutionOptions {
  executionId?: string;
  toolName: string;
  callId: string;
  ownerId?: string;
  parentExecutionId?: string;
  signal?: AbortSignal;
  deadline?: number;
  capacity?: number;
  queuePosition?: number;
  now?: () => number;
  setTimeoutFunction?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeoutFunction?: (handle: unknown) => void;
  scheduleDeadline?: boolean;
  privilegedContext?: EffectiveToolExecutionContext;
}

export interface PrivilegedExecutionSnapshot {
  snapshot: ExecutionSnapshot;
  context?: EffectiveToolExecutionContext;
}

export interface ExecutionLifecycle {
  readonly signal: AbortSignal;
  readonly completed: boolean;
  readonly admissionClosed: boolean;
  readonly activeExecutions: number;
  begin(options: BeginExecutionOptions): ExecutionHandle;
  start(): () => void;
  inspect(selector?: ExecutionSelector): readonly ExecutionSnapshot[];
  inspectPrivileged(selector?: ExecutionSelector): readonly PrivilegedExecutionSnapshot[];
  locate(executionId: string): ExecutionHandle | undefined;
  subscribe(listener: (event: ExecutionLifecycleEvent) => void): () => void;
  closeAdmission(): void;
  abort(selector?: ExecutionSelector, reason?: unknown, source?: ExecutionAbortSource): number;
  whenIdle(): Promise<void>;
  shutdown(options?: {
    policy?: 'abort' | 'drain';
    reason?: unknown;
  }): Promise<ExecutionCleanupReport>;
  complete(): Promise<void>;
}

type RecordState = {
  snapshot: ExecutionSnapshot;
  controller: AbortController;
  settled: Promise<ExecutionSnapshot>;
  resolveSettled: (snapshot: ExecutionSnapshot) => void;
  privilegedContext?: EffectiveToolExecutionContext;
};

let nextExecutionId = 0;

function retainTerminalPrivilegedContext(
  context: EffectiveToolExecutionContext | undefined,
): EffectiveToolExecutionContext | undefined {
  if (!context) return undefined;
  return freezeEffectiveToolExecutionContext({
    authority: {
      principalId: context.authority.principalId,
      tenantId: context.authority.tenantId,
      ownerId: context.authority.ownerId,
      capabilities: [...context.authority.capabilities],
      authorizationRevision: context.authority.authorizationRevision,
    },
    ...(context.audience !== undefined ? { audience: context.audience } : {}),
    ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context.locale !== undefined ? { locale: context.locale } : {}),
    ...(context.deadline !== undefined ? { deadline: context.deadline } : {}),
    revisions: {
      catalog: context.revisions.catalog,
      toolbox: context.revisions.toolbox,
      toolDefinition: context.revisions.toolDefinition,
      policy: context.revisions.policy,
      approval: context.revisions.approval,
      redaction: context.revisions.redaction,
    },
  });
}

export function createExecutionLifecycle(defaultOwnerId = 'anonymous'): ExecutionLifecycle {
  const ownerController = new AbortController();
  const records = new Map<string, RecordState>();
  const handles = new Map<string, ExecutionHandle>();
  const listeners = new Set<(event: ExecutionLifecycleEvent) => void>();
  let closed = false;
  let shutdownPromise: Promise<ExecutionCleanupReport> | undefined;
  let idlePromise: Promise<void> | undefined;
  let resolveIdle: (() => void) | undefined;

  const freeze = (snapshot: ExecutionSnapshot) => Object.freeze({ ...snapshot });
  const unfinished = () =>
    [...records.values()].filter(
      ({ snapshot }) => snapshot.state !== 'terminal' && snapshot.state !== 'unknown-effect',
    );
  const settleIdle = () => {
    if (unfinished().length === 0 && resolveIdle) {
      resolveIdle();
      resolveIdle = undefined;
      idlePromise = undefined;
    }
  };
  const publish = (record: RecordState, patch: Partial<ExecutionSnapshot>, now = Date.now()) => {
    record.snapshot = freeze({
      ...record.snapshot,
      ...patch,
      revision: record.snapshot.revision + 1,
      lastActivityAt: now,
    });
    const event = Object.freeze({
      type: 'execution.lifecycle',
      snapshot: record.snapshot,
    } as const);
    notifyListeners(event);
  };
  const notifyListeners = (event: ExecutionLifecycleEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber failures must not affect lifecycle state transitions.
      }
    }
  };
  const matches = (snapshot: ExecutionSnapshot, selector: ExecutionSelector = {}) =>
    (selector.executionId === undefined || snapshot.executionId === selector.executionId) &&
    (selector.callId === undefined || snapshot.callId === selector.callId) &&
    (selector.ownerId === undefined || snapshot.ownerId === selector.ownerId) &&
    (selector.toolName === undefined || snapshot.toolName === selector.toolName);

  const lifecycle: ExecutionLifecycle = {
    signal: ownerController.signal,
    get completed() {
      return closed && unfinished().length === 0;
    },
    get admissionClosed() {
      return closed;
    },
    get activeExecutions() {
      return unfinished().length;
    },
    begin(options) {
      if (closed) throw new Error('Execution admission is closed');
      const now = options.now ?? Date.now;
      const queuedAt = now();
      const executionId = options.executionId ?? `execution-${++nextExecutionId}`;
      if (records.has(executionId)) {
        throw new Error(`Execution already exists: ${executionId}`);
      }
      const controller = new AbortController();
      let resolveSettled!: (snapshot: ExecutionSnapshot) => void;
      const settled = new Promise<ExecutionSnapshot>((resolve) => (resolveSettled = resolve));
      const record: RecordState = {
        controller,
        settled,
        resolveSettled,
        ...(options.privilegedContext
          ? { privilegedContext: freezeEffectiveToolExecutionContext(options.privilegedContext) }
          : {}),
        snapshot: freeze({
          executionId,
          toolName: options.toolName,
          callId: options.callId,
          ownerId: options.ownerId ?? defaultOwnerId,
          ...(options.parentExecutionId ? { parentExecutionId: options.parentExecutionId } : {}),
          revision: 1,
          state: 'queued',
          queuedAt,
          lastActivityAt: queuedAt,
          ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
          ...(options.capacity !== undefined ? { capacity: options.capacity } : {}),
          ...(options.queuePosition !== undefined ? { queuePosition: options.queuePosition } : {}),
        }),
      };
      records.set(executionId, record);
      const transition = (patch: Partial<ExecutionSnapshot>) => publish(record, patch, now());
      let clearDeadline: (() => void) | undefined;
      const abort = (source: ExecutionAbortSource = 'owner', reason?: unknown) => {
        if (
          record.snapshot.state === 'terminal' ||
          record.snapshot.state === 'unknown-effect' ||
          record.snapshot.state === 'cleanup-pending'
        )
          return false;
        if (record.snapshot.state === 'abort-requested') return false;
        transition({ state: 'abort-requested', abortSource: source, abortReason: reason });
        if (!controller.signal.aborted) controller.abort(reason);
        return true;
      };
      const finish = (patch: Partial<ExecutionSnapshot>) => {
        if (record.snapshot.state === 'terminal') return;
        removeAbortListeners();
        clearDeadline?.();
        if (patch.state === 'terminal' || patch.state === 'unknown-effect') {
          record.privilegedContext = retainTerminalPrivilegedContext(record.privilegedContext);
        }
        if (record.snapshot.state === 'unknown-effect') {
          if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
            transition({ result: patch.result });
          }
          return;
        }
        transition(patch);
        record.resolveSettled(record.snapshot);
        settleIdle();
      };
      const transitionWhileOwned = (patch: Partial<ExecutionSnapshot>) => {
        if (record.snapshot.state === 'terminal' || record.snapshot.state === 'unknown-effect')
          return;
        transition(patch);
      };
      const handle: ExecutionHandle = {
        id: executionId,
        signal: controller.signal,
        snapshot: () => record.snapshot,
        privilegedSnapshot: () =>
          Object.freeze({
            snapshot: record.snapshot,
            ...(record.privilegedContext ? { context: record.privilegedContext } : {}),
          }),
        updatePrivilegedContext: (context) => {
          if (record.snapshot.state === 'terminal' || record.snapshot.state === 'unknown-effect')
            return;
          record.privilegedContext = freezeEffectiveToolExecutionContext(context);
        },
        queued: (queuePosition, capacity) => {
          if (record.snapshot.state !== 'queued') return;
          transition({ queuePosition, ...(capacity === undefined ? {} : { capacity }) });
        },
        activate: () =>
          transitionWhileOwned({ state: 'active', startedAt: now(), queuePosition: undefined }),
        waiting: (declaredWait) => transitionWhileOwned({ state: 'waiting', declaredWait }),
        streaming: () => transitionWhileOwned({ state: 'streaming', declaredWait: undefined }),
        activity: () => transitionWhileOwned({}),
        abort,
        cleanupPending: (result) => transitionWhileOwned({ state: 'cleanup-pending', result }),
        settle: (result) =>
          finish({ state: 'terminal', result, cleanup: { status: 'not-required' } }),
        cleanup: (cleanup = { status: 'completed' }) =>
          finish({
            state: cleanup.status === 'unresolved' ? 'unknown-effect' : 'terminal',
            cleanup,
          }),
        unknownEffect: (result) =>
          finish({
            state: 'unknown-effect',
            result,
            cleanup: { status: 'unresolved' },
          }),
        whenSettled: () => record.settled,
      };
      handles.set(executionId, handle);
      const removeCallerAbortListener = () => {
        options.signal?.removeEventListener('abort', onCallerAbort);
      };
      const removeOwnerAbortListener = () => {
        ownerController.signal.removeEventListener('abort', onOwnerAbort);
      };
      const removeAbortListeners = () => {
        removeCallerAbortListener();
        removeOwnerAbortListener();
      };
      function onCallerAbort() {
        abort('caller', options.signal?.reason);
      }
      function onOwnerAbort() {
        abort('owner', ownerController.signal.reason);
      }
      if (options.signal) {
        if (options.signal.aborted) onCallerAbort();
        else {
          options.signal.addEventListener('abort', onCallerAbort, { once: true });
        }
      }
      if (options.deadline !== undefined && options.scheduleDeadline !== false) {
        const schedule =
          options.setTimeoutFunction ??
          ((callback, milliseconds) => setTimeout(callback, milliseconds));
        const timeoutHandle = schedule(
          () => abort('deadline', 'Execution deadline exceeded'),
          Math.max(0, options.deadline - now()),
        );
        const clear =
          options.clearTimeoutFunction ??
          ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
        clearDeadline = () => {
          clear(timeoutHandle);
          clearDeadline = undefined;
        };
      }
      ownerController.signal.addEventListener('abort', onOwnerAbort, { once: true });
      notifyListeners(Object.freeze({ type: 'execution.lifecycle', snapshot: record.snapshot }));
      return handle;
    },
    start() {
      const handle = lifecycle.begin({
        toolName: 'unknown',
        callId: `call-${nextExecutionId + 1}`,
      });
      handle.activate();
      return () => handle.settle();
    },
    inspect(selector) {
      return Object.freeze(
        [...records.values()]
          .map(({ snapshot }) => snapshot)
          .filter((snapshot) => matches(snapshot, selector)),
      );
    },
    inspectPrivileged(selector) {
      return Object.freeze(
        [...records.values()]
          .filter(({ snapshot }) => matches(snapshot, selector))
          .map(({ snapshot, privilegedContext }) =>
            Object.freeze({
              snapshot,
              ...(privilegedContext ? { context: privilegedContext } : {}),
            }),
          ),
      );
    },
    locate: (executionId) => handles.get(executionId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closeAdmission() {
      closed = true;
    },
    abort(selector, reason, source = 'owner') {
      let count = 0;
      for (const [id, record] of records) {
        if (matches(record.snapshot, selector) && unfinished().includes(record)) {
          if (handles.get(id)?.abort(source, reason)) count += 1;
        }
      }
      return count;
    },
    whenIdle() {
      if (unfinished().length === 0) return Promise.resolve();
      if (!idlePromise) idlePromise = new Promise<void>((resolve) => (resolveIdle = resolve));
      return idlePromise;
    },
    shutdown(options = {}) {
      if (shutdownPromise) return shutdownPromise;
      const policy = options.policy ?? 'abort';
      closed = true;
      const requested =
        policy === 'abort'
          ? lifecycle.abort({}, options.reason ?? 'Execution owner shut down', 'shutdown')
          : 0;
      if (policy === 'abort' && !ownerController.signal.aborted) {
        ownerController.abort(options.reason ?? 'Execution owner shut down');
      }
      shutdownPromise = lifecycle.whenIdle().then(() => {
        const snapshots = lifecycle.inspect();
        return Object.freeze({
          admissionClosed: true as const,
          policy,
          requested,
          terminal: snapshots.filter(({ state }) => state === 'terminal').length,
          unknownEffects: snapshots.filter(({ state }) => state === 'unknown-effect').length,
          cleanupFailures: snapshots.filter(({ cleanup }) => cleanup?.status === 'failed').length,
          snapshots,
        });
      });
      return shutdownPromise;
    },
    async complete() {
      await lifecycle.shutdown();
    },
  };
  return lifecycle;
}
