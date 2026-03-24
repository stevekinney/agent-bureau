import type { SessionPersistenceAdapter } from 'conversationalist';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

interface ConversationsDependencies {
  persistence: SessionPersistenceAdapter | undefined;
}

export function createConversationsRoutes(dependencies: ConversationsDependencies) {
  const app = new Hono();

  function requirePersistence(): SessionPersistenceAdapter {
    if (!dependencies.persistence) {
      throw new HTTPException(501, { message: 'No persistence adapter configured' });
    }
    return dependencies.persistence;
  }

  app.get('/', async (context) => {
    const adapter = requirePersistence();
    const sessions = await adapter.list();
    return context.json(sessions, 200);
  });

  app.get('/:id', async (context) => {
    const adapter = requirePersistence();
    const session = await adapter.load(context.req.param('id'));
    if (!session) {
      throw new HTTPException(404, { message: 'Conversation not found' });
    }
    return context.json(session, 200);
  });

  app.delete('/:id', async (context) => {
    const adapter = requirePersistence();
    await adapter.delete(context.req.param('id'));
    return context.body(null, 204);
  });

  return app;
}
