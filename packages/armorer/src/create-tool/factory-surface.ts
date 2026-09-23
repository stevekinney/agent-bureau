import { CompletableEventTarget, type RuntimeServices } from '@lostgradient/lifecycle';
import type { z } from 'zod';

import { serializeToolDefinition } from '../core/serialization';
import type { ToolEventMap } from '../event-types';
import { createExecutionLifecycle, type ExecutionLifecycle } from '../execution-lifecycle';
import type {
  Tool,
  ToolConfiguration,
  ToolContext,
  ToolEventsMap,
  ToolExecuteWithOptions,
  ToolMetadata,
} from '../is-tool';
import type { ToolCallReturn } from '../types';
import { createKnownToolEvent } from './events';
import type { NamedTool } from './options';

export type ToolEventSurface = {
  dispatch: (event: Event) => boolean;
  emit: (type: string, detail: unknown) => boolean;
  emitter: CompletableEventTarget<ToolEventMap>;
  executionLifecycle: ExecutionLifecycle;
};

export function createToolEventSurface(runtime: RuntimeServices): ToolEventSurface {
  const emitter = new CompletableEventTarget<ToolEventMap>();
  return {
    dispatch: (event) => emitter.dispatchEvent(event),
    emit: (type, detail) => emitToolEvent(emitter, type, detail),
    emitter,
    executionLifecycle: createExecutionLifecycle(undefined, runtime),
  };
}

export function createCallableTool<
  TInput,
  E extends ToolEventsMap,
  TReturn,
  M extends ToolMetadata | undefined,
  TName extends string,
  Tags extends readonly string[],
>(input: {
  name: TName;
  metadata: M;
  callable: (params: unknown) => Promise<ToolCallReturn<TReturn>>;
  configuration: ToolConfiguration;
  typedSchema: z.ZodType<TInput>;
  emitter: CompletableEventTarget<ToolEventMap>;
  executionLifecycle: ExecutionLifecycle;
  execute: Tool<z.ZodType<TInput>, E, TReturn, M>['execute'];
  executeWith: (options: ToolExecuteWithOptions) => Promise<import('../types').ToolExecutionResult>;
  emit: (type: string, detail: unknown) => boolean;
  idempotencyKey?: (input: unknown) => string;
  rawExecute: (params: TInput, context: ToolContext<E>) => Promise<TReturn>;
}): NamedTool<TName, z.ZodType<TInput>, E, TReturn, M, Tags> {
  const toJSON = createToolSerializer(input.configuration, input.typedSchema);
  const properties = {
    id: input.configuration.id,
    identity: input.configuration.identity,
    display: input.configuration.display,
    name: input.name,
    description: input.configuration.display.description,
    input: input.typedSchema,
    execute: input.execute,
    executeWith: input.executeWith,
    run: input.rawExecute,
    rawExecute: input.rawExecute,
    configuration: input.configuration,
    ...eventMethods(input.emitter, input.emit),
    toJSON,
    toString: () =>
      `**${input.configuration.identity.name}**: ${input.configuration.display.description}`,
    [Symbol.toPrimitive]: () => input.name,
    ...(input.configuration.tags !== undefined ? { tags: input.configuration.tags } : {}),
    metadata: input.metadata,
    risk: input.configuration.risk,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    async complete() {
      input.emitter.complete();
      await input.executionLifecycle.complete();
    },
    executions: input.executionLifecycle,
    whenIdle: () => input.executionLifecycle.whenIdle(),
    get completed() {
      return input.executionLifecycle.completed;
    },
    get activeExecutions() {
      return input.executionLifecycle.activeExecutions;
    },
    get executionSignal() {
      return input.executionLifecycle.signal;
    },
    [Symbol.dispose]() {
      input.emitter.complete();
      void input.executionLifecycle.complete();
    },
  };
  // Function names are configurable but initially non-writable. Build the
  // actual callable surface, then restore read-only values and live getters.
  Object.defineProperty(input.callable, 'name', { writable: true });
  const tool = Object.assign(input.callable, properties);
  for (const key of Reflect.ownKeys(properties)) {
    const descriptor = Object.getOwnPropertyDescriptor(properties, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.writable = false;
    Object.defineProperty(tool, key, descriptor);
  }
  return tool;
}

function emitToolEvent(
  emitter: CompletableEventTarget<ToolEventMap>,
  type: string,
  detail: unknown,
): boolean {
  const knownEvent = createKnownToolEvent(type, detail);
  if (knownEvent) return emitter.dispatchEvent(knownEvent);
  const event = new Event(type);
  if (detail !== null && detail !== undefined && typeof detail === 'object') {
    Object.assign(event, detail);
  } else if (detail !== undefined) {
    Object.defineProperty(event, 'detail', { value: detail, enumerable: true });
  }
  return emitter.dispatchEvent(event);
}

function eventMethods(
  emitter: CompletableEventTarget<ToolEventMap>,
  emit: (type: string, detail: unknown) => boolean,
) {
  return {
    addEventListener<K extends keyof ToolEventMap & string>(
      type: K,
      listener: (event: ToolEventMap[K]) => void | Promise<void>,
      options?: AddEventListenerOptions,
    ) {
      const mergedOptions: AddEventListenerOptions = {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, emitter.signal])
          : emitter.signal,
      };
      emitter.addEventListener(type, listener, mergedOptions);
      return () => emitter.removeEventListener(type, listener, options);
    },
    dispatchEvent: (event: Event) => emitter.dispatchEvent(event),
    emit,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    subscribe: emitter.subscribe.bind(emitter),
    toObservable: emitter.toObservable.bind(emitter),
    events: emitter.events.bind(emitter),
  };
}

function createToolSerializer<TInput>(
  configuration: ToolConfiguration,
  typedSchema: z.ZodType<TInput>,
): () => ReturnType<Tool['toJSON']> {
  const serializableConfiguration = { ...configuration, input: configuration.input ?? typedSchema };
  const json = serializeToolDefinition(serializableConfiguration);
  return () => json;
}
