# Fallback Tools

Implement graceful degradation with fallback tools.

```typescript
import { createTool, createMiddleware } from 'armorer';
import { when } from 'armorer/utilities';
import { z } from 'zod';

// Create a fallback middleware
function createFallbackMiddleware(fallbacks: Map<string, string>) {
  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: any) {
        try {
          const executeFn =
            typeof originalExecute === 'function'
              ? originalExecute
              : await originalExecute;

          return await executeFn(params, context);
        } catch (error) {
          // Check for fallback
          const fallbackName = fallbacks.get(toolName);
          if (fallbackName && context.toolbox) {
            console.warn(`Tool "${toolName}" failed, trying fallback "${fallbackName}"`);
            return context.toolbox.execute({
              name: fallbackName,
              arguments: params,
            });
          }
          throw error;
        }
      },
    };
  });
}

// Define primary and fallback tools
const fetchFromApi = createTool({
  name: 'fetch-from-api',
  description: 'Fetch data from external API',
  input: z.object({ endpoint: z.string() }),
  async execute({ endpoint }) {
    // Might fail due to network issues
    const response = await fetch(endpoint);
    return response.json();
  },
});

const fetchFromCache = createTool({
  name: 'fetch-from-cache',
  description: 'Fetch data from cache',
  input: z.object({ endpoint: z.string() }),
  async execute({ endpoint }) {
    // Fallback to cached data
    return { cached: true, data: {} };
  },
});

// Configure fallbacks
const toolbox = createToolbox(
  [fetchFromApi.configuration, fetchFromCache.configuration],
  {
    middleware: [
      createFallbackMiddleware(new Map([['fetch-from-api', 'fetch-from-cache']])),
    ],
  },
);
```

## Fallback Chain with `when`

```typescript
import { when } from 'armorer/utilities';

// Create a tool that tries primary, falls back to secondary
const resilientFetch = when(
  async (params) => {
    try {
      return await fetchFromApi(params);
    } catch {
      return undefined; // Signal to use fallback
    }
  },
  fetchFromApi,
  fetchFromCache, // Used if condition returns falsy
);

// Usage
const result = await resilientFetch({ endpoint: '/api/data' });
```
