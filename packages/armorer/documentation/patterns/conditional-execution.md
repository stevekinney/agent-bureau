# Conditional Execution

Execute tools based on runtime conditions.

```typescript
import { when } from 'armorer/utilities';
import { createTool } from 'armorer';
import { z } from 'zod';

// Conditional execution with `when`
const checkCache = createTool({
  name: 'check-cache',
  description: 'Check if data is cached',
  input: z.object({ key: z.string() }),
  async execute({ key }) {
    const cache = new Map();
    return cache.get(key);
  },
});

const fetchFromApi = createTool({
  name: 'fetch-from-api',
  description: 'Fetch from API',
  input: z.object({ key: z.string() }),
  async execute({ key }) {
    return { data: 'fresh-data' };
  },
});

// Use cache if available, otherwise fetch
const getData = when(
  async (params) => {
    const cached = await checkCache(params);
    return cached !== undefined;
  },
  checkCache,
  fetchFromApi,
);

// Usage
const result = await getData({ key: 'user-data' });
```

## Multi-way Branching

```typescript
async function branch<TInput extends object, TOutput>(
  params: TInput,
  branches: Array<{
    condition: (params: TInput) => boolean | Promise<boolean>;
    tool: (params: TInput) => Promise<TOutput>;
  }>,
  defaultTool?: (params: TInput) => Promise<TOutput>,
): Promise<TOutput> {
  for (const { condition, tool } of branches) {
    if (await condition(params)) {
      return tool(params);
    }
  }

  if (defaultTool) {
    return defaultTool(params);
  }

  throw new Error('No matching branch found');
}

// Usage
const result = await branch(
  { amount: 1000 },
  [
    {
      condition: (p) => p.amount > 10000,
      tool: async (p) => processLargeTransaction(p),
    },
    {
      condition: (p) => p.amount > 1000,
      tool: async (p) => processMediumTransaction(p),
    },
  ],
  async (p) => processSmallTransaction(p), // default
);
```
