import { createTool, createToolbox } from 'armorer';
import {
  parseAnthropicToolCalls,
  toAnthropicTools,
} from 'armorer/adapters/anthropic';
import { parseGeminiToolCalls, toGeminiTools } from 'armorer/adapters/gemini';
import { parseOpenAIToolCalls, toOpenAITools } from 'armorer/adapters/openai';
import { createMockTool, createTestRegistry } from 'armorer/test';
import {
  appendMessages,
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
  getMessages,
} from 'conversationalist';
import {
  fromAnthropicMessages,
  toAnthropicMessages,
} from 'conversationalist/adapters/anthropic';
import {
  fromGeminiMessages,
  toGeminiMessages,
} from 'conversationalist/adapters/gemini';
import {
  fromOpenAIMessages,
  toOpenAIMessagesGrouped,
} from 'conversationalist/adapters/openai';
import { createTestConversationEnvironment } from 'conversationalist/test';
import { z } from 'zod';

function createStreamingResult(location) {
  return {
    async *[Symbol.asyncIterator]() {
      yield `${location}:72F`;
      yield 'sunny';
    },
  };
}

function toMessageInput(message) {
  return {
    role: message.role,
    content:
      typeof message.content === 'string' ? message.content : [...message.content],
    ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
    ...(message.hidden !== undefined ? { hidden: message.hidden } : {}),
    ...(message.toolCall ? { toolCall: { ...message.toolCall } } : {}),
    ...(message.toolResult ? { toolResult: { ...message.toolResult } } : {}),
    ...(message.tokenUsage ? { tokenUsage: message.tokenUsage } : {}),
    ...('goalCompleted' in message &&
    message.role === 'assistant' &&
    typeof message.goalCompleted === 'boolean'
      ? { goalCompleted: message.goalCompleted }
      : {}),
  };
}

export function createIntegrationHarness(identifierPrefix = 'integration') {
  const environment = createTestConversationEnvironment({
    identifierPrefix,
    now: () => '2024-01-01T00:00:00.000Z',
  });

  const getWeather = createMockTool({
    name: 'get_weather',
    input: z.object({ location: z.string() }),
    impl: async ({ location }) => ({
      location,
      temperatureF: 72,
      condition: 'sunny',
    }),
  });

  const summarizeWeather = createMockTool({
    name: 'summarize_weather',
    input: z.object({
      location: z.string(),
      condition: z.string(),
    }),
    impl: async ({ location, condition }) => ({
      summary: `${location} is currently ${condition}.`,
    }),
  });

  const streamWeather = createMockTool({
    name: 'stream_weather',
    input: z.object({ location: z.string() }),
    impl: async ({ location }) => createStreamingResult(location),
  });

  const failWeather = createMockTool({
    name: 'fail_weather',
    input: z.object({ location: z.string() }),
    impl: async ({ location }) => {
      const error = Object.assign(
        new Error(`Weather service unavailable for ${location}`),
        { code: 'WEATHER_UNAVAILABLE' },
      );
      throw error;
    },
  });

  const requestWeatherApproval = createTool({
    name: 'request_weather_approval',
    description: 'Request approval before revealing privileged weather data.',
    input: z.object({ location: z.string() }),
    policy: {
      beforeExecute: async ({ params }) => {
        const location =
          params && typeof params === 'object' && 'location' in params
            ? String(params.location)
            : 'unknown';

        return {
          allow: false,
          status: 'needs_approval',
          reason: `Approval required before revealing weather for ${location}`,
          action: {
            message: `Approve privileged weather access for ${location}`,
          },
        };
      },
    },
    async execute({ location }) {
      return {
        location,
        approved: true,
      };
    },
  });

  const toolbox = createTestRegistry([
    getWeather,
    summarizeWeather,
    streamWeather,
    failWeather,
    requestWeatherApproval,
  ]);

  const importedExecutors = {
    get_weather: async (parameters) => getWeather(parameters),
    summarize_weather: async (parameters) => summarizeWeather(parameters),
    stream_weather: async (parameters) => streamWeather(parameters),
    fail_weather: async (parameters) => failWeather(parameters),
  };

  return {
    environment,
    toolbox,
    resolveImportedExecute: (configuration) =>
      importedExecutors[configuration.name] ??
      (async () => {
        throw new Error(`No imported execute available for ${configuration.name}`);
      }),
  };
}

export function appendImportedMessages(
  conversation,
  importedConversation,
  environment,
) {
  const inputs = getMessages(importedConversation).map(toMessageInput);
  return inputs.length === 0
    ? conversation
    : appendMessages(conversation, ...inputs, environment);
}

export function getToolCalls(conversation) {
  return getMessages(conversation)
    .filter((message) => message.role === 'tool-call' && Boolean(message.toolCall))
    .map((message) => message.toolCall);
}

export function getToolResults(conversation) {
  return getMessages(conversation)
    .filter(
      (message) => message.role === 'tool-result' && Boolean(message.toolResult),
    )
    .map((message) => message.toolResult);
}

export async function runOpenAIToolTurn(
  conversation,
  toolbox,
  toolCalls,
  environment,
) {
  const messages = toOpenAIMessagesGrouped(conversation);
  const tools = toOpenAITools(toolbox);
  const parsedToolCalls = parseOpenAIToolCalls(toolCalls);
  const withCalls = appendToolCalls(conversation, parsedToolCalls, environment);
  const results = await toolbox.execute(parsedToolCalls);
  const withResults = appendToolResults(withCalls, results, environment);

  return {
    conversation: withResults,
    messages,
    tools,
    toolCalls: parsedToolCalls,
    results,
  };
}

export async function runAnthropicToolTurn(
  conversation,
  toolbox,
  contentBlocks,
  environment,
) {
  const messages = toAnthropicMessages(conversation);
  const tools = toAnthropicTools(toolbox);
  const parsedToolCalls = parseAnthropicToolCalls(contentBlocks);
  const withCalls = appendToolCalls(conversation, parsedToolCalls, environment);
  const results = await toolbox.execute(parsedToolCalls);
  const withResults = appendToolResults(withCalls, results, environment);

  return {
    conversation: withResults,
    messages,
    tools,
    toolCalls: parsedToolCalls,
    results,
  };
}

export function assignGeminiToolCallIdentifiers(
  toolCalls,
  identifierPrefix = 'call-gemini',
) {
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id ?? `${identifierPrefix}-${index + 1}`,
    name: toolCall.name,
    arguments: toolCall.arguments ?? {},
  }));
}

export async function runGeminiToolTurn(
  conversation,
  toolbox,
  parts,
  environment,
  options = {},
) {
  const messages = toGeminiMessages(conversation);
  const tools = toGeminiTools(toolbox);
  const parsedToolCalls = parseGeminiToolCalls(parts);
  const identifiedToolCalls = assignGeminiToolCallIdentifiers(
    parsedToolCalls,
    options.identifierPrefix,
  );
  const withCalls = appendToolCalls(conversation, identifiedToolCalls, environment);
  const results = await toolbox.execute(identifiedToolCalls, {
    ...(options.stream ? { stream: true } : {}),
  });
  const withResults = options.stream
    ? await appendToolResultsAsync(withCalls, results, environment)
    : appendToolResults(withCalls, results, environment);

  return {
    conversation: withResults,
    messages,
    tools,
    toolCalls: identifiedToolCalls,
    results,
  };
}

export function appendOpenAIProviderTurn(conversation, messages, environment) {
  return appendImportedMessages(
    conversation,
    fromOpenAIMessages(messages),
    environment,
  );
}

export function appendAnthropicProviderTurn(conversation, payload, environment) {
  return appendImportedMessages(
    conversation,
    fromAnthropicMessages(payload),
    environment,
  );
}

export function appendGeminiProviderTurn(conversation, payload, environment) {
  return appendImportedMessages(
    conversation,
    fromGeminiMessages(payload),
    environment,
  );
}

export async function createImportedToolboxes(harness) {
  const openAITools = await harness.toolbox.toOpenAITools();
  const anthropicTools = await harness.toolbox.toAnthropicTools();
  const geminiTools = await harness.toolbox.toGeminiTools();

  return {
    openAI: await createToolbox.fromOpenAITools(openAITools, {
      getTool: harness.resolveImportedExecute,
    }),
    anthropic: await createToolbox.fromAnthropicTools(anthropicTools, {
      getTool: harness.resolveImportedExecute,
    }),
    gemini: await createToolbox.fromGeminiTools(geminiTools, {
      getTool: harness.resolveImportedExecute,
    }),
  };
}
