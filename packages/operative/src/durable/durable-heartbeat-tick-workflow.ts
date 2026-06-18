import type { WorkflowServicesResolution, WorkflowServicesResolverInfo } from '@lostgradient/weft';
import { workflow } from '@lostgradient/weft';

import type { Scheduler } from '../scheduler/create-scheduler';
import type { SchedulerPriority, SchedulerRunOptions, SchedulerTask } from '../scheduler/types';
import type { RunResult } from '../types';

export const DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE = 'durableHeartbeatTick' as const;

export type DurableHeartbeatTickStatus = 'completed' | 'failed' | 'preempted';

export interface DurableHeartbeatTickInput {
  scheduleId: string;
}

export interface DurableHeartbeatTickResult {
  workflowId: string;
  scheduleId: string;
  status: DurableHeartbeatTickStatus;
}

export interface DurableHeartbeatTickServices {
  scheduler: Scheduler;
  createHeartbeatRun: () => SchedulerRunOptions | Promise<SchedulerRunOptions>;
  priority?: SchedulerPriority;
  onTick?: (result: RunResult | null) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
}

export type DurableHeartbeatServicesStore = Map<string, DurableHeartbeatTickServices[]>;

const durableHeartbeatServicesByEngine = new WeakMap<object, DurableHeartbeatServicesStore>();

export interface DurableHeartbeatTickServicesRegistration {
  isOnlyRegistration(): boolean;
  unregister(): boolean;
}

export function createDurableHeartbeatServicesStore(): DurableHeartbeatServicesStore {
  return new Map<string, DurableHeartbeatTickServices[]>();
}

export function attachDurableHeartbeatServicesStore(
  engine: object,
  servicesStore: DurableHeartbeatServicesStore,
): void {
  durableHeartbeatServicesByEngine.set(engine, servicesStore);
}

export function assertDurableHeartbeatServicesStore(engine: object): void {
  getDurableHeartbeatServicesStore(engine);
}

function getDurableHeartbeatServicesStore(engine: object): DurableHeartbeatServicesStore {
  const servicesStore = durableHeartbeatServicesByEngine.get(engine);
  if (!servicesStore) {
    throw new Error('Durable heartbeat requires an engine created by createRunEngine.');
  }
  return servicesStore;
}

export function registerDurableHeartbeatTickServices(
  engine: object,
  scheduleId: string,
  services: DurableHeartbeatTickServices,
): DurableHeartbeatTickServicesRegistration {
  const servicesStore = getDurableHeartbeatServicesStore(engine);

  const registrations = servicesStore.get(scheduleId) ?? [];
  registrations.push(services);
  servicesStore.set(scheduleId, registrations);

  return {
    isOnlyRegistration() {
      const activeRegistrations = servicesStore.get(scheduleId);
      return activeRegistrations?.length === 1 && activeRegistrations[0] === services;
    },
    unregister() {
      const activeRegistrations = servicesStore.get(scheduleId);
      if (!activeRegistrations) return false;

      const index = activeRegistrations.lastIndexOf(services);
      if (index === -1) return false;

      activeRegistrations.splice(index, 1);
      if (activeRegistrations.length === 0) {
        servicesStore.delete(scheduleId);
        return true;
      }
      return false;
    },
  };
}

export function resolveDurableHeartbeatTickServices(
  servicesStore: DurableHeartbeatServicesStore,
  info: WorkflowServicesResolverInfo,
): WorkflowServicesResolution<DurableHeartbeatTickServices> {
  if (!isDurableHeartbeatTickInput(info.input)) {
    return {
      status: 'unavailable',
      reason: `run ${info.workflowId} has invalid durable heartbeat input`,
    };
  }

  const services = servicesStore.get(info.input.scheduleId)?.at(-1);
  if (!services) {
    return {
      status: 'unavailable',
      reason: `no durable heartbeat services registered for schedule ${info.input.scheduleId}`,
    };
  }

  return { status: 'available', services };
}

export function isDurableHeartbeatTickInput(value: unknown): value is DurableHeartbeatTickInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['scheduleId'] !== 'string') return false;

  return true;
}

function servicesFrom(
  services: DurableHeartbeatTickServices | undefined,
): DurableHeartbeatTickServices {
  if (!services) {
    throw new Error('durable heartbeat tick services are unavailable');
  }
  return services;
}

function createHeartbeatTask(
  _input: DurableHeartbeatTickInput,
  workflowId: string,
  services: DurableHeartbeatTickServices,
): SchedulerTask {
  return {
    id: `durable-heartbeat-${workflowId}`,
    priority: services.priority ?? 'scheduled',
    createRun: services.createHeartbeatRun,
    requeue: false,
  };
}

async function notifyTick(
  services: DurableHeartbeatTickServices,
  result: RunResult | null,
): Promise<void> {
  await services.onTick?.(result);
}

async function notifyFailure(
  services: DurableHeartbeatTickServices,
  error: unknown,
): Promise<void> {
  try {
    await services.onFailure?.(error);
  } catch {
    // Failure hooks are observational; the original tick failure remains the result.
  }
}

export function createDurableHeartbeatTickWorkflow() {
  return (
    workflow({ name: DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE })
      .services<DurableHeartbeatTickServices>()
      // eslint-disable-next-line @typescript-eslint/require-await -- Weft workflow bodies must be async generators, and the durable work is delegated through ctx.memo.
      .execute(async function* (
        ctx,
        input: unknown,
      ): AsyncGenerator<unknown, DurableHeartbeatTickResult> {
        if (!isDurableHeartbeatTickInput(input)) {
          throw new Error('durable heartbeat tick input must include a scheduleId');
        }

        const { workflowId } = ctx;

        return yield* ctx.memo('submit-scheduler-task', async () => {
          const services = servicesFrom(ctx.services);
          const task = createHeartbeatTask(input, workflowId, services);

          try {
            const result = await services.scheduler.submit(task);
            await notifyTick(services, result);

            if (result === null) {
              return { workflowId, scheduleId: input.scheduleId, status: 'preempted' };
            }

            if (result.finishReason === 'error') {
              await notifyFailure(
                services,
                result.error ?? new Error('durable heartbeat tick failed'),
              );
              return { workflowId, scheduleId: input.scheduleId, status: 'failed' };
            }

            return { workflowId, scheduleId: input.scheduleId, status: 'completed' };
          } catch (error) {
            await notifyFailure(services, error);
            return { workflowId, scheduleId: input.scheduleId, status: 'failed' };
          }
        });
      })
  );
}
