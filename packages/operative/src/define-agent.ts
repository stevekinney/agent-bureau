import { Conversation } from 'conversationalist';

import type { ActiveRun } from './create-run';
import { createRun } from './create-run';
import { run } from './run';
import type {
  AgentDefinition,
  AgentRunOptions,
  DefineAgentOptions,
  RunOptions,
  RunResult,
  StopCondition,
} from './types';

function isConversation(value: unknown): value is Conversation {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Conversation).appendAssistantMessage === 'function' &&
    typeof (value as Conversation).appendToolCalls === 'function' &&
    typeof (value as Conversation).appendToolResults === 'function' &&
    'current' in (value as Conversation)
  );
}

function normalizeInput(
  input: string | AgentRunOptions,
  instructions?: string,
): { conversation: Conversation; signal?: AbortSignal; stopWhen?: StopCondition | StopCondition[] } {
  if (typeof input === 'string') {
    const conversation = new Conversation();
    if (instructions) {
      conversation.appendSystemMessage(instructions);
    }
    conversation.appendUserMessage(input);
    return { conversation };
  }

  const { signal, stopWhen } = input;
  let conversation: Conversation;

  if (typeof input.conversation === 'string') {
    conversation = new Conversation();
    if (instructions) {
      conversation.appendSystemMessage(instructions);
    }
    conversation.appendUserMessage(input.conversation);
  } else if (input.conversation && isConversation(input.conversation)) {
    conversation = input.conversation;
  } else if (input.conversation) {
    conversation = new Conversation(input.conversation);
  } else {
    conversation = new Conversation();
    if (instructions) {
      conversation.appendSystemMessage(instructions);
    }
  }

  return { conversation, signal, stopWhen };
}

function mergeStopConditions(
  definition: DefineAgentOptions['stopWhen'],
  runtime: StopCondition | StopCondition[] | undefined,
): StopCondition[] | undefined {
  const defConditions = definition
    ? Array.isArray(definition) ? definition : [definition]
    : [];
  const runConditions = runtime
    ? Array.isArray(runtime) ? runtime : [runtime]
    : [];
  const merged = [...defConditions, ...runConditions];
  return merged.length > 0 ? merged : undefined;
}

function buildRunOptions(
  options: DefineAgentOptions,
  input: string | AgentRunOptions,
): RunOptions {
  const { conversation, signal, stopWhen: runtimeStopWhen } = normalizeInput(input, options.instructions);

  return {
    generate: options.generate,
    toolbox: options.toolbox,
    conversation,
    stopWhen: mergeStopConditions(options.stopWhen, runtimeStopWhen),
    maximumSteps: options.maximumSteps,
    prepareStep: options.prepareStep,
    beforeToolExecution: options.beforeToolExecution,
    afterToolExecution: options.afterToolExecution,
    onStep: options.onStep,
    executeOptions: options.executeOptions,
    signal,
    collectAsync: options.collectAsync,
    retry: options.retry,
    validateResponse: options.validateResponse,
    validateToolResult: options.validateToolResult,
    selectTools: options.selectTools,
    contextManagement: options.contextManagement,
    responseSchema: options.responseSchema,
    schemaRetries: options.schemaRetries,
  };
}

/**
 * Creates a reusable agent definition that can be run multiple times.
 */
export function defineAgent(options: DefineAgentOptions): AgentDefinition {
  return {
    get name() {
      return options.name;
    },
    get options() {
      return options;
    },
    async run(input: string | AgentRunOptions): Promise<RunResult> {
      return run(buildRunOptions(options, input));
    },
    createRun(input: string | AgentRunOptions): ActiveRun {
      return createRun(buildRunOptions(options, input));
    },
  };
}
