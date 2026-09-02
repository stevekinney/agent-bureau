/**
 * A standalone module for AB-23's `createLazyAgent`/dynamic-import coverage
 * in `bureau-agent-definitions.test.ts` — exists as a real, separate file so
 * `createLazyAgent(() => import('./bureau-lazy-agent-module'))` is a genuine
 * dynamic import, not an in-file synchronous stand-in.
 */
import { createAgent } from '@lostgradient/operative';
import { z } from 'zod';

export const echoOutputSchema = z.object({ echoed: z.string() });

function deterministicGenerate() {
  return async () => ({
    content: JSON.stringify({ echoed: 'from the lazily-loaded module' }),
    toolCalls: [],
    usage: { prompt: 4, completion: 4, total: 8 },
  });
}

function buildAgent() {
  return createAgent({
    name: 'lazy-module-agent',
    generate: deterministicGenerate(),
    instructions: 'You are a deterministic echo agent loaded from a lazy module.',
    output: echoOutputSchema,
    stopWhen: (context) => context.step >= 1,
  });
}

// Default export — the shape createLazyAgent's bare `import(path)` unwraps.
export default buildAgent();
