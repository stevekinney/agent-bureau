import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createToolbox } from 'armorer';
import {
  Conversation,
  createConversationHistory,
  deserializeConversationHistory,
} from 'conversationalist';
import {
  appendToolCalls,
  appendToolResults,
  appendUserMessage,
  getMessages,
} from 'conversationalist/conversation';
import { fromGeminiMessages } from 'conversationalist/adapters/gemini';
import {
  appendAnthropicProviderTurn,
  appendOpenAIProviderTurn,
  createImportedToolboxes,
  createIntegrationHarness,
  getToolCalls,
  getToolResults,
  runAnthropicToolTurn,
  runGeminiToolTurn,
  runOpenAIToolTurn,
} from './runtime-helpers.mjs';

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
    assert.equal(typeof armorerOpenAI.toOpenAITools, 'function');
    assert.equal(typeof armorerAnthropic.parseAnthropicToolCalls, 'function');
    assert.equal(typeof armorerGemini.parseGeminiToolCalls, 'function');
    assert.equal(typeof armorerTest.createTestRegistry, 'function');

    assert.equal(typeof conversationalistRoot.Conversation, 'function');
    assert.equal(typeof conversationalistConversation.appendToolCalls, 'function');
    assert.equal(
      typeof conversationalistOpenAI.toOpenAIMessagesGrouped,
      'function',
    );
    assert.equal(
      typeof conversationalistAnthropic.fromAnthropicMessages,
      'function',
    );
    assert.equal(typeof conversationalistGemini.fromGeminiMessages, 'function');
    assert.equal(
      typeof conversationalistTest.createTestConversationEnvironment,
      'function',
    );
  });

  it('exposes lazy convenience methods on Conversation and Toolbox instances', () => {
    const { environment, toolbox } = createIntegrationHarness('surface');
    const conversation = new Conversation(
      createConversationHistory({ id: 'surface-conversation' }, environment),
      environment,
    );

    assert.equal(typeof Conversation.fromOpenAIMessages, 'function');
    assert.equal(typeof Conversation.fromAnthropicMessages, 'function');
    assert.equal(typeof Conversation.fromGeminiMessages, 'function');
    assert.equal(typeof conversation.toOpenAIMessages, 'function');
    assert.equal(typeof conversation.toOpenAIMessagesGrouped, 'function');
    assert.equal(typeof conversation.toAnthropicMessages, 'function');
    assert.equal(typeof conversation.toGeminiMessages, 'function');

    assert.equal(typeof createToolbox.fromOpenAITools, 'function');
    assert.equal(typeof createToolbox.fromAnthropicTools, 'function');
    assert.equal(typeof createToolbox.fromGeminiTools, 'function');
    assert.equal(typeof toolbox.toOpenAITools, 'function');
    assert.equal(typeof toolbox.toAnthropicTools, 'function');
    assert.equal(typeof toolbox.toGeminiTools, 'function');
  });
});

describe('documented canonical tool loops', () => {
  it('runs the canonical OpenAI loop through published APIs', async () => {
    const { environment, toolbox } = createIntegrationHarness('openai-canonical');

    let conversation = createConversationHistory({ id: 'openai-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'What is the weather in Denver?',
      undefined,
      environment,
    );

    const turn = await runOpenAIToolTurn(
      conversation,
      toolbox,
      [
        {
          id: 'call-openai-1',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ location: 'Denver' }),
          },
        },
      ],
      environment,
    );

    assert.deepEqual(turn.messages, [
      { role: 'user', content: 'What is the weather in Denver?' },
    ]);
    assert.equal(turn.tools[0]?.function.name, 'get_weather');
    assert.equal(turn.results[0]?.outcome, 'success');

    const { toOpenAIMessagesGrouped } = await import(
      'conversationalist/adapters/openai'
    );
    const formatted = await toOpenAIMessagesGrouped(turn.conversation);
    assert.equal(formatted[1]?.role, 'assistant');
    assert.equal(formatted[1]?.tool_calls?.[0]?.id, 'call-openai-1');
    assert.equal(formatted[1]?.tool_calls?.[0]?.function.name, 'get_weather');
    assert.equal(formatted[2]?.role, 'tool');
    assert.equal(formatted[2]?.tool_call_id, 'call-openai-1');
  });

  it('runs the canonical Anthropic loop through published APIs', async () => {
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

    const turn = await runAnthropicToolTurn(
      conversation,
      toolbox,
      [
        {
          type: 'tool_use',
          id: 'call-anthropic-1',
          name: 'get_weather',
          input: { location: 'Denver' },
        },
      ],
      environment,
    );

    assert.deepEqual(turn.messages.messages, [
      { role: 'user', content: 'Use the weather tool for Denver.' },
    ]);
    assert.equal(turn.tools[0]?.name, 'get_weather');
    assert.equal(turn.results[0]?.outcome, 'success');

    const { toAnthropicMessages } = await import(
      'conversationalist/adapters/anthropic'
    );
    const formatted = await toAnthropicMessages(turn.conversation);
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

  it('runs the canonical Gemini loop with streamed tool results', async () => {
    const { environment, toolbox } = createIntegrationHarness('gemini-canonical');

    let conversation = createConversationHistory({ id: 'gemini-loop' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Stream the weather for Denver.',
      undefined,
      environment,
    );

    const turn = await runGeminiToolTurn(
      conversation,
      toolbox,
      [
        {
          functionCall: {
            name: 'stream_weather',
            args: { location: 'Denver' },
          },
        },
      ],
      environment,
      {
        identifierPrefix: 'call-gemini',
        stream: true,
      },
    );

    assert.deepEqual(turn.messages.contents, [
      {
        role: 'user',
        parts: [{ text: 'Stream the weather for Denver.' }],
      },
    ]);
    assert.equal(turn.tools[0]?.functionDeclarations[0]?.name, 'get_weather');
    assert.equal(turn.toolCalls[0]?.id, 'call-gemini-1');
    assert.equal(turn.results[0]?.toolCallId, 'call-gemini-1');

    const { toGeminiMessages } = await import('conversationalist/adapters/gemini');
    const formatted = await toGeminiMessages(turn.conversation);
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

    const messages = getMessages(turn.conversation);
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'tool-call', 'tool-result'],
    );
  });
});

describe('advanced cross-package interop', () => {
  it('handles multi-turn OpenAI responses with assistant text and tool calls in the same turn', async () => {
    const { environment, toolbox } = createIntegrationHarness('openai-advanced');

    let conversation = createConversationHistory({ id: 'openai-advanced' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Check the weather and then summarize it.',
      undefined,
      environment,
    );

    conversation = appendOpenAIProviderTurn(
      conversation,
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

    const firstToolCalls = getToolCalls(conversation).filter(
      (toolCall) => toolCall.id === 'call-openai-weather',
    );
    assert.equal(firstToolCalls.length, 1);

    const firstResults = await toolbox.execute(firstToolCalls);
    conversation = appendToolResults(conversation, firstResults, environment);

    conversation = appendOpenAIProviderTurn(
      conversation,
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

    const secondToolCalls = getToolCalls(conversation).filter(
      (toolCall) => toolCall.id === 'call-openai-summary',
    );
    const secondResults = await toolbox.execute(secondToolCalls);
    conversation = appendToolResults(conversation, secondResults, environment);

    const messages = getMessages(conversation);
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'tool-call', 'tool-result', 'assistant', 'tool-call', 'tool-result'],
    );
    assert.equal(messages[1]?.content, 'I will look up the current weather first.');
    assert.equal(messages[4]?.content, 'Now I will summarize those conditions.');
  });

  it('handles multi-turn Anthropic responses with mixed content blocks in original order', async () => {
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

    conversation = appendAnthropicProviderTurn(
      conversation,
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

    conversation = appendAnthropicProviderTurn(
      conversation,
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

    conversation = appendOpenAIProviderTurn(
      conversation,
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

    const continuedConversation = appendOpenAIProviderTurn(
      restoredConversation,
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
      ['user', 'assistant', 'tool-call', 'tool-result', 'assistant', 'tool-call', 'tool-result'],
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
      /appendToolResult does not support streaming tool results/,
    );
  });

  it('keeps Gemini tool-call identifiers stable through execution and preserves pairings on reverse conversion', async () => {
    const { environment, toolbox } = createIntegrationHarness('gemini-identifiers');

    let conversation = createConversationHistory({ id: 'gemini-identifiers' }, environment);
    conversation = appendUserMessage(
      conversation,
      'Stream the weather for Denver.',
      undefined,
      environment,
    );

    const turn = await runGeminiToolTurn(
      conversation,
      toolbox,
      [
        {
          functionCall: {
            name: 'stream_weather',
            args: { location: 'Denver' },
          },
        },
      ],
      environment,
      {
        identifierPrefix: 'deterministic-gemini',
        stream: true,
      },
    );

    assert.equal(turn.toolCalls[0]?.id, 'deterministic-gemini-1');
    assert.equal(turn.results[0]?.toolCallId, 'deterministic-gemini-1');

    const reconstructedConversation = fromGeminiMessages(
      await new Conversation(turn.conversation, environment).toGeminiMessages(),
    );
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
    openAIConversation = appendOpenAIProviderTurn(
      openAIConversation,
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
        await Conversation.fromOpenAIMessages(
          await new Conversation(openAIConversation, environment).toOpenAIMessagesGrouped(),
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
    anthropicConversation = appendAnthropicProviderTurn(
      anthropicConversation,
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
        await Conversation.fromAnthropicMessages(
          await new Conversation(anthropicConversation, environment).toAnthropicMessages(),
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
  it('round-trips OpenAI, Anthropic, and Gemini messages through standalone and lazy Conversation helpers', async () => {
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
    const openAITurn = await runOpenAIToolTurn(
      openAIConversation,
      toolbox,
      [
        {
          id: 'call-openai-roundtrip',
          type: 'function',
          function: {
            name: 'get_weather',
            arguments: JSON.stringify({ location: 'Denver' }),
          },
        },
      ],
      environment,
    );

    const openAIState = new Conversation(openAITurn.conversation, environment);
    const groupedOpenAIMessages = await openAIState.toOpenAIMessagesGrouped();
    const reconstructedOpenAIState = await Conversation.fromOpenAIMessages(
      groupedOpenAIMessages,
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
    const anthropicTurn = await runAnthropicToolTurn(
      anthropicConversation,
      toolbox,
      [
        {
          type: 'tool_use',
          id: 'call-anthropic-roundtrip',
          name: 'get_weather',
          input: { location: 'Denver' },
        },
      ],
      environment,
    );

    const anthropicState = new Conversation(anthropicTurn.conversation, environment);
    const anthropicMessages = await anthropicState.toAnthropicMessages();
    const reconstructedAnthropicState = await Conversation.fromAnthropicMessages(
      anthropicMessages,
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
    const geminiTurn = await runGeminiToolTurn(
      geminiConversation,
      toolbox,
      [
        {
          functionCall: {
            name: 'stream_weather',
            args: { location: 'Denver' },
          },
        },
      ],
      environment,
      {
        identifierPrefix: 'gemini-roundtrip',
        stream: true,
      },
    );

    const geminiState = new Conversation(geminiTurn.conversation, environment);
    const geminiMessages = await geminiState.toGeminiMessages();
    const reconstructedGeminiState = await Conversation.fromGeminiMessages(
      geminiMessages,
      environment,
    );
    assert.deepEqual(
      getMessages(reconstructedGeminiState.current).map((message) => message.role),
      ['user', 'tool-call', 'tool-result'],
    );
  });

  it('round-trips tools through provider adapters and imported toolboxes', async () => {
    const harness = createIntegrationHarness('tool-roundtrip');
    const importedToolboxes = await createImportedToolboxes(harness);

    const openAIResult = await importedToolboxes.openAI.execute([
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

    const anthropicResult = await importedToolboxes.anthropic.execute([
      {
        id: 'call-anthropic-imported',
        name: 'summarize_weather',
        arguments: { location: 'Denver', condition: 'sunny' },
      },
    ]);
    assert.deepEqual(anthropicResult[0]?.content, {
      summary: 'Denver is currently sunny.',
    });

    const geminiResult = await importedToolboxes.gemini.execute([
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
