import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createToolbox } from 'armorer';
import { parseAnthropicToolCalls } from 'armorer/adapters/anthropic';
import { parseGeminiToolCalls } from 'armorer/adapters/gemini';
import { parseOpenAIToolCalls } from 'armorer/adapters/openai';
import { createToolboxRecorder } from 'armorer/test';
import {
  Conversation,
  createConversationHistory,
  deserializeConversationHistory,
} from 'conversationalist';
import {
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
  appendUserMessage,
  getMessages,
  materializeToolCalls,
} from 'conversationalist/conversation';
import { createConversationRecorder } from 'conversationalist/test';
import { createIntegrationHarness, getToolCalls, getToolResults } from './runtime-helpers.mjs';

async function appendProviderTurn(conversation, provider, payload, environment) {
  const runtime = new Conversation(conversation, environment);
  await runtime.appendProvider(provider, payload);
  return runtime.current;
}

async function exportProvider(conversation, provider, environment, options) {
  const runtime = new Conversation(conversation, environment);
  return runtime.toProvider(provider, options);
}

function materializeParsedToolCalls(toolCalls, environment) {
  return materializeToolCalls(toolCalls, {
    generateId: environment.randomId,
  });
}

async function executeToolTurn(
  conversation,
  parsedToolCalls,
  toolbox,
  environment,
  options = {},
) {
  const toolCalls = materializeParsedToolCalls(parsedToolCalls, environment);
  const withCalls = appendToolCalls(conversation, toolCalls, environment);
  const results = await toolbox.execute(toolCalls, options.executeOptions);
  const withResults = options.collectAsync
    ? await appendToolResultsAsync(withCalls, results, environment)
    : appendToolResults(withCalls, results, environment);

  return {
    conversation: withResults,
    toolCalls,
    results,
  };
}

describe('published integration surface', () => {
  it('loads canonical root exports and subpaths from both packages', async () => {
    const armorerRoot = await import('armorer');
    const armorerOpenAI = await import('armorer/adapters/openai');
    const armorerAnthropic = await import('armorer/adapters/anthropic');
    const armorerGemini = await import('armorer/adapters/gemini');
    const armorerTest = await import('armorer/test');

    const conversationalistRoot = await import('conversationalist');
    const conversationalistConversation = await import(
      'conversationalist/conversation'
    );
    const conversationalistOpenAI = await import(
      'conversationalist/adapters/openai'
    );
    const conversationalistAnthropic = await import(
      'conversationalist/adapters/anthropic'
    );
    const conversationalistGemini = await import(
      'conversationalist/adapters/gemini'
    );
    const conversationalistTest = await import('conversationalist/test');

    assert.equal(typeof armorerRoot.createToolbox, 'function');
    assert.equal(typeof armorerRoot.materializeToolCalls, 'function');
    assert.equal(typeof armorerOpenAI.openAIToolAdapter.export, 'function');
    assert.equal(typeof armorerAnthropic.anthropicToolAdapter.parseCalls, 'function');
    assert.equal(typeof armorerGemini.geminiToolAdapter.formatResultsAsync, 'function');
    assert.equal(typeof armorerTest.createTestToolbox, 'function');
    assert.equal(typeof armorerTest.createToolboxRecorder, 'function');

    assert.equal(typeof conversationalistRoot.Conversation, 'function');
    assert.equal(typeof conversationalistRoot.materializeToolCalls, 'function');
    assert.equal(typeof conversationalistConversation.appendToolCalls, 'function');
    assert.equal(
      typeof conversationalistOpenAI.openAIConversationAdapter.append,
      'function',
    );
    assert.equal(
      typeof conversationalistAnthropic.anthropicConversationAdapter.import,
      'function',
    );
    assert.equal(
      typeof conversationalistGemini.geminiConversationAdapter.export,
      'function',
    );
    assert.equal(
      typeof conversationalistTest.createTestConversationEnvironment,
      'function',
    );
    assert.equal(typeof conversationalistTest.createConversationRecorder, 'function');
  });

  it('exposes generic provider helpers and parallel event methods on Conversation and Toolbox', () => {
    const { environment, toolbox } = createIntegrationHarness('surface');
    const conversation = new Conversation(
      createConversationHistory({ id: 'surface-conversation' }, environment),
      environment,
    );

    assert.equal(typeof Conversation.fromProvider, 'function');
    assert.equal(typeof conversation.toProvider, 'function');
    assert.equal(typeof conversation.appendProvider, 'function');
    assert.equal(typeof conversation.on, 'function');
    assert.equal(typeof conversation.once, 'function');
    assert.equal(typeof conversation.subscribe, 'function');
    assert.equal(typeof conversation.events, 'function');
    assert.equal(typeof conversation.toObservable, 'function');
    assert.equal(typeof conversation.complete, 'function');

    assert.equal(typeof createToolbox.fromProvider, 'function');
    assert.equal(typeof toolbox.toProvider, 'function');
    assert.equal(typeof toolbox.asExecuteResolver, 'function');
    assert.equal(typeof toolbox.on, 'function');
    assert.equal(typeof toolbox.once, 'function');
    assert.equal(typeof toolbox.subscribe, 'function');
    assert.equal(typeof toolbox.events, 'function');
    assert.equal(typeof toolbox.toObservable, 'function');
    assert.equal(typeof toolbox.complete, 'function');
  });
});

describe('event parity', () => {
  it('emits familiar mutation and execution events through the recorder helpers', async () => {
    const { environment, toolbox } = createIntegrationHarness('event-parity');
    const conversation = new Conversation(
      createConversationHistory({ id: 'event-parity' }, environment),
      environment,
    );

    const conversationRecorder = createConversationRecorder(conversation);
    const toolboxRecorder = createToolboxRecorder(toolbox);

    try {
      conversation.appendUserMessage('Check the weather.');
      const toolCalls = materializeParsedToolCalls(
        [
          {
            name: 'get_weather',
            arguments: { location: 'Denver' },
          },
        ],
        environment,
      );

      await toolbox.execute(toolCalls);

      assert.ok(
        conversationRecorder.events.some(
          (event) =>
            event.type === 'change' &&
            event.detail.action === 'messages.appended',
        ),
      );
      assert.ok(toolboxRecorder.events.some((event) => event.type === 'call'));
      assert.ok(toolboxRecorder.events.some((event) => event.type === 'complete'));
    } finally {
      conversationRecorder[Symbol.dispose]();
      toolboxRecorder[Symbol.dispose]();
    }
  });
});

describe('documented manual interop flow', () => {
  it('runs the OpenAI flow with generic provider helpers and shared tool-call materialization', async () => {
    const { environment, toolbox } = createIntegrationHarness('openai-canonical');

    let conversation = createConversationHistory({ id: 'openai-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'What is the weather in Denver?',
      undefined,
      environment,
    );

    const messages = await exportProvider(
      conversation,
      'openai',
      environment,
      { groupToolCalls: true },
    );
    const tools = await toolbox.toProvider('openai');
    const turn = await executeToolTurn(
      conversation,
      parseOpenAIToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-openai-1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ location: 'Denver' }),
                  },
                },
              ],
            },
          },
        ],
      }),
      toolbox,
      environment,
    );

    assert.deepEqual(messages, [
      { role: 'user', content: 'What is the weather in Denver?' },
    ]);
    assert.equal(tools[0]?.function.name, 'get_weather');
    assert.equal(turn.results[0]?.outcome, 'success');

    const formatted = await exportProvider(
      turn.conversation,
      'openai',
      environment,
      { groupToolCalls: true },
    );
    assert.equal(formatted[1]?.role, 'assistant');
    assert.equal(formatted[1]?.tool_calls?.[0]?.id, 'call-openai-1');
    assert.equal(formatted[1]?.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(formatted[2]?.role, 'tool');
    assert.equal(formatted[2]?.tool_call_id, 'call-openai-1');
  });

  it('runs the Anthropic flow with generic provider helpers and full-envelope parsing', async () => {
    const { environment, toolbox } = createIntegrationHarness(
      'anthropic-canonical',
    );

    let conversation = createConversationHistory(
      { id: 'anthropic-loop' },
      environment,
    );
    conversation = appendUserMessage(
      conversation,
      'Use the weather tool for Denver.',
      undefined,
      environment,
    );

    const messages = await exportProvider(conversation, 'anthropic', environment);
    const tools = await toolbox.toProvider('anthropic');
    const turn = await executeToolTurn(
      conversation,
      parseAnthropicToolCalls({
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call-anthropic-1',
              name: 'get_weather',
              input: { location: 'Denver' },
            },
          ],
        },
      }),
      toolbox,
      environment,
    );

    assert.deepEqual(messages.messages, [
      { role: 'user', content: 'Use the weather tool for Denver.' },
    ]);
    assert.equal(tools[0]?.name, 'get_weather');
    assert.equal(turn.results[0]?.outcome, 'success');

    const formatted = await exportProvider(turn.conversation, 'anthropic', environment);
    assert.equal(formatted.messages[1]?.role, 'assistant');
    assert.equal(formatted.messages[1]?.content?.[0]?.type, 'tool_use');
    assert.equal(formatted.messages[1]?.content?.[0]?.id, 'call-anthropic-1');
    assert.equal(formatted.messages[2]?.role, 'user');
    assert.equal(formatted.messages[2]?.content?.[0]?.type, 'tool_result');
    assert.equal(
      formatted.messages[2]?.content?.[0]?.tool_use_id,
      'call-anthropic-1',
    );
  });

  it('runs the Gemini flow with shared ID materialization and async result persistence', async () => {
    const { environment, toolbox } = createIntegrationHarness('gemini-canonical');

    let conversation = createConversationHistory({ id: 'gemini-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Stream the weather for Denver.',
      undefined,
      environment,
    );

    const messages = await exportProvider(conversation, 'gemini', environment);
    const tools = await toolbox.toProvider('gemini');
    const turn = await executeToolTurn(
      conversation,
      parseGeminiToolCalls({
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'stream_weather',
                  args: { location: 'Denver' },
                },
              },
            ],
          },
        ],
      }),
      toolbox,
      environment,
      {
        executeOptions: { stream: true },
        collectAsync: true,
      },
    );

    assert.deepEqual(messages.contents, [
      {
        role: 'user',
        parts: [{ text: 'Stream the weather for Denver.' }],
      },
    ]);
    assert.equal(tools[0]?.functionDeclarations[0]?.name, 'get_weather');
    assert.ok(turn.toolCalls[0]?.id);
    assert.equal(turn.results[0]?.toolCallId, turn.toolCalls[0]?.id);

    const formatted = await exportProvider(turn.conversation, 'gemini', environment);
    assert.equal(formatted.contents[1]?.role, 'model');
    assert.equal(
      formatted.contents[1]?.parts?.[0]?.functionCall?.name,
      'stream_weather',
    );
    assert.deepEqual(
      formatted.contents[1]?.parts?.[0]?.functionCall?.args,
      { location: 'Denver' },
    );
    assert.equal(formatted.contents[2]?.role, 'user');
    assert.equal(
      formatted.contents[2]?.parts?.[0]?.functionResponse?.name,
      'stream_weather',
    );
    assert.deepEqual(
      formatted.contents[2]?.parts?.[0]?.functionResponse?.response,
      ['Denver:72F', 'sunny'],
    );
  });
});

describe('advanced cross-package interop', () => {
  it('appends OpenAI provider payloads into an existing conversation without custom glue', async () => {
    const { environment, toolbox } = createIntegrationHarness('openai-advanced');

    let conversation = createConversationHistory({ id: 'openai-advanced' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Check the weather and then summarize it.',
      undefined,
      environment,
    );

    conversation = await appendProviderTurn(
      conversation,
      'openai',
      [
        {
          role: 'assistant',
          content: 'I will look up the current weather first.',
          tool_calls: [
            {
              id: 'call-openai-weather',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: JSON.stringify({ location: 'Denver' }),
              },
            },
          ],
        },
      ],
      environment,
    );

    const firstResults = await toolbox.execute(
      getToolCalls(conversation).filter(
        (toolCall) => toolCall.id === 'call-openai-weather',
      ),
    );
    conversation = appendToolResults(conversation, firstResults, environment);

    conversation = await appendProviderTurn(
      conversation,
      'openai',
      [
        {
          role: 'assistant',
          content: 'Now I will summarize those conditions.',
          tool_calls: [
            {
              id: 'call-openai-summary',
              type: 'function',
              function: {
                name: 'summarize_weather',
                arguments: JSON.stringify({
                  location: 'Denver',
                  condition: 'sunny',
                }),
              },
            },
          ],
        },
      ],
      environment,
    );

    const secondResults = await toolbox.execute(
      getToolCalls(conversation).filter(
        (toolCall) => toolCall.id === 'call-openai-summary',
      ),
    );
    conversation = appendToolResults(conversation, secondResults, environment);

    const messages = getMessages(conversation);
    assert.deepEqual(
      messages.map((message) => message.role),
      [
        'user',
        'assistant',
        'tool-call',
        'tool-result',
        'assistant',
        'tool-call',
        'tool-result',
      ],
    );
    assert.equal(messages[1]?.content, 'I will look up the current weather first.');
    assert.equal(messages[4]?.content, 'Now I will summarize those conditions.');
  });

  it('appends Anthropic payloads with mixed content blocks in original order', async () => {
    const { environment, toolbox } = createIntegrationHarness(
      'anthropic-advanced',
    );

    let conversation = createConversationHistory(
      { id: 'anthropic-advanced' },
      environment,
    );
    conversation = appendUserMessage(
      conversation,
      'Check the weather and summarize it.',
      undefined,
      environment,
    );

    conversation = await appendProviderTurn(
      conversation,
      'anthropic',
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Looking up the weather now.' },
              {
                type: 'tool_use',
                id: 'call-anthropic-weather',
                name: 'get_weather',
                input: { location: 'Denver' },
              },
            ],
          },
        ],
      },
      environment,
    );

    const weatherResults = await toolbox.execute(
      getToolCalls(conversation).filter(
        (toolCall) => toolCall.id === 'call-anthropic-weather',
      ),
    );
    conversation = appendToolResults(conversation, weatherResults, environment);

    conversation = await appendProviderTurn(
      conversation,
      'anthropic',
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Summarizing the conditions next.' },
              {
                type: 'tool_use',
                id: 'call-anthropic-summary',
                name: 'summarize_weather',
                input: { location: 'Denver', condition: 'sunny' },
              },
            ],
          },
        ],
      },
      environment,
    );

    const summaryResults = await toolbox.execute(
      getToolCalls(conversation).filter(
        (toolCall) => toolCall.id === 'call-anthropic-summary',
      ),
    );
    conversation = appendToolResults(conversation, summaryResults, environment);

    const messages = getMessages(conversation);
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(messages[1]?.content, 'Looking up the weather now.');
    assert.equal(messages[4]?.role, 'assistant');
    assert.equal(messages[4]?.content, 'Summarizing the conditions next.');
  });

  it('persists and restores a conversation mid-loop before continuing the next turn', async () => {
    const { environment, toolbox } = createIntegrationHarness('persistence');

    let conversation = createConversationHistory({ id: 'persisted-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Check the weather first.',
      undefined,
      environment,
    );

    conversation = await appendProviderTurn(
      conversation,
      'openai',
      [
        {
          role: 'assistant',
          content: 'I am checking Denver now.',
          tool_calls: [
            {
              id: 'call-persist-weather',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: JSON.stringify({ location: 'Denver' }),
              },
            },
          ],
        },
      ],
      environment,
    );

    const firstResults = await toolbox.execute(
      getToolCalls(conversation).filter(
        (toolCall) => toolCall.id === 'call-persist-weather',
      ),
    );
    conversation = appendToolResults(conversation, firstResults, environment);

    const restoredConversation = deserializeConversationHistory(
      JSON.parse(JSON.stringify(conversation)),
    );

    const continuedConversation = await appendProviderTurn(
      restoredConversation,
      'openai',
      [
        {
          role: 'assistant',
          content: 'I will summarize those conditions now.',
          tool_calls: [
            {
              id: 'call-persist-summary',
              type: 'function',
              function: {
                name: 'summarize_weather',
                arguments: JSON.stringify({
                  location: 'Denver',
                  condition: 'sunny',
                }),
              },
            },
          ],
        },
      ],
      environment,
    );

    const finalResults = await toolbox.execute(
      getToolCalls(continuedConversation).filter(
        (toolCall) => toolCall.id === 'call-persist-summary',
      ),
    );
    const completedConversation = appendToolResults(
      continuedConversation,
      finalResults,
      environment,
    );

    assert.deepEqual(
      getMessages(completedConversation).map((message) => message.role),
      [
        'user',
        'assistant',
        'tool-call',
        'tool-result',
        'assistant',
        'tool-call',
        'tool-result',
      ],
    );
  });

  it('rejects synchronous tool-result append for live streaming results', () => {
    const { environment } = createIntegrationHarness('stream-rejection');

    let conversation = createConversationHistory({ id: 'stream-rejection' }, environment);
    conversation = appendToolCalls(
      conversation,
      [
        {
          id: 'call-stream-rejection',
          name: 'stream_weather',
          arguments: { location: 'Denver' },
        },
      ],
      environment,
    );
    const liveStream = {
      async *[Symbol.asyncIterator]() {
        yield 'Denver:72F';
        yield 'sunny';
      },
    };
    const results = [
      {
        callId: 'call-stream-rejection',
        toolCallId: 'call-stream-rejection',
        toolName: 'stream_weather',
        outcome: 'success',
        content: null,
        result: liveStream,
        stream: liveStream,
      },
    ];

    assert.throws(
      () => appendToolResults(conversation, results, environment),
      /materializeToolResult does not support streaming tool results/,
    );
  });

  it('keeps Gemini call identifiers stable through execution and reverse conversion', async () => {
    const { environment, toolbox } = createIntegrationHarness('gemini-identifiers');

    let conversation = createConversationHistory({ id: 'gemini-identifiers' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Stream the weather for Denver.',
      undefined,
      environment,
    );

    const turn = await executeToolTurn(
      conversation,
      parseGeminiToolCalls({
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'stream_weather',
                  args: { location: 'Denver' },
                },
              },
            ],
          },
        ],
      }),
      toolbox,
      environment,
      {
        executeOptions: { stream: true },
        collectAsync: true,
      },
    );

    assert.ok(turn.toolCalls[0]?.id);
    assert.equal(turn.results[0]?.toolCallId, turn.toolCalls[0]?.id);

    const reconstructedConversation = (
      await Conversation.fromProvider(
        'gemini',
        await exportProvider(turn.conversation, 'gemini', environment),
        environment,
      )
    ).current;
    const reconstructedToolCalls = getToolCalls(reconstructedConversation);
    const reconstructedToolResults = getToolResults(reconstructedConversation);

    assert.equal(reconstructedToolCalls[0]?.id, 'gemini-call-1');
    assert.equal(reconstructedToolResults[0]?.callId, 'gemini-call-1');
  });

  it('round-trips provider-formatted error and action-required results back into canonical tool results', async () => {
    const { environment, toolbox } = createIntegrationHarness('provider-results');

    let openAIConversation = createConversationHistory({ id: 'openai-results' }, environment);
    openAIConversation = appendUserMessage(
      openAIConversation,
      'Try the failing weather tool.',
      undefined,
      environment,
    );
    openAIConversation = await appendProviderTurn(
      openAIConversation,
      'openai',
      [
        {
          role: 'assistant',
          content: 'Attempting the failing weather lookup.',
          tool_calls: [
            {
              id: 'call-openai-error',
              type: 'function',
              function: {
                name: 'fail_weather',
                arguments: JSON.stringify({ location: 'Denver' }),
              },
            },
          ],
        },
      ],
      environment,
    );

    const openAIResults = await toolbox.execute(
      getToolCalls(openAIConversation).filter(
        (toolCall) => toolCall.id === 'call-openai-error',
      ),
    );
    openAIConversation = appendToolResults(openAIConversation, openAIResults, environment);
    const reconstructedOpenAIResults = getToolResults(
      (
        await Conversation.fromProvider(
          'openai',
          await exportProvider(openAIConversation, 'openai', environment, {
            groupToolCalls: true,
          }),
          environment,
        )
      ).current,
    );
    assert.equal(reconstructedOpenAIResults[0]?.callId, 'call-openai-error');
    assert.equal(reconstructedOpenAIResults[0]?.outcome, 'error');
    assert.match(reconstructedOpenAIResults[0]?.error?.message ?? '', /Denver/);

    let anthropicConversation = createConversationHistory(
      { id: 'anthropic-results' },
      environment,
    );
    anthropicConversation = appendUserMessage(
      anthropicConversation,
      'Request the approval-gated weather tool.',
      undefined,
      environment,
    );
    anthropicConversation = await appendProviderTurn(
      anthropicConversation,
      'anthropic',
      {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-anthropic-approval',
                name: 'request_weather_approval',
                input: { location: 'Denver' },
              },
            ],
          },
        ],
      },
      environment,
    );

    const anthropicResults = await toolbox.execute(
      getToolCalls(anthropicConversation).filter(
        (toolCall) => toolCall.id === 'call-anthropic-approval',
      ),
    );
    anthropicConversation = appendToolResults(
      anthropicConversation,
      anthropicResults,
      environment,
    );
    const reconstructedAnthropicResults = getToolResults(
      (
        await Conversation.fromProvider(
          'anthropic',
          await exportProvider(anthropicConversation, 'anthropic', environment),
          environment,
        )
      ).current,
    );
    assert.equal(
      reconstructedAnthropicResults[0]?.callId,
      'call-anthropic-approval',
    );
    assert.equal(reconstructedAnthropicResults[0]?.outcome, 'action_required');
    assert.equal(reconstructedAnthropicResults[0]?.action?.type, 'approval');
  });
});

describe('message and tool round-trips', () => {
  it('round-trips OpenAI, Anthropic, and Gemini messages through generic Conversation provider helpers', async () => {
    const { environment, toolbox } = createIntegrationHarness('message-roundtrip');

    let openAIConversation = createConversationHistory(
      { id: 'openai-roundtrip' },
      environment,
    );
    openAIConversation = appendUserMessage(
      openAIConversation,
      'Check the weather in Denver.',
      undefined,
      environment,
    );
    const openAITurn = await executeToolTurn(
      openAIConversation,
      parseOpenAIToolCalls({
        tool_calls: [
          {
            id: 'call-openai-roundtrip',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: JSON.stringify({ location: 'Denver' }),
            },
          },
        ],
      }),
      toolbox,
      environment,
    );

    const reconstructedOpenAIState = await Conversation.fromProvider(
      'openai',
      await exportProvider(openAITurn.conversation, 'openai', environment, {
        groupToolCalls: true,
      }),
      environment,
    );
    assert.deepEqual(
      getMessages(reconstructedOpenAIState.current).map((message) => message.role),
      ['user', 'tool-call', 'tool-result'],
    );

    let anthropicConversation = createConversationHistory(
      { id: 'anthropic-roundtrip' },
      environment,
    );
    anthropicConversation = appendUserMessage(
      anthropicConversation,
      'Use the weather tool.',
      undefined,
      environment,
    );
    const anthropicTurn = await executeToolTurn(
      anthropicConversation,
      parseAnthropicToolCalls({
        content: [
          {
            type: 'tool_use',
            id: 'call-anthropic-roundtrip',
            name: 'get_weather',
            input: { location: 'Denver' },
          },
        ],
      }),
      toolbox,
      environment,
    );

    const reconstructedAnthropicState = await Conversation.fromProvider(
      'anthropic',
      await exportProvider(anthropicTurn.conversation, 'anthropic', environment),
      environment,
    );
    assert.equal(
      getToolResults(reconstructedAnthropicState.current)[0]?.callId,
      'call-anthropic-roundtrip',
    );

    let geminiConversation = createConversationHistory(
      { id: 'gemini-roundtrip' },
      environment,
    );
    geminiConversation = appendUserMessage(
      geminiConversation,
      'Stream the weather for Denver.',
      undefined,
      environment,
    );
    const geminiTurn = await executeToolTurn(
      geminiConversation,
      parseGeminiToolCalls({
        parts: [
          {
            functionCall: {
              name: 'stream_weather',
              args: { location: 'Denver' },
            },
          },
        ],
      }),
      toolbox,
      environment,
      {
        executeOptions: { stream: true },
        collectAsync: true,
      },
    );

    const reconstructedGeminiState = await Conversation.fromProvider(
      'gemini',
      await exportProvider(geminiTurn.conversation, 'gemini', environment),
      environment,
    );
    assert.deepEqual(
      getMessages(reconstructedGeminiState.current).map((message) => message.role),
      ['user', 'tool-call', 'tool-result'],
    );
  });

  it('round-trips tool definitions through createToolbox.fromProvider(..., { sourceToolbox })', async () => {
    const harness = createIntegrationHarness('tool-roundtrip');

    const openAITools = await harness.toolbox.toProvider('openai');
    const anthropicTools = await harness.toolbox.toProvider('anthropic');
    const geminiTools = await harness.toolbox.toProvider('gemini');

    const importedOpenAI = await createToolbox.fromProvider('openai', openAITools, {
      sourceToolbox: harness.toolbox,
    });
    const importedAnthropic = await createToolbox.fromProvider(
      'anthropic',
      anthropicTools,
      {
        sourceToolbox: harness.toolbox,
      },
    );
    const importedGemini = await createToolbox.fromProvider('gemini', geminiTools, {
      sourceToolbox: harness.toolbox,
    });

    const openAIResult = await importedOpenAI.execute([
      {
        id: 'call-openai-imported',
        name: 'get_weather',
        arguments: { location: 'Denver' },
      },
    ]);
    assert.equal(openAIResult[0]?.outcome, 'success');
    assert.deepEqual(openAIResult[0]?.content, {
      location: 'Denver',
      temperatureF: 72,
      condition: 'sunny',
    });

    const anthropicResult = await importedAnthropic.execute([
      {
        id: 'call-anthropic-imported',
        name: 'summarize_weather',
        arguments: { location: 'Denver', condition: 'sunny' },
      },
    ]);
    assert.deepEqual(anthropicResult[0]?.content, {
      summary: 'Denver is currently sunny.',
    });

    const geminiResult = await importedGemini.execute([
      {
        id: 'call-gemini-imported',
        name: 'get_weather',
        arguments: { location: 'Denver' },
      },
    ]);
    assert.equal(geminiResult[0]?.toolName, 'get_weather');
    assert.equal(geminiResult[0]?.outcome, 'success');
  });
});
