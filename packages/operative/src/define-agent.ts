import { Conversation, isConversation } from 'conversationalist';

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

function resolveInstructions(instructions: DefineAgentOptions['instructions']): string | undefined {
  if (instructions === undefined) return undefined;
  if (typeof instructions === 'string') return instructions;
  return instructions.render();
}

function normalizeInput(
  input: string | AgentRunOptions,
  instructions?: string,
): {
  conversation: Conversation;
  signal?: AbortSignal;
  stopWhen?: StopCondition | StopCondition[];
  parentContext?: unknown;
} {
  if (typeof input === 'string') {
    const conversation = new Conversation();
    if (instructions) {
      conversation.appendSystemMessage(instructions);
    }
    conversation.appendUserMessage(input);
    return { conversation };
  }

  const { signal, stopWhen, parentContext } = input;
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

  return { conversation, signal, stopWhen, parentContext };
}

function mergeStopConditions(
  definition: DefineAgentOptions['stopWhen'],
  runtime: StopCondition | StopCondition[] | undefined,
): StopCondition[] | undefined {
  const defConditions = definition ? (Array.isArray(definition) ? definition : [definition]) : [];
  const runConditions = runtime ? (Array.isArray(runtime) ? runtime : [runtime]) : [];
  const merged = [...defConditions, ...runConditions];
  return merged.length > 0 ? merged : undefined;
}

function buildRunOptions(options: DefineAgentOptions, input: string | AgentRunOptions): RunOptions {
  const {
    conversation,
    signal,
    stopWhen: runtimeStopWhen,
    parentContext,
  } = normalizeInput(input, resolveInstructions(options.instructions));

  const { name: _, instructions: __, stopWhen: definitionStopWhen, ...rest } = options;

  return {
    ...rest,
    conversation,
    signal,
    stopWhen: mergeStopConditions(definitionStopWhen, runtimeStopWhen),
    ...(parentContext !== undefined && { parentContext }),
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
