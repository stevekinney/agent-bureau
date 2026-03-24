import type { SessionPersistenceAdapter } from 'conversationalist';
import { Conversation } from 'conversationalist';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { GenerateFunction, RunOptions, StopCondition, Toolbox } from 'operative';
import { createRun } from 'operative';
import type { Store } from 'sentinel';

import { serializeRunState } from '../serialization';
import type { CreateRunRequest, RunSummary } from '../types';

interface RunsDependencies {
  store: Store;
  generate: GenerateFunction | undefined;
  toolbox: Toolbox | undefined;
  persistence: SessionPersistenceAdapter | undefined;
  stopWhen: StopCondition | StopCondition[] | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
}

export function createRunsRoutes(dependencies: RunsDependencies) {
  const app = new Hono();

  app.post('/', async (context) => {
    if (!dependencies.generate) {
      throw new HTTPException(503, { message: 'No generate function configured' });
    }

    const body = await context.req.json<CreateRunRequest>();

    if (!body.message || typeof body.message !== 'string') {
      throw new HTTPException(400, { message: 'Request body must include a "message" string' });
    }

    let conversation: InstanceType<typeof Conversation>;

    if (body.conversationId && dependencies.persistence) {
      const history = await dependencies.persistence.load(body.conversationId);
      if (history) {
        conversation = new Conversation(history);
      } else {
        conversation = new Conversation();
      }
    } else {
      conversation = new Conversation();
    }

    const systemPrompt = body.systemPrompt ?? dependencies.systemPrompt;
    if (systemPrompt) {
      conversation.appendSystemMessage(systemPrompt);
    }
    conversation.appendUserMessage(body.message);

    const runOptions: RunOptions = {
      generate: dependencies.generate,
      toolbox:
        dependencies.toolbox ??
        ({
          tools: () => [],
          execute: () => Promise.resolve([]),
          toObservable: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
        } as unknown as Toolbox),
      conversation,
      maximumSteps: body.maximumSteps ?? dependencies.maximumSteps,
    };

    if (dependencies.stopWhen) {
      runOptions.stopWhen = dependencies.stopWhen;
    }

    const activeRun = createRun(runOptions);
    const runId = dependencies.store.register(activeRun);

    const summary: RunSummary = {
      id: runId,
      status: 'running',
      steps: 0,
      usage: { prompt: 0, completion: 0, total: 0 },
      finishReason: undefined,
      error: undefined,
      actionCount: 0,
    };

    return context.json(summary, 201);
  });

  app.get('/', (context) => {
    const statusFilter = context.req.query('status');
    const state = dependencies.store.getState();
    const summaries: RunSummary[] = [];

    for (const [, runState] of state.runs) {
      if (statusFilter && runState.status !== statusFilter) continue;
      summaries.push(serializeRunState(runState));
    }

    return context.json(summaries, 200);
  });

  app.get('/:id', (context) => {
    const runState = dependencies.store.getRun(context.req.param('id'));
    if (!runState) {
      throw new HTTPException(404, { message: 'Run not found' });
    }
    return context.json(serializeRunState(runState), 200);
  });

  app.post('/:id/abort', (context) => {
    const runState = dependencies.store.getRun(context.req.param('id'));
    if (!runState) {
      throw new HTTPException(404, { message: 'Run not found' });
    }
    if (runState.status !== 'running') {
      throw new HTTPException(409, { message: `Run is already ${runState.status}` });
    }
    runState.activeRun.abort('Aborted via API');
    return context.json({ id: runState.id, status: 'aborted' }, 200);
  });

  app.delete('/:id', (context) => {
    const runState = dependencies.store.getRun(context.req.param('id'));
    if (!runState) {
      throw new HTTPException(404, { message: 'Run not found' });
    }
    if (runState.status === 'running') {
      throw new HTTPException(409, { message: 'Cannot delete a running run' });
    }
    dependencies.store.removeRun(runState.id);
    return context.body(null, 204);
  });

  return app;
}
