import { expect, test } from 'bun:test';

import {
  appendStreamingMessage,
  cancelStreamingMessage,
  conversationSchema,
  CURRENT_SCHEMA_VERSION,
  finalizeStreamingMessage,
  rewindBeforeMessage,
  rewindBeforePosition,
  type ToMarkdownOptions,
  type ToolCallPair,
  updateStreamingMessage,
} from './index';

test('exports the browser safe conversation API from the package root', () => {
  expect(typeof appendStreamingMessage).toBe('function');
  expect(typeof cancelStreamingMessage).toBe('function');
  expect(typeof finalizeStreamingMessage).toBe('function');
  expect(typeof updateStreamingMessage).toBe('function');
  expect(typeof rewindBeforeMessage).toBe('function');
  expect(typeof rewindBeforePosition).toBe('function');
  expect(typeof conversationSchema.safeParse).toBe('function');
  expect(typeof CURRENT_SCHEMA_VERSION).toBe('number');

  const markdownOptions: ToMarkdownOptions = {};
  const toolCallPairs: ToolCallPair[] = [];
  expect(markdownOptions).toEqual({});
  expect(toolCallPairs).toEqual([]);
});

test('builds the package root for browsers without emitted artifacts', async () => {
  const buildOptions: Bun.BuildConfig = {
    entrypoints: [new URL('./index.ts', import.meta.url).pathname],
    target: 'browser',
  };
  Object.assign(buildOptions, { write: false });

  const result = await Bun.build(buildOptions);

  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
});
