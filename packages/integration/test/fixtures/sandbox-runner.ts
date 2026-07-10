/**
 * AB-97 — minimal runner bundled with `bun build --target=bun` into a
 * single file and executed as a child process against a mock Anthropic
 * Messages endpoint.
 *
 * This is the smallest realistic "embed the bureau in a sandbox image"
 * shape: `armorer`'s read-only coding toolbox (jailed to a declared root),
 * `operative`'s agent loop, and the Anthropic provider — driven entirely by
 * environment variables, with no dependency on `gateway` or `bureau`. It
 * exists to be bundled, not imported; `sandbox-embedding.test.ts` is the
 * only consumer.
 *
 * Env contract (all required):
 * - `SANDBOX_RUNNER_ROOT`     — directory the coding toolbox is jailed to.
 * - `SANDBOX_RUNNER_BASE_URL` — Anthropic-compatible base URL (the mock).
 * - `SANDBOX_RUNNER_API_KEY`  — placeholder credential forwarded verbatim.
 *
 * On completion, prints one JSON line to stdout: `{ content, toolCallCount }`.
 * Installs SIGTERM/SIGINT handlers that exit 0 immediately — the same
 * "signal in, clean exit out" shape `packages/gateway/src/start.ts` uses
 * (AB-96), scaled down to a process with no server or storage to close.
 */
import { createToolbox } from 'armorer';
import { createCodingToolbox } from 'armorer/coding';
import { Conversation } from 'conversationalist';
import { createActiveRun, stopWhen } from 'operative';
import { createAnthropicProvider } from 'operative/anthropic';

/**
 * Reads a required env var, treating a blank/whitespace-only value the same
 * as unset — matching `gateway/src/start.ts`'s `optionalString()` handling
 * (a whitespace-only `SANDBOX_RUNNER_ROOT` is not a usable jail root).
 */
function requireEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const root = requireEnv('SANDBOX_RUNNER_ROOT');
  const baseURL = requireEnv('SANDBOX_RUNNER_BASE_URL');
  const apiKey = requireEnv('SANDBOX_RUNNER_API_KEY');

  const toolbox = createToolbox(createCodingToolbox({ root }));

  const generate = createAnthropicProvider({
    model: 'claude-3-5-sonnet-20241022',
    apiKey,
    baseURL,
  });

  const conversation = new Conversation();
  conversation.appendUserMessage('Read manifest.txt and tell me what it says.');

  const result = await createActiveRun({
    generate,
    toolbox,
    conversation,
    stopWhen: stopWhen.noToolCalls(),
  }).result;

  const toolCallCount = result.steps.reduce((count, step) => count + step.results.length, 0);
  console.log(JSON.stringify({ content: result.content, toolCallCount }));
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[sandbox-runner] received ${signal}, exiting`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await main();
