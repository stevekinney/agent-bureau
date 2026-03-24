import { createTool } from 'armorer';
import type { AddEventListenerOptionsLike, EmissionEvent } from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import type { ZodType } from 'zod';
import { z } from 'zod';

export interface ScratchpadEvents {
  'entry.set': { key: string; value: unknown; previousValue?: unknown };
  'entry.deleted': { key: string; previousValue: unknown };
  'scratchpad.cleared': { previousEntries: Record<string, unknown> };
}

export type ScratchpadEventType = keyof ScratchpadEvents;

export interface CreateScratchpadOptions {
  schema?: ZodType;
  initialValues?: Record<string, unknown>;
}

export interface Scratchpad {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  entries(): IterableIterator<[string, unknown]>;
  toJSON(): Record<string, unknown>;
  clear(): void;
  addEventListener: <K extends ScratchpadEventType>(
    type: K,
    listener: (event: EmissionEvent<ScratchpadEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  on: <K extends ScratchpadEventType>(
    type: K,
    listener: (event: EmissionEvent<ScratchpadEvents[K], K>) => void | Promise<void>,
  ) => () => void;
  once: <K extends ScratchpadEventType>(
    type: K,
    listener: (event: EmissionEvent<ScratchpadEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends ScratchpadEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<ScratchpadEvents[K], K>>
      | ((value: EmissionEvent<ScratchpadEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<
    EmissionEvent<ScratchpadEvents[ScratchpadEventType], ScratchpadEventType>
  >;
}

export function createScratchpad(options?: CreateScratchpadOptions): Scratchpad {
  const store = new Map<string, unknown>(
    options?.initialValues ? Object.entries(options.initialValues) : [],
  );
  const schema = options?.schema;
  const events = createEventTarget<ScratchpadEvents>();

  function validateKey(key: string): void {
    if (schema) {
      const shape =
        'shape' in schema ? (schema as { shape: Record<string, ZodType> }).shape : undefined;
      if (shape && !(key in shape)) {
        throw new Error(`Key "${key}" is not allowed by the schema`);
      }
    }
  }

  function validateValue(key: string, value: unknown): void {
    if (schema) {
      const shape =
        'shape' in schema ? (schema as { shape: Record<string, ZodType> }).shape : undefined;
      if (shape && key in shape) {
        const fieldSchema = shape[key]!;
        fieldSchema.parse(value);
      }
    }
  }

  return {
    get(key: string): unknown {
      return store.get(key);
    },

    set(key: string, value: unknown): void {
      validateKey(key);
      validateValue(key, value);
      const previousValue = store.get(key);
      store.set(key, value);
      events.emit('entry.set', { key, value, previousValue });
    },

    delete(key: string): boolean {
      if (!store.has(key)) return false;
      const previousValue = store.get(key);
      store.delete(key);
      events.emit('entry.deleted', { key, previousValue });
      return true;
    },

    has(key: string): boolean {
      return store.has(key);
    },

    keys(): IterableIterator<string> {
      return store.keys();
    },

    entries(): IterableIterator<[string, unknown]> {
      return store.entries();
    },

    toJSON(): Record<string, unknown> {
      return Object.fromEntries(store);
    },

    clear(): void {
      const previousEntries = Object.fromEntries(store);
      store.clear();
      events.emit('scratchpad.cleared', { previousEntries });
    },

    addEventListener: events.addEventListener.bind(events),
    on: events.on.bind(events) as Scratchpad['on'],
    once: events.once.bind(events),
    subscribe: events.subscribe.bind(events),
    toObservable: events.toObservable.bind(events),
  };
}

export interface TypedScratchpad<T extends Record<string, unknown>> extends Omit<
  Scratchpad,
  'get' | 'set'
> {
  get<K extends keyof T & string>(key: K): T[K] | undefined;
  set<K extends keyof T & string>(key: K, value: T[K]): void;
}

export function createTypedScratchpad<T extends Record<string, unknown>>(
  options?: CreateScratchpadOptions,
): TypedScratchpad<T> {
  const scratchpad = createScratchpad(options);
  return {
    ...scratchpad,
    get<K extends keyof T & string>(key: K): T[K] | undefined {
      return scratchpad.get(key) as T[K] | undefined;
    },
    set<K extends keyof T & string>(key: K, value: T[K]): void {
      scratchpad.set(key, value);
    },
  };
}

export function createScratchpadReadTool(scratchpad: Scratchpad) {
  return createTool({
    name: 'read-scratchpad',
    description: 'Read a value from the shared scratchpad by key, or read all entries.',
    input: z.object({
      key: z.string().optional().describe('The key to read. Omit to read all entries.'),
    }),
    execute: ({ key }) => {
      if (key !== undefined) {
        if (!scratchpad.has(key)) {
          return Promise.resolve(JSON.stringify({ found: false, key }));
        }
        return Promise.resolve(JSON.stringify({ found: true, key, value: scratchpad.get(key) }));
      }
      return Promise.resolve(JSON.stringify(scratchpad.toJSON()));
    },
  });
}

export function createScratchpadWriteTool(scratchpad: Scratchpad) {
  return createTool({
    name: 'write-scratchpad',
    description: 'Write a value to the shared scratchpad.',
    input: z.object({
      key: z.string().describe('The key to write.'),
      value: z.unknown().describe('The value to store.'),
    }),
    execute: ({ key, value }) => {
      scratchpad.set(key, value);
      return Promise.resolve(JSON.stringify({ success: true, key }));
    },
  });
}
