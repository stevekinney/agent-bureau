import { Conversation, isConversation } from 'conversationalist';

import type { AgentSession } from './agent-session';
import { createAgentSession, loadAgentSession, saveAgentSession } from './agent-session';
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

  const {
    name: _name,
    instructions: _instructions,
    stopWhen: definitionStopWhen,
    persistence: _persistence,
    sessionId: _sessionId,
    onSessionSave: _onSessionSave,
    onSessionLoad: _onSessionLoad,
    autoSave: _autoSave,
    ...rest
  } = options;

  return {
    ...rest,
    conversation,
    signal,
    stopWhen: mergeStopConditions(definitionStopWhen, runtimeStopWhen),
    ...(parentContext !== undefined && { parentContext }),
  };
}

async function runWithSessionLifecycle(
  options: DefineAgentOptions,
  runOptions: RunOptions,
): Promise<RunResult> {
  const { persistence, sessionId, onSessionLoad, onSessionSave, autoSave = 'completion' } = options;

  let session: AgentSession | undefined;

  // Load existing session if persistence and sessionId are configured
  if (persistence && sessionId) {
    session = await loadAgentSession(persistence, sessionId);
    if (session) {
      await onSessionLoad?.(session);
      // Use the loaded conversation history
      runOptions = { ...runOptions, conversation: new Conversation(session.conversationHistory) };
    }
  }

  // Wrap onStep for autoSave: 'step'
  if (persistence && autoSave === 'step') {
    const originalOnStep = runOptions.onStep;
    runOptions = {
      ...runOptions,
      onStep: async (stepResult) => {
        if (originalOnStep) {
          await originalOnStep(stepResult);
        }
        session = session
          ? {
              ...session,
              conversationHistory: stepResult.conversation.current,
              updatedAt: new Date().toISOString(),
            }
          : createAgentSession({
              agentName: options.name,
              conversationHistory: stepResult.conversation.current,
              id: sessionId,
            });
        await saveAgentSession(persistence, session);
        await onSessionSave?.(session);
      },
    };
  }

  const result = await run(runOptions);

  // Save session on completion
  if (persistence && autoSave !== false) {
    if (autoSave !== 'step') {
      session = session
        ? {
            ...session,
            conversationHistory: result.conversation.current,
            updatedAt: new Date().toISOString(),
          }
        : createAgentSession({
            agentName: options.name,
            conversationHistory: result.conversation.current,
            id: sessionId,
          });
      await saveAgentSession(persistence, session);
      await onSessionSave?.(session);
    }
  }

  return result;
}

function createRunWithSessionLifecycle(
  options: DefineAgentOptions,
  runOptions: RunOptions,
): ActiveRun {
  const { persistence, sessionId, onSessionLoad, onSessionSave, autoSave = 'completion' } = options;

  // Wrap onStep for autoSave: 'step'
  const modifiedRunOptions = { ...runOptions };
  if (persistence && autoSave === 'step') {
    let session: AgentSession | undefined;
    const originalOnStep = runOptions.onStep;
    modifiedRunOptions.onStep = async (stepResult) => {
      if (originalOnStep) {
        await originalOnStep(stepResult);
      }
      session = session
        ? {
            ...session,
            conversationHistory: stepResult.conversation.current,
            updatedAt: new Date().toISOString(),
          }
        : createAgentSession({
            agentName: options.name,
            conversationHistory: stepResult.conversation.current,
            id: sessionId,
          });
      await saveAgentSession(persistence, session);
      await onSessionSave?.(session);
    };
  }

  const activeRun = createRun(modifiedRunOptions);

  if (persistence && sessionId) {
    // Load session before the run starts, emit events, and handle completion
    const originalResult = activeRun.result;
    const wrappedResult = (async () => {
      const loadedSession = await loadAgentSession(persistence, sessionId);
      if (loadedSession) {
        await onSessionLoad?.(loadedSession);
      }

      const result = await originalResult;

      if (autoSave !== false && autoSave !== 'step') {
        const session = loadedSession
          ? {
              ...loadedSession,
              conversationHistory: result.conversation.current,
              updatedAt: new Date().toISOString(),
            }
          : createAgentSession({
              agentName: options.name,
              conversationHistory: result.conversation.current,
              id: sessionId,
            });
        await saveAgentSession(persistence, session);
        await onSessionSave?.(session);
      }

      return result;
    })();

    return { ...activeRun, result: wrappedResult };
  }

  if (persistence && autoSave !== false && autoSave !== 'step') {
    const originalResult = activeRun.result;
    const wrappedResult = (async () => {
      const result = await originalResult;
      const session = createAgentSession({
        agentName: options.name,
        conversationHistory: result.conversation.current,
        id: sessionId,
      });
      await saveAgentSession(persistence, session);
      await onSessionSave?.(session);
      return result;
    })();

    return { ...activeRun, result: wrappedResult };
  }

  return activeRun;
}

/**
 * Creates a reusable agent definition that can be run multiple times.
 */
export function defineAgent(options: DefineAgentOptions): AgentDefinition {
  const hasPersistence = options.persistence !== undefined;

  return {
    get name() {
      return options.name;
    },
    get options() {
      return options;
    },
    async run(input: string | AgentRunOptions): Promise<RunResult> {
      const runOptions = buildRunOptions(options, input);
      if (hasPersistence) {
        return runWithSessionLifecycle(options, runOptions);
      }
      return run(runOptions);
    },
    createRun(input: string | AgentRunOptions): ActiveRun {
      const runOptions = buildRunOptions(options, input);
      if (hasPersistence) {
        return createRunWithSessionLifecycle(options, runOptions);
      }
      return createRun(runOptions);
    },
  };
}
