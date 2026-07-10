import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { resolvePrincipal } from '../middleware/authentication';
import type { Bureau, CreateRunRequest } from '../types';

export function createRunsRoutes(bureau: Bureau) {
  const app = new Hono();

  app.post('/', async (context) => {
    let body: CreateRunRequest;
    try {
      body = await context.req.json<CreateRunRequest>();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }
    try {
      // Overwrite any caller-supplied `principal` with the authenticated
      // principal from the verified request header — never trust it from an
      // untrusted request body (AB-54 usage analytics attribution).
      const summary = await bureau.createRun({ ...body, principal: resolvePrincipal(context) });
      return context.json(summary, 201);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_CONFIGURED')
          throw new HTTPException(503, { message: error.message });
        if (error.code === 'BAD_REQUEST') throw new HTTPException(400, { message: error.message });
      }
      throw error;
    }
  });

  app.get('/', (context) => {
    const status = context.req.query('status');
    return context.json(bureau.listRuns(status), 200);
  });

  app.get('/:id', (context) => {
    const run = bureau.getRun(context.req.param('id'));
    if (!run) throw new HTTPException(404, { message: 'Run not found' });
    return context.json(run, 200);
  });

  app.post('/:id/abort', (context) => {
    try {
      const run = bureau.abortRun(context.req.param('id'));
      return context.json(run, 200);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.delete('/:id', (context) => {
    try {
      bureau.deleteRun(context.req.param('id'));
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof BureauError) {
        if (error.code === 'NOT_FOUND') throw new HTTPException(404, { message: error.message });
        if (error.code === 'CONFLICT') throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  return app;
}
