import {
  WorkflowHandle,
  type Engine,
  type WorkflowHandle as WorkflowHandleType,
} from '@lostgradient/weft';

const activeRecoveryHandles = new Set<WorkflowHandle>();

class SessionRecoveryHandleFixture extends WorkflowHandle {
  readonly #settlement: () => Promise<unknown>;

  constructor(id: string, engine: Engine, settlement: () => Promise<unknown>) {
    super(id, engine);
    this.#settlement = settlement;
  }

  override result(): Promise<unknown> {
    return this.#settlement();
  }
}

export function createRecoveryHandle(
  id: string,
  engine: Engine,
  settlement: () => Promise<unknown>,
): WorkflowHandleType {
  const handle = new SessionRecoveryHandleFixture(id, engine, settlement);
  activeRecoveryHandles.add(handle);
  return handle;
}

export function trackRecoveryHandle(handle: WorkflowHandle): WorkflowHandle {
  activeRecoveryHandles.add(handle);
  return handle;
}

export async function disposeRecoveryHandles(): Promise<void> {
  const handles = [...activeRecoveryHandles];
  activeRecoveryHandles.clear();
  await Promise.all(handles.map((handle) => handle[Symbol.asyncDispose]()));
}

export interface SessionRecoveryHandleSpec {
  readonly id?: string;
  readonly result: () => Promise<unknown>;
}
