import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { BureauError } from '../create-bureau';
import type { Bureau } from '../types';

export function createSessionsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.get('/', async (context) => {
    try {
      const sessions = await bureau.listSessions();
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
      const session = await bureau.getSession(context.req.param('id'));
      if (!session) throw new HTTPException(404, { message: 'Session not found' });
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
      await bureau.deleteSession(context.req.param('id'));
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
