import {
  Engine,
  MemoryStorage,
  WorkflowHandle,
  type QueryDefinition,
  type RegistryAgnosticEngine,
  type SignalDefinition,
  type SignalDeliveryOptions,
  type UpdateDefinition,
  type WorkflowState,
} from '@lostgradient/weft';
import { afterEach } from 'bun:test';
import {
  createRecoveryHandle,
  disposeRecoveryHandles,
  trackRecoveryHandle,
  type SessionRecoveryHandleSpec,
} from './session-recovery-handle-test-fixture';

export interface SessionEngineBehavior {
  readonly cancel?: (workflowId: string) => Promise<void>;
  readonly get?: (workflowId: string) => Promise<SessionWorkflowState | null>;
  readonly query?: (workflowId: string, name: string, input?: unknown) => Promise<unknown>;
  readonly resume?: (workflowId: string) => Promise<WorkflowHandle | SessionRecoveryHandleSpec>;
  readonly start?: (
    type: string,
    input: unknown,
    options: { id: string; services?: unknown },
  ) => Promise<WorkflowHandle | SessionRecoveryHandleSpec>;
  readonly signal?: (workflowId: string, name: string, payload?: unknown) => Promise<void>;
  readonly update?: (workflowId: string, name: string, payload?: unknown) => Promise<unknown>;
}

type EngineStartOptions = Parameters<Engine['start']>[2];

const activeEngines = new Set<SessionEngineFixture>();

afterEach(async () => {
  await disposeRecoveryHandles();
  const engines = [...activeEngines];
  activeEngines.clear();
  await Promise.all(engines.map((engine) => engine[Symbol.asyncDispose]()));
});

export class SessionEngineFixture extends Engine {
  readonly #behavior: SessionEngineBehavior;

  constructor(behavior: SessionEngineBehavior = {}) {
    super({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    this.#behavior = behavior;
    activeEngines.add(this);
  }

  override cancel(workflowId: string): Promise<void> {
    return this.#behavior.cancel?.(workflowId) ?? super.cancel(workflowId);
  }

  override get(workflowId: string): Promise<WorkflowState | null> {
    const configured = this.#behavior.get?.(workflowId);
    return configured === undefined
      ? super.get(workflowId)
      : configured.then((value) => normalizeWorkflowState(workflowId, value));
  }

  override query<TOutput>(
    workflowId: string,
    name: QueryDefinition<void, TOutput>,
  ): Promise<TOutput>;
  override query<TInput, TOutput>(
    workflowId: string,
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  override query(workflowId: string, name: string, input?: unknown): Promise<unknown>;
  override query(
    workflowId: string,
    name: string | QueryDefinition | QueryDefinition<unknown>,
    input?: unknown,
  ): Promise<unknown> {
    if (typeof name !== 'string') return Promise.reject(new Error('typed query not configured'));
    return this.#behavior.query?.(workflowId, name, input) ?? super.query(workflowId, name, input);
  }

  override resume(workflowId: string): Promise<WorkflowHandle> {
    const configured = this.#behavior.resume?.(workflowId);
    if (configured === undefined) return super.resume(workflowId).then(trackRecoveryHandle);
    return configured.then((value) => toWorkflowHandle(workflowId, this, value));
  }

  override start(
    type: string,
    input: unknown,
    options?: EngineStartOptions,
  ): Promise<WorkflowHandle> {
    const configured =
      options !== undefined && options.id !== undefined
        ? this.#behavior.start?.(type, input, { id: options.id, services: options.services })
        : undefined;
    if (configured === undefined)
      return super.start(type, input, options).then(trackRecoveryHandle);
    return configured.then((value) => toWorkflowHandle(options?.id ?? type, this, value));
  }

  override signal(workflowId: string, name: SignalDefinition): Promise<void>;
  override signal<TInput>(
    workflowId: string,
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  override signal(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  override signal(
    workflowId: string,
    name: string | SignalDefinition | SignalDefinition<unknown>,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void> {
    if (typeof name !== 'string') return Promise.reject(new Error('typed signal not configured'));
    return (
      this.#behavior.signal?.(workflowId, name, payload) ??
      super.signal(workflowId, name, payload, options)
    );
  }

  override update(
    workflowId: string,
    name: UpdateDefinition,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<unknown>;
  override update<TInput, TOutput>(
    workflowId: string,
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  override update(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  override update(
    workflowId: string,
    name: string | UpdateDefinition | UpdateDefinition<unknown>,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    if (typeof name !== 'string') return Promise.reject(new Error('typed update not configured'));
    return (
      this.#behavior.update?.(workflowId, name, payload) ??
      super.update(workflowId, name, payload, options)
    );
  }
}

function toWorkflowHandle(
  fallbackId: string,
  engine: SessionEngineFixture,
  value: WorkflowHandle | SessionRecoveryHandleSpec,
): WorkflowHandle {
  if (value instanceof WorkflowHandle) return trackRecoveryHandle(value);
  return createRecoveryHandle(value.id ?? fallbackId, engine, value.result);
}

type SessionWorkflowState = Partial<WorkflowState> & Pick<WorkflowState, 'status'>;

function normalizeWorkflowState(
  workflowId: string,
  value: SessionWorkflowState | null,
): WorkflowState | null {
  if (value === null) return null;
  return {
    ...value,
    id: value.id ?? workflowId,
    type: value.type ?? 'session-fixture',
    input: value.input ?? null,
    versionTuple: value.versionTuple ?? { workflowVersion: 'session-fixture' },
    createdAt: value.createdAt ?? 0,
    updatedAt: value.updatedAt ?? value.createdAt ?? 0,
  };
}

export function createSessionEngine(behavior: SessionEngineBehavior = {}): RegistryAgnosticEngine {
  return new SessionEngineFixture(behavior);
}
