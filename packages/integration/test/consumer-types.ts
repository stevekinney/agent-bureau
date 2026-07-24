import type {
  GenerateFunction as OperativeGenerateFunction,
  RunResult as OperativeRunResult,
  StepResult as OperativeStepResult,
  StopCondition as OperativeStopCondition,
  ToolCall as OperativeToolCall,
} from '@lostgradient/operative';
// Operative store type compatibility assertions
import type {
  Action as OperativeStoreAction,
  RunState as OperativeStoreRunState,
  Store as OperativeStore,
  StoreState as OperativeStoreState,
} from '@lostgradient/operative/store';
import type {
  ToolCall as ArmorerToolCall,
  ToolError as ArmorerToolError,
  ToolResult as ArmorerToolResult,
} from 'armorer';
import { createToolbox } from 'armorer';
import type { AnthropicTool } from 'armorer/adapters/anthropic';
import type { GeminiTool } from 'armorer/adapters/gemini';
import type { OpenAITool } from 'armorer/adapters/openai';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
  materializeToolCalls,
  materializeToolResultsAsync,
  type ToolCall as ConversationalistToolCall,
  type ToolError as ConversationalistToolError,
  type ToolResult as ConversationalistToolResult,
} from 'conversationalist';
import type { AnthropicConversation } from 'conversationalist/adapters/anthropic';
import type { GeminiConversation } from 'conversationalist/adapters/gemini';
import type { OpenAIMessage } from 'conversationalist/adapters/openai';
import {
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
} from 'conversationalist/conversation';

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

const toolCallCompat: Assert<IsAssignable<ArmorerToolCall, ConversationalistToolCall>> = true;
const toolCallCompatReverse: Assert<IsAssignable<ConversationalistToolCall, ArmorerToolCall>> =
  true;
const toolErrorCompat: Assert<IsAssignable<ArmorerToolError, ConversationalistToolError>> = true;
const toolResultCompat: Assert<IsAssignable<ArmorerToolResult, ConversationalistToolResult>> = true;
void toolCallCompat;
void toolCallCompatReverse;
void toolErrorCompat;
void toolResultCompat;

const conversation = createConversationHistory();
const toolCalls: ArmorerToolCall[] = materializeToolCalls(
  [
    {
      name: 'get_weather',
      arguments: { location: 'Denver' },
    },
  ],
  {
    generateId: () => 'call-1',
  },
);
const toolResults: ArmorerToolResult[] = [
  {
    callId: 'call-1',
    outcome: 'success',
    content: { location: 'Denver' },
  },
];

const withCalls: ConversationHistory = appendToolCalls(conversation, toolCalls);
const withResults: ConversationHistory = appendToolResults(withCalls, toolResults);
void withResults;
void appendToolResultsAsync(withCalls, toolResults).then((nextConversation) => {
  const typedConversation: ConversationHistory = nextConversation;
  void typedConversation;
});
void materializeToolResultsAsync(toolResults).then((results) => {
  const typedResults: ConversationalistToolResult[] = results;
  void typedResults;
});

const openAITools: OpenAITool[] = [];
const anthropicTools: AnthropicTool[] = [];
const geminiTools: GeminiTool[] = [];

void createToolbox.fromProvider('openai', openAITools).then((toolbox) => {
  void toolbox.toProvider('openai');
  void toolbox.asExecuteResolver();
});
void createToolbox.fromProvider('anthropic', anthropicTools).then((toolbox) => {
  void toolbox.toProvider('anthropic');
});
void createToolbox.fromProvider('gemini', geminiTools).then((toolbox) => {
  void toolbox.toProvider('gemini');
});

const openAIMessages: OpenAIMessage[] = [];
const anthropicConversation: AnthropicConversation = { messages: [] };
const geminiConversation: GeminiConversation = { contents: [] };

void Conversation.fromProvider('openai', openAIMessages).then((conversationState) => {
  const typedConversationState: Conversation = conversationState;
  void typedConversationState.toProvider('openai', { groupToolCalls: true });
  void typedConversationState.appendProvider('openai', openAIMessages);
});
void Conversation.fromProvider('anthropic', anthropicConversation).then((conversationState) => {
  const typedConversationState: Conversation = conversationState;
  void typedConversationState.toProvider('anthropic');
  void typedConversationState.appendProvider('anthropic', anthropicConversation);
});
void Conversation.fromProvider('gemini', geminiConversation).then((conversationState) => {
  const typedConversationState: Conversation = conversationState;
  void typedConversationState.toProvider('gemini');
  void typedConversationState.appendProvider('gemini', geminiConversation);
});

// Operative type compatibility assertions
const operativeToolCallCompat: Assert<IsAssignable<OperativeToolCall, ArmorerToolCall>> = true;
const operativeToolCallCompatReverse: Assert<IsAssignable<ArmorerToolCall, OperativeToolCall>> =
  true;
const operativeToolCallConversationalistCompat: Assert<
  IsAssignable<OperativeToolCall, ConversationalistToolCall>
> = true;
void operativeToolCallCompat;
void operativeToolCallCompatReverse;
void operativeToolCallConversationalistCompat;

// Operative RunResult and StepResult are structurally valid
const _runResultCheck: OperativeRunResult = {} as OperativeRunResult;
const _stepResultCheck: OperativeStepResult = {} as OperativeStepResult;
const _generateFunctionCheck: OperativeGenerateFunction = {} as OperativeGenerateFunction;
const _stopConditionCheck: OperativeStopCondition = {} as OperativeStopCondition;
void _runResultCheck;
void _stepResultCheck;
void _generateFunctionCheck;
void _stopConditionCheck;

const _operativeStoreCheck: OperativeStore = {} as OperativeStore;
const _operativeStoreStateCheck: OperativeStoreState = {} as OperativeStoreState;
const _operativeStoreRunStateCheck: OperativeStoreRunState = {} as OperativeStoreRunState;
const _operativeStoreActionCheck: OperativeStoreAction = {} as OperativeStoreAction;
void _operativeStoreCheck;
void _operativeStoreStateCheck;
void _operativeStoreRunStateCheck;
void _operativeStoreActionCheck;
