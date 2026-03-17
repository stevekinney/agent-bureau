# State Management

Maintain persistent state across tool executions.

```typescript
import { createToolbox, createTool } from 'armorer';
import { z } from 'zod';

// State store
class StateStore {
  private state = new Map<string, any>();

  get<T>(key: string): T | undefined {
    return this.state.get(key);
  }

  set<T>(key: string, value: T): void {
    this.state.set(key, value);
  }

  update<T>(key: string, updater: (current: T | undefined) => T): void {
    const current = this.state.get(key);
    this.state.set(key, updater(current));
  }

  delete(key: string): void {
    this.state.delete(key);
  }

  clear(): void {
    this.state.clear();
  }

  toJSON(): Record<string, any> {
    return Object.fromEntries(this.state);
  }

  fromJSON(data: Record<string, any>): void {
    this.state = new Map(Object.entries(data));
  }
}

// Create stateful tools
const stateStore = new StateStore();

const setCounter = createTool({
  name: 'set-counter',
  description: 'Set counter value',
  input: z.object({ value: z.number() }),
  async execute({ value }, context) {
    const { stateStore } = context as { stateStore: StateStore };
    stateStore.set('counter', value);
    return { counter: value };
  },
});

const incrementCounter = createTool({
  name: 'increment-counter',
  description: 'Increment counter',
  input: z.object({ by: z.number().optional() }),
  async execute({ by = 1 }, context) {
    const { stateStore } = context as { stateStore: StateStore };
    stateStore.update<number>('counter', (current = 0) => current + by);
    return { counter: stateStore.get('counter') };
  },
});

const getCounter = createTool({
  name: 'get-counter',
  description: 'Get counter value',
  input: z.object({}),
  async execute(_params, context) {
    const { stateStore } = context as { stateStore: StateStore };
    return { counter: stateStore.get('counter') ?? 0 };
  },
});

// Create toolbox with state
const toolbox = createToolbox(
  [setCounter.configuration, incrementCounter.configuration, getCounter.configuration],
  {
    context: { stateStore },
  },
);

// Usage
await toolbox.execute({ name: 'set-counter', arguments: { value: 10 } });
await toolbox.execute({ name: 'increment-counter', arguments: { by: 5 } });
const result = await toolbox.execute({ name: 'get-counter', arguments: {} });
console.log(result.result); // { counter: 15 }

// Persist state
const snapshot = stateStore.toJSON();
// ... save to file or database

// Restore state
stateStore.fromJSON(snapshot);
```

## State Middleware with Auto-Persistence

```typescript
function createStatePersistenceMiddleware(
  stateStore: StateStore,
  persistFn: (state: Record<string, any>) => Promise<void>,
  debounceMs = 1000,
) {
  let timer: NodeJS.Timeout | undefined;

  const schedulePersist = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await persistFn(stateStore.toJSON());
    }, debounceMs);
  };

  return createMiddleware((toolConfiguration) => {
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: unknown) {
        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        const result = await executeFn(params, context);

        // Schedule persistence after state change
        schedulePersist();

        return result;
      },
    };
  });
}

// Usage with file persistence
const toolbox = createToolbox([], {
  middleware: [
    createStatePersistenceMiddleware(
      stateStore,
      async (state) => {
        await Bun.write('state.json', JSON.stringify(state));
      },
      5000, // persist every 5 seconds after changes
    ),
  ],
});
```
