import { Hono } from 'hono';

import type { Bureau, ProviderConfiguration, RunDetail, RunSummary } from '../types';
import { renderPage } from './render';

interface PageDependencies {
  bureau: Bureau;
  provider: Omit<ProviderConfiguration, 'apiKey'> | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
}

function Dashboard({ runs }: { runs: RunSummary[] }) {
  return (
    <main>
      <h1>Dashboard</h1>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <a href={`/runs/${run.id}`}>
              {run.id} — {run.status} ({run.steps} steps)
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

function RunDetail({ run }: { run: RunDetail }) {
  return (
    <main>
      <h1>Run {run.id}</h1>
      <dl>
        <dt>Status</dt>
        <dd>{run.status}</dd>
        <dt>Steps</dt>
        <dd>{run.steps}</dd>
        <dt>Usage</dt>
        <dd>
          prompt: {run.usage.prompt}, completion: {run.usage.completion}, total: {run.usage.total}
        </dd>
      </dl>
    </main>
  );
}

function Configuration({
  provider,
  maximumSteps,
  systemPrompt,
}: {
  provider: Omit<ProviderConfiguration, 'apiKey'> | undefined;
  maximumSteps: number;
  systemPrompt: string | undefined;
}) {
  return (
    <main>
      <h1>Configuration</h1>
      <dl>
        <dt>Provider</dt>
        <dd>{provider ? `${provider.provider} / ${provider.model}` : 'Not configured'}</dd>
        <dt>Maximum Steps</dt>
        <dd>{maximumSteps}</dd>
        <dt>System Prompt</dt>
        <dd>{systemPrompt ?? 'None'}</dd>
      </dl>
    </main>
  );
}

function Chat() {
  return (
    <main>
      <h1>Chat</h1>
      <form>
        <label htmlFor="message">Message</label>
        <textarea id="message" name="message" rows={4} />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

export function createPages(dependencies: PageDependencies) {
  const app = new Hono();

  app.get('/', (context) => {
    return context.redirect('/dashboard');
  });

  app.get('/dashboard', async () => {
    const runs: RunSummary[] = dependencies.bureau.listRuns();

    const stream = await renderPage({
      title: 'Dashboard',
      data: { runs },
      content: <Dashboard runs={runs} />,
    });

    return new Response(stream, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  app.get('/runs/:id', async (context) => {
    const run = dependencies.bureau.getRun(context.req.param('id'));
    if (!run) {
      return context.text('Run not found', 404);
    }
    const stream = await renderPage({
      title: `Run ${run.id}`,
      data: { run },
      content: <RunDetail run={run} />,
    });

    return new Response(stream, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  app.get('/configuration', async () => {
    const data = {
      provider: dependencies.provider,
      maximumSteps: dependencies.maximumSteps,
      systemPrompt: dependencies.systemPrompt,
    };

    const stream = await renderPage({
      title: 'Configuration',
      data,
      content: (
        <Configuration
          provider={dependencies.provider}
          maximumSteps={dependencies.maximumSteps}
          systemPrompt={dependencies.systemPrompt}
        />
      ),
    });

    return new Response(stream, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  app.get('/chat', async () => {
    const stream = await renderPage({
      title: 'Chat',
      data: {},
      content: <Chat />,
    });

    return new Response(stream, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  return app;
}
