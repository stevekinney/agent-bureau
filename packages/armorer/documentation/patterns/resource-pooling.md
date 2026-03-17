# Resource Pooling

Manage shared resources like database connections or API clients.

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

// Generic resource pool
class ResourcePool<T> {
  private available: T[] = [];
  private inUse = new Set<T>();
  private waiting: Array<(resource: T) => void> = [];

  constructor(
    private factory: () => Promise<T>,
    private maxSize: number,
  ) {}

  async acquire(): Promise<T> {
    // Try to get available resource
    if (this.available.length > 0) {
      const resource = this.available.pop()!;
      this.inUse.add(resource);
      return resource;
    }

    // Create new resource if under limit
    if (this.inUse.size < this.maxSize) {
      const resource = await this.factory();
      this.inUse.add(resource);
      return resource;
    }

    // Wait for resource to become available
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(resource: T): void {
    this.inUse.delete(resource);

    // Give to waiting consumer if any
    const waiter = this.waiting.shift();
    if (waiter) {
      this.inUse.add(resource);
      waiter(resource);
    } else {
      this.available.push(resource);
    }
  }

  async dispose(): Promise<void> {
    // Clean up all resources
    this.available = [];
    this.inUse.clear();
    this.waiting = [];
  }
}

// Example: Database connection pool
interface DbConnection {
  query: (sql: string) => Promise<any>;
  close: () => Promise<void>;
}

const dbPool = new ResourcePool<DbConnection>(
  async () => {
    // Create connection (example)
    return {
      query: async (sql: string) => {
        /* ... */
      },
      close: async () => {
        /* ... */
      },
    };
  },
  10, // max 10 connections
);

// Create tools that use the pool
const queryDatabase = createTool({
  name: 'query-database',
  description: 'Execute a database query',
  input: z.object({ sql: z.string() }),
  async execute({ sql }, context) {
    const { dbPool } = context as { dbPool: ResourcePool<DbConnection> };
    const connection = await dbPool.acquire();

    try {
      return await connection.query(sql);
    } finally {
      dbPool.release(connection);
    }
  },
});

// Pass pool via context
const toolbox = createToolbox([queryDatabase.configuration], {
  context: { dbPool },
});

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  await dbPool.dispose();
});
```

## Resource Cleanup with Tool Lifecycle

```typescript
// Create a tool with cleanup logic
function createResourceTool<TInput extends object, TOutput>(configuration: {
  name: string;
  description: string;
  input: z.ZodType<TInput>;
  setup: () => Promise<unknown>;
  execute: (params: TInput, resource: unknown) => Promise<TOutput>;
  teardown: (resource: unknown) => Promise<void>;
}) {
  let resource: unknown;
  let setupPromise: Promise<void> | undefined;

  const tool = createTool({
    name: configuration.name,
    description: configuration.description,
    input: configuration.input,
    async execute(params) {
      // Lazy setup on first use
      if (!resource && !setupPromise) {
        setupPromise = configuration.setup().then((r) => {
          resource = r;
        });
      }
      if (setupPromise) {
        await setupPromise;
      }

      return configuration.execute(params, resource);
    },
  });

  // Add cleanup method
  (tool as any).cleanup = async () => {
    if (resource) {
      await configuration.teardown(resource);
      resource = undefined;
      setupPromise = undefined;
    }
  };

  return tool;
}

// Usage
const dbTool = createResourceTool({
  name: 'database-tool',
  description: 'Tool with database connection',
  input: z.object({ query: z.string() }),
  setup: async () => {
    console.log('Opening database connection...');
    return {
      /* connection */
    };
  },
  execute: async ({ query }, connection) => {
    // Use connection
    return { result: 'data' };
  },
  teardown: async (connection) => {
    console.log('Closing database connection...');
    // Close connection
  },
});

// Cleanup
await (dbTool as any).cleanup();
```
