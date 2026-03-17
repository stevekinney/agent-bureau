# Context and withContext

## Overview

Armorer has two primary ways to provide runtime context to tools:

- `createToolbox({ context })`: injects shared values for all tools executed through that toolbox.
- `withContext(context, options?)`: injects values for a single tool or a reusable tool factory.

You can also pass per-call execution controls (`signal`, `timeout`) when executing a tool.

## ToolContext

Every tool execute function receives a `ToolContext`, including:

- `dispatch`: emit tool events.
- `meta`: generic metadata bag for runtime use.
- `toolCall`: normalized tool call (`id`, `name`, `arguments`).
- `configuration`: the resolved tool configuration.
- `signal`: optional `AbortSignal`.
- `timeout`: optional timeout in milliseconds.

Example:

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

const echo = createTool({
  name: 'echo',
  description: 'Echo text',
  input: z.object({ text: z.string() }),
  async execute({ text }, context) {
    context.dispatch({
      type: 'progress',
      detail: { percent: 50, message: 'Echoing text' },
    });

    return {
      callId: context.toolCall.id,
      text,
    };
  },
});
```

## Shared Toolbox Context

Use `createToolbox({ context })` when values should be available to many tools:

```typescript
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox([], {
  context: {
    userId: 'user-123',
    sessionId: 'session-456',
  },
});

toolbox.register(
  createTool({
    name: 'whoami',
    description: 'Return user/session identity',
    input: z.object({}),
    async execute(_params, context) {
      return {
        userId: context.userId,
        sessionId: context.sessionId,
      };
    },
  }),
);
```

## withContext

Use `withContext` when you want tool-local context injection without requiring toolbox-level context:

```typescript
import { withContext } from 'armorer';
import { z } from 'zod';

const createAuthedTool = withContext({
  apiKey: process.env.API_KEY,
  region: 'us-east-1',
});

const listProjects = createAuthedTool({
  name: 'list-projects',
  description: 'List projects for current account',
  input: z.object({ accountId: z.string() }),
  async execute({ accountId }, context) {
    return fetchProjects({
      accountId,
      apiKey: context.apiKey,
      region: context.region,
    });
  },
});
```

You can also call `withContext(context, options)` directly to create one tool immediately.

## Choosing Between Them

- Use `createToolbox({ context })` for shared runtime/session state across many tools.
- Use `withContext` for reusable tool builders or tool-specific dependencies.
- Use both when needed: toolbox context for global state and `withContext` for per-tool wiring.

## Precedence and Merge Behavior

When using `withContext`, injected context is merged into runtime tool context and can override keys with the same name. Avoid key collisions with base context keys like `dispatch`, `toolCall`, `configuration`, `signal`, and `timeout`.
