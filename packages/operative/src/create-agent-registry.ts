import { createTool } from 'armorer';
import type { EventMap, ObservableLike, Observer, Subscription } from 'lifecycle';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import type { AgentDefinition } from './types';

export interface AgentRegistryEntry {
  agent: AgentDefinition;
  description: string;
  capabilities: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentRegistryQuery {
  text?: string;
  capabilities?: string[];
  allCapabilities?: string[];
  tags?: string[];
  predicate?: (entry: AgentRegistryEntry) => boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Registry event classes
// ---------------------------------------------------------------------------

export class AgentRegisteredEvent extends Event {
  static readonly type = 'agent.registered' as const;
  readonly name: string;
  readonly entry: AgentRegistryEntry;
  constructor(name: string, entry: AgentRegistryEntry) {
    super(AgentRegisteredEvent.type);
    this.name = name;
    this.entry = entry;
  }
}

export class AgentUnregisteredEvent extends Event {
  static readonly type = 'agent.unregistered' as const;
  readonly name: string;
  constructor(name: string) {
    super(AgentUnregisteredEvent.type);
    this.name = name;
  }
}

export class AgentQueriedEvent extends Event {
  static readonly type = 'agent.queried' as const;
  readonly query: AgentRegistryQuery;
  readonly results: AgentRegistryEntry[];
  constructor(query: AgentRegistryQuery, results: AgentRegistryEntry[]) {
    super(AgentQueriedEvent.type);
    this.query = query;
    this.results = results;
  }
}

export interface AgentRegistryEventMap extends EventMap {
  [AgentRegisteredEvent.type]: AgentRegisteredEvent;
  [AgentUnregisteredEvent.type]: AgentUnregisteredEvent;
  [AgentQueriedEvent.type]: AgentQueriedEvent;
}

export type AgentRegistryEvents = AgentRegistryEventMap;

export type AgentRegistryEventType = keyof AgentRegistryEventMap;

export interface AgentRegistry {
  register(entry: AgentRegistryEntry): void;
  unregister(name: string): void;
  get(name: string): AgentRegistryEntry | undefined;
  has(name: string): boolean;
  entries(): AgentRegistryEntry[];
  query(query: AgentRegistryQuery): AgentRegistryEntry[];
  addEventListener: <K extends AgentRegistryEventType>(
    type: K,
    listener: (event: AgentRegistryEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: <K extends AgentRegistryEventType>(
    type: K,
    listener: (event: AgentRegistryEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  on: <K extends AgentRegistryEventType>(type: K) => ObservableLike<AgentRegistryEventMap[K]>;
  once: <K extends AgentRegistryEventType>(
    type: K,
    listener: (event: AgentRegistryEventMap[K]) => void,
  ) => void;
  subscribe: <K extends AgentRegistryEventType>(
    type: K,
    observerOrNext?:
      | Observer<AgentRegistryEventMap[K]>
      | ((value: AgentRegistryEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<AgentRegistryEventMap[AgentRegistryEventType]>;
}

export function createAgentRegistry(): AgentRegistry {
  const store = new Map<string, AgentRegistryEntry>();
  const events = new CompletableEventTarget<AgentRegistryEventMap>();

  const registry: AgentRegistry = {
    register(entry: AgentRegistryEntry): void {
      const name = entry.agent.name;
      if (store.has(name)) {
        throw new Error(`Agent "${name}" is already registered`);
      }
      store.set(name, entry);
      events.dispatch(new AgentRegisteredEvent(name, entry));
    },

    unregister(name: string): void {
      store.delete(name);
      events.dispatch(new AgentUnregisteredEvent(name));
    },

    get(name: string): AgentRegistryEntry | undefined {
      return store.get(name);
    },

    has(name: string): boolean {
      return store.has(name);
    },

    entries(): AgentRegistryEntry[] {
      return [...store.values()];
    },

    query(query: AgentRegistryQuery): AgentRegistryEntry[] {
      let results = [...store.values()];

      if (query.text) {
        const lower = query.text.toLowerCase();
        results = results.filter((entry) => {
          const name = entry.agent.name.toLowerCase();
          const description = entry.description.toLowerCase();
          return name.includes(lower) || description.includes(lower);
        });
      }

      if (query.capabilities) {
        const caps = query.capabilities.map((c) => c.toLowerCase());
        results = results.filter((entry) => {
          const entryCaps = entry.capabilities.map((c) => c.toLowerCase());
          return caps.some((cap) => entryCaps.includes(cap));
        });
      }

      if (query.allCapabilities) {
        const caps = query.allCapabilities.map((c) => c.toLowerCase());
        results = results.filter((entry) => {
          const entryCaps = entry.capabilities.map((c) => c.toLowerCase());
          return caps.every((cap) => entryCaps.includes(cap));
        });
      }

      if (query.tags) {
        const queryTags = query.tags.map((t) => t.toLowerCase());
        results = results.filter((entry) => {
          const entryTags = (entry.tags ?? []).map((t) => t.toLowerCase());
          return queryTags.some((tag) => entryTags.includes(tag));
        });
      }

      if (query.predicate) {
        results = results.filter(query.predicate);
      }

      if (query.limit !== undefined && query.limit >= 0) {
        results = results.slice(0, query.limit);
      }

      events.dispatch(new AgentQueriedEvent(query, results));

      return results;
    },

    addEventListener: events.addEventListener.bind(events) as AgentRegistry['addEventListener'],
    removeEventListener: events.removeEventListener.bind(
      events,
    ) as AgentRegistry['removeEventListener'],
    on: events.on.bind(events) as AgentRegistry['on'],
    once: events.once.bind(events) as AgentRegistry['once'],
    subscribe: events.subscribe.bind(events) as AgentRegistry['subscribe'],
    toObservable: events.toObservable.bind(events) as AgentRegistry['toObservable'],
  };

  return registry;
}

export function createAgentDiscoveryTool(registry: AgentRegistry) {
  return createTool({
    name: 'discover-agents',
    description:
      'Discover available agents by searching their names, descriptions, capabilities, and tags.',
    input: z.object({
      text: z
        .string()
        .optional()
        .describe('Search text to match against agent names and descriptions.'),
      capabilities: z.array(z.string()).optional().describe('Filter by capabilities (any match).'),
      tags: z.array(z.string()).optional().describe('Filter by tags (any match).'),
    }),
    execute: ({ text, capabilities, tags }) => {
      const results = registry.query({ text, capabilities, tags });
      return Promise.resolve(
        JSON.stringify(
          results.map((entry) => ({
            name: entry.agent.name,
            description: entry.description,
            capabilities: entry.capabilities,
            tags: entry.tags ?? [],
          })),
        ),
      );
    },
  });
}
