import { parseDuration, type ScheduleSpec, type ScheduleSummary } from '@lostgradient/weft';

import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import type {
  DurableHeartbeatTickInput,
  DurableHeartbeatTickServices,
} from '../durable/durable-heartbeat-tick-workflow';
import {
  assertDurableHeartbeatServicesStore,
  DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
  registerDurableHeartbeatTickServices,
} from '../durable/durable-heartbeat-tick-workflow';
import {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
} from '../events';
import type { EventDispatcher } from '../run-step';
import type { RunResult } from '../types';
import type { Scheduler } from './create-scheduler';
import type { SchedulerPriority, SchedulerRunOptions } from './types';

export interface CreateDurableHeartbeatOptions {
  scheduler: Scheduler;
  scheduleId: string;
  spec: string | ScheduleSpec;
  createHeartbeatRun: () => SchedulerRunOptions | Promise<SchedulerRunOptions>;
  priority?: SchedulerPriority;
  onTick?: (result: RunResult | null) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
  /**
   * Optional event dispatcher. When supplied, this call dispatches
   * `AgentScheduledEvent` (`schedule.created`, AB-298) exactly once when it
   * actually registers a new underlying Weft schedule — never when it joins
   * an existing schedule shared with another registration (see the
   * `existingSchedule` branch below). `agentName` on that event is set to
   * `DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE`, the honest analog of "what this
   * schedule fires" for a heartbeat, which has no per-agent identity of its
   * own. The returned handle's `pause`/`resume` each dispatch
   * `SchedulePausedEvent`/`ScheduleResumedEvent` (AB-223) exactly once per
   * successful call. `cancel()` dispatches `ScheduleCancelledEvent` only when
   * it actually cancels the underlying Weft schedule — not when it merely
   * unregisters this caller's services while another registration keeps the
   * schedule alive (see `cancel`'s branches below). Omitted entirely for a
   * caller with no event surface.
   */
  emitter?: EventDispatcher;
}

export interface DurableHeartbeat extends Disposable {
  readonly id: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  update(newSpec: string | ScheduleSpec): Promise<void>;
  describe(): Promise<ScheduleSummary | null>;
}

const durableHeartbeatLifecycleLocksByEngine = new WeakMap<object, Map<string, Promise<void>>>();

function getDurableHeartbeatLifecycleLocks(engine: object): Map<string, Promise<void>> {
  let lifecycleLocks = durableHeartbeatLifecycleLocksByEngine.get(engine);
  if (!lifecycleLocks) {
    lifecycleLocks = new Map<string, Promise<void>>();
    durableHeartbeatLifecycleLocksByEngine.set(engine, lifecycleLocks);
  }
  return lifecycleLocks;
}

async function withDurableHeartbeatLifecycleLock<T>(
  engine: object,
  scheduleId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lifecycleLocks = getDurableHeartbeatLifecycleLocks(engine);
  const previousLifecycle = lifecycleLocks.get(scheduleId) ?? Promise.resolve();
  let releaseCurrentLifecycle!: () => void;
  const currentLifecycle = previousLifecycle.then(
    () =>
      new Promise<void>((resolve) => {
        releaseCurrentLifecycle = resolve;
      }),
  );
  lifecycleLocks.set(scheduleId, currentLifecycle);

  await previousLifecycle;
  try {
    return await operation();
  } finally {
    releaseCurrentLifecycle();
    if (lifecycleLocks.get(scheduleId) === currentLifecycle) {
      lifecycleLocks.delete(scheduleId);
    }
  }
}

function assertDurableHeartbeatSchedule(
  schedule: ScheduleSummary,
  scheduleId: string,
  spec: string | ScheduleSpec,
): void {
  if (schedule.status === 'cancelled') {
    throw new Error(`Schedule ${scheduleId} already exists but is cancelled.`);
  }

  if (schedule.workflowType !== DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE) {
    throw new Error(
      `Schedule ${scheduleId} already exists for workflow ${schedule.workflowType}; expected ${DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE}.`,
    );
  }

  if (schedule.overlap !== 'skip') {
    throw new Error(`Schedule ${scheduleId} already exists with overlap ${schedule.overlap}.`);
  }

  if (schedule.backfill !== false) {
    throw new Error(`Schedule ${scheduleId} already exists with backfill enabled.`);
  }

  const requestedSpec = typeof spec === 'string' ? { cron: spec } : spec;
  if ('cron' in requestedSpec) {
    if (schedule.cronExpression !== requestedSpec.cron) {
      throw new Error(`Schedule ${scheduleId} already exists with a different cron spec.`);
    }
    return;
  }

  const requestedInterval = parseDuration(requestedSpec.every);
  if (schedule.intervalMs !== requestedInterval) {
    throw new Error(`Schedule ${scheduleId} already exists with a different interval spec.`);
  }
}

/**
 * Creates or reuses a durable Weft schedule that fires one scheduler task per tick.
 */
export async function createDurableHeartbeat(
  engine: RegistryAgnosticEngine,
  options: CreateDurableHeartbeatOptions,
): Promise<DurableHeartbeat> {
  const { scheduleId } = options;
  const services: DurableHeartbeatTickServices = {
    scheduler: options.scheduler,
    createHeartbeatRun: options.createHeartbeatRun,
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.onTick ? { onTick: options.onTick } : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  };
  const servicesRegistration = await withDurableHeartbeatLifecycleLock(
    engine,
    scheduleId,
    async () => {
      assertDurableHeartbeatServicesStore(engine);
      const existingSchedule = await engine.getSchedule(scheduleId);
      if (existingSchedule) {
        assertDurableHeartbeatSchedule(existingSchedule, scheduleId, options.spec);
      } else {
        await engine.schedule(
          DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
          {
            scheduleId,
          } satisfies DurableHeartbeatTickInput,
          options.spec,
          { id: scheduleId, overlap: 'skip', backfill: false },
        );
        // Only this branch registers a genuinely new Weft schedule — the
        // `existingSchedule` branch above joins one a prior registration
        // already created — so this dispatches exactly once per registered
        // schedule, never on a shared heartbeat's re-registration (AB-298).
        options.emitter?.dispatch(
          new AgentScheduledEvent({
            agentName: DURABLE_HEARTBEAT_TICK_WORKFLOW_TYPE,
            scheduleId,
            spec: typeof options.spec === 'string' ? { cron: options.spec } : options.spec,
          }),
        );
      }
      return registerDurableHeartbeatTickServices(engine, scheduleId, services);
    },
  );

  let servicesRegistered = true;

  function unregister(): boolean {
    if (!servicesRegistered) return false;
    servicesRegistered = false;
    return servicesRegistration.unregister();
  }

  return {
    id: scheduleId,
    async pause() {
      await engine.pauseSchedule(scheduleId);
      options.emitter?.dispatch(new SchedulePausedEvent(scheduleId));
    },
    async resume() {
      await engine.resumeSchedule(scheduleId);
      options.emitter?.dispatch(new ScheduleResumedEvent(scheduleId));
    },
    async cancel() {
      await withDurableHeartbeatLifecycleLock(engine, scheduleId, async () => {
        if (servicesRegistered && servicesRegistration.isOnlyRegistration()) {
          await engine.cancelSchedule(scheduleId);
          unregister();
          options.emitter?.dispatch(new ScheduleCancelledEvent(scheduleId));
          return;
        }
        unregister();
      });
    },
    update: (newSpec) => engine.updateSchedule(scheduleId, newSpec),
    describe: () => engine.getSchedule(scheduleId),
    [Symbol.dispose]: unregister,
  };
}
