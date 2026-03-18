import { createTool } from 'armorer';
import { createMockTool, createTestToolbox } from 'armorer/test';
import { getMessages } from 'conversationalist';
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

  const toolbox = createTestToolbox([
    getWeather,
    summarizeWeather,
    streamWeather,
    failWeather,
    requestWeatherApproval,
  ]);

  return {
    environment,
    toolbox,
  };
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
