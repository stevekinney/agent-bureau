import { createTool } from 'armorer';
import type { EventMap, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget } from 'lifecycle';
import type { ZodType } from 'zod';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scratchpad event classes
// ---------------------------------------------------------------------------

export class EntrySetEvent extends Event {
  static readonly type = 'entry.set' as const;
  readonly key: string;
  readonly value: unknown;
  readonly previousValue?: unknown;
  constructor(key: string, value: unknown, previousValue?: unknown) {
    super(EntrySetEvent.type);
    this.key = key;
    this.value = value;
    this.previousValue = previousValue;
  }
}

export class EntryDeletedEvent extends Event {
  static readonly type = 'entry.deleted' as const;
  readonly key: string;
  readonly previousValue: unknown;
  constructor(key: string, previousValue: unknown) {
    super(EntryDeletedEvent.type);
    this.key = key;
    this.previousValue = previousValue;
  }
}

export class ScratchpadClearedEvent extends Event {
  static readonly type = 'scratchpad.cleared' as const;
  readonly previousEntries: Record<string, unknown>;
  constructor(previousEntries: Record<string, unknown>) {
    super(ScratchpadClearedEvent.type);
    this.previousEntries = previousEntries;
  }
}

export interface ScratchpadEventMap extends EventMap {
  [EntrySetEvent.type]: EntrySetEvent;
  [EntryDeletedEvent.type]: EntryDeletedEvent;
  [ScratchpadClearedEvent.type]: ScratchpadClearedEvent;
}

export type ScratchpadEvents = ScratchpadEventMap;

export type ScratchpadEventType = keyof ScratchpadEventMap;

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
    listener: (event: ScratchpadEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <K extends ScratchpadEventType>(
    type: K,
    listener: (event: ScratchpadEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  on: <K extends ScratchpadEventType>(type: K) => ObservableLike<ScratchpadEventMap[K]>;
  once: <K extends ScratchpadEventType>(
    type: K,
    listener: (event: ScratchpadEventMap[K]) => void,
  ) => void;
  subscribe: <K extends ScratchpadEventType>(
    type: K,
    observerOrNext?: Observer<ScratchpadEventMap[K]> | ((value: ScratchpadEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<ScratchpadEventMap[ScratchpadEventType]>;
}

export function createScratchpad(options?: CreateScratchpadOptions): Scratchpad {
  const store = new Map<string, unknown>(
    options?.initialValues ? Object.entries(options.initialValues) : [],
  );
  const schema = options?.schema;
  const events = new CompletableEventTarget<ScratchpadEventMap>();

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
      events.dispatch(new EntrySetEvent(key, value, previousValue));
    },

    delete(key: string): boolean {
      if (!store.has(key)) return false;
      const previousValue = store.get(key);
      store.delete(key);
      events.dispatch(new EntryDeletedEvent(key, previousValue));
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
      events.dispatch(new ScratchpadClearedEvent(previousEntries));
    },

    addEventListener: events.addEventListener.bind(events) as Scratchpad['addEventListener'],
    removeEventListener: events.removeEventListener.bind(
      events,
    ) as Scratchpad['removeEventListener'],
    on: events.on.bind(events) as Scratchpad['on'],
    once: events.once.bind(events) as Scratchpad['once'],
    subscribe: events.subscribe.bind(events) as Scratchpad['subscribe'],
    toObservable: events.toObservable.bind(events) as Scratchpad['toObservable'],
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
