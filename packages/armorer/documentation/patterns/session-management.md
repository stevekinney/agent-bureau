# Session Management

Maintain conversation context and user sessions across tool executions.

```typescript
import { createToolbox, createTool, withContext } from 'armorer';
import { z } from 'zod';

// Session store interface
interface Session {
  id: string;
  userId: string;
  conversationHistory: Array<{ role: string; content: string }>;
  toolInvocations: Array<{ name: string; timestamp: number }>;
  metadata: Record<string, unknown>;
}

class SessionManager {
  private sessions = new Map<string, Session>();

  createSession(userId: string): Session {
    const session: Session = {
      id: crypto.randomUUID(),
      userId,
      conversationHistory: [],
      toolInvocations: [],
      metadata: {},
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
    }
  }

  addMessage(sessionId: string, role: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.conversationHistory.push({ role, content });
    }
  }

  trackToolInvocation(sessionId: string, toolName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.toolInvocations.push({ name: toolName, timestamp: Date.now() });
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// Create session-aware toolbox
const sessionManager = new SessionManager();

const toolbox = createToolbox([], {
  context: { sessionManager },
  policy: {
    async beforeExecute(context) {
      const sessionId = context.params?.sessionId;
      if (!sessionId) {
        return { allow: false, reason: 'Missing sessionId' };
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { allow: false, reason: 'Invalid session' };
      }

      // Track tool invocation
      sessionManager.trackToolInvocation(sessionId, context.toolName);
      return { allow: true };
    },
  },
});

// Create session-aware tool
const getUserPreferences = createTool(
  {
    name: 'get-user-preferences',
    description: 'Get user preferences from session',
    input: z.object({ sessionId: z.string() }),
    async execute({ sessionId }, context) {
      const { sessionManager } = context as { sessionManager: SessionManager };
      const session = sessionManager.getSession(sessionId);
      return session?.metadata.preferences ?? {};
    },
  },
  toolbox,
);

// Usage
const session = sessionManager.createSession('user-123');
session.metadata.preferences = { theme: 'dark', language: 'en' };

const result = await toolbox.execute({
  name: 'get-user-preferences',
  arguments: { sessionId: session.id },
});
```

## Session Middleware

Automatically inject session context into all tools:

```typescript
function createSessionMiddleware(sessionManager: SessionManager) {
  return createMiddleware((toolConfiguration) => {
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: any, context: any) {
        // Extract session ID from params
        const sessionId = params?.sessionId;
        if (!sessionId) {
          throw new Error('Session ID required');
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Invalid session');
        }

        // Inject session into context
        const enhancedContext = {
          ...context,
          session,
        };

        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        return executeFn(params, enhancedContext);
      },
    };
  });
}

// Usage
const toolbox = createToolbox([], {
  middleware: [createSessionMiddleware(sessionManager)],
});

const tool = createTool(
  {
    name: 'session-aware-tool',
    description: 'Access session automatically',
    input: z.object({
      sessionId: z.string(),
      action: z.string(),
    }),
    async execute({ action }, context) {
      const { session } = context as { session: Session };
      console.log(`User ${session.userId} performed: ${action}`);
      return { success: true };
    },
  },
  toolbox,
);
```
