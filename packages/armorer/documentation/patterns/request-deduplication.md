# Request Deduplication

Prevent duplicate requests from executing simultaneously using cache middleware.

```typescript
import { createCacheMiddleware } from 'armorer/middleware';

// Create a deduplication middleware that holds in-flight requests
function createDeduplicationMiddleware() {
  const inFlight = new Map<string, Map<string, Promise<unknown>>>();

  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: unknown) {
        // Generate request key
        const requestKey = JSON.stringify(params);

        // Initialize map for this tool
        if (!inFlight.has(toolName)) {
          inFlight.set(toolName, new Map());
        }
        const toolRequests = inFlight.get(toolName)!;

        // Check if request is already in-flight
        if (toolRequests.has(requestKey)) {
          return toolRequests.get(requestKey)!;
        }

        // Execute request and store promise
        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        const promise = executeFn(params, context).finally(() => {
          // Remove from in-flight when complete
          toolRequests.delete(requestKey);
        });

        toolRequests.set(requestKey, promise);
        return promise;
      },
    };
  });
}

// Combine with caching for complete deduplication + persistence
const toolbox = createToolbox([], {
  middleware: [
    createDeduplicationMiddleware(), // Dedupe concurrent requests
    createCacheMiddleware({ ttlMs: 60000 }), // Cache results
  ],
});
```
