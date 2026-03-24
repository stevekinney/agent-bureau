import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { BureauError } from '../create-bureau';
import type { Bureau } from '../types';

export function createConversationsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', async (context) => {
    try {
      const sessions = await bureau.listConversations();
      return context.json(sessions, 200);
    } catch (error) {
      if (error instanceof BureauError && error.code === 'NOT_IMPLEMENTED') {
        throw new HTTPException(501, { message: error.message });
      }
      throw error;
    }
  });

  app.get('/:id', async (context) => {
    try {
      const session = await bureau.getConversation(context.req.param('id'));
      if (!session) throw new HTTPException(404, { message: 'Conversation not found' });
      return context.json(session, 200);
    } catch (error) {
      if (error instanceof BureauError && error.code === 'NOT_IMPLEMENTED') {
        throw new HTTPException(501, { message: error.message });
      }
      throw error;
    }
  });

  app.delete('/:id', async (context) => {
    try {
      await bureau.deleteConversation(context.req.param('id'));
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof BureauError && error.code === 'NOT_IMPLEMENTED') {
        throw new HTTPException(501, { message: error.message });
      }
      throw error;
    }
  });

  return app;
}
