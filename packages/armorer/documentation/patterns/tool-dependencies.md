# Tool Dependencies

Manage tool dependencies and execution order.

```typescript
import { createToolbox, createTool } from 'armorer';
import { z } from 'zod';

// Dependency graph
type DependencyGraph = Map<string, string[]>;

function createDependencyMiddleware(dependencies: DependencyGraph) {
  // Track completed tools per execution context
  const executionContexts = new WeakMap<any, Set<string>>();

  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: any) {
        // Get or create execution context
        if (!executionContexts.has(context)) {
          executionContexts.set(context, new Set());
        }
        const completed = executionContexts.get(context)!;

        // Check dependencies
        const deps = dependencies.get(toolName) ?? [];
        const missing = deps.filter((dep) => !completed.has(dep));

        if (missing.length > 0) {
          throw new Error(
            `Tool "${toolName}" requires dependencies: ${missing.join(', ')}`,
          );
        }

        // Execute
        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        const result = await executeFn(params, context);

        // Mark as completed
        completed.add(toolName);

        return result;
      },
    };
  });
}

// Define tools with dependencies
const authenticate = createTool({
  name: 'authenticate',
  description: 'Authenticate user',
  input: z.object({ username: z.string(), password: z.string() }),
  async execute({ username, password }) {
    return { token: 'abc123' };
  },
});

const fetchUserData = createTool({
  name: 'fetch-user-data',
  description: 'Fetch user data (requires auth)',
  input: z.object({ userId: z.string() }),
  async execute({ userId }) {
    return { id: userId, name: 'John Doe' };
  },
});

// Configure dependencies
const deps: DependencyGraph = new Map([
  ['fetch-user-data', ['authenticate']], // fetch-user-data depends on authenticate
]);

const toolbox = createToolbox([authenticate.configuration, fetchUserData.configuration], {
  middleware: [createDependencyMiddleware(deps)],
});

// Usage - must authenticate first
const sharedContext = {};
await toolbox.execute({
  name: 'authenticate',
  arguments: { username: 'user', password: 'pass' },
});
await toolbox.execute({
  name: 'fetch-user-data',
  arguments: { userId: '123' },
});
```

## Automatic Dependency Resolution

```typescript
async function executeDependencyChain(
  toolbox: Toolbox,
  toolName: string,
  params: unknown,
  dependencies: DependencyGraph,
  completed: Set<string> = new Set(),
): Promise<unknown> {
  // Already executed
  if (completed.has(toolName)) {
    return;
  }

  // Execute dependencies first
  const deps = dependencies.get(toolName) ?? [];
  for (const dep of deps) {
    await executeDependencyChain(toolbox, dep, {}, dependencies, completed);
  }

  // Execute this tool
  const result = await toolbox.execute({
    name: toolName,
    arguments: params,
  });
  completed.add(toolName);

  return result;
}

// Usage
const result = await executeDependencyChain(
  toolbox,
  'fetch-user-data',
  { userId: '123' },
  deps,
);
```
