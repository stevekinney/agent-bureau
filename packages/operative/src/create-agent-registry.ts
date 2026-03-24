import { createTool } from 'armorer';
import type { AddEventListenerOptionsLike, EmissionEvent } from 'event-emission';
import { createEventTarget } from 'event-emission';
import type { ObservableLike, Observer, Subscription } from 'event-emission/types';
import { z } from 'zod';

import { bindEmitter } from './bind-emitter';
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

export interface AgentRegistryEvents {
  'agent.registered': { name: string; entry: AgentRegistryEntry };
  'agent.unregistered': { name: string };
  'agent.queried': { query: AgentRegistryQuery; results: AgentRegistryEntry[] };
}

export type AgentRegistryEventType = keyof AgentRegistryEvents;

export interface AgentRegistry {
  register(entry: AgentRegistryEntry): void;
  unregister(name: string): void;
  get(name: string): AgentRegistryEntry | undefined;
  has(name: string): boolean;
  entries(): AgentRegistryEntry[];
  query(query: AgentRegistryQuery): AgentRegistryEntry[];
  addEventListener: <K extends AgentRegistryEventType>(
    type: K,
    listener: (event: EmissionEvent<AgentRegistryEvents[K], K>) => void | Promise<void>,
    options?: AddEventListenerOptionsLike,
  ) => () => void;
  on: <K extends AgentRegistryEventType>(
    type: K,
    listener: (event: EmissionEvent<AgentRegistryEvents[K], K>) => void | Promise<void>,
  ) => () => void;
  once: <K extends AgentRegistryEventType>(
    type: K,
    listener: (event: EmissionEvent<AgentRegistryEvents[K], K>) => void | Promise<void>,
    options?: Omit<AddEventListenerOptionsLike, 'once'>,
  ) => () => void;
  subscribe: <K extends AgentRegistryEventType>(
    type: K,
    observerOrNext?:
      | Observer<EmissionEvent<AgentRegistryEvents[K], K>>
      | ((value: EmissionEvent<AgentRegistryEvents[K], K>) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ) => Subscription;
  toObservable: () => ObservableLike<
    EmissionEvent<AgentRegistryEvents[AgentRegistryEventType], AgentRegistryEventType>
  >;
}

export function createAgentRegistry(): AgentRegistry {
  const store = new Map<string, AgentRegistryEntry>();
  const events = createEventTarget<AgentRegistryEvents>();

  const registry: AgentRegistry = {
    register(entry: AgentRegistryEntry): void {
      const name = entry.agent.name;
      if (store.has(name)) {
        throw new Error(`Agent "${name}" is already registered`);
      }
      store.set(name, entry);
      events.emit('agent.registered', { name, entry });
    },

    unregister(name: string): void {
      store.delete(name);
      events.emit('agent.unregistered', { name });
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

      events.emit('agent.queried', { query, results });

      return results;
    },

    ...bindEmitter<AgentRegistryEvents>(events),
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
