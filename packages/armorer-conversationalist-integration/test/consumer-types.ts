import type {
  ToolCall,
  ToolConfiguration,
  ToolResult as ArmorerToolResult,
} from 'armorer';
import { createToolbox } from 'armorer';
import type { AnthropicTool } from 'armorer/adapters/anthropic';
import type { GeminiTool } from 'armorer/adapters/gemini';
import type { OpenAITool } from 'armorer/adapters/openai';
import {
  type ConversationHistory,
  Conversation,
  createConversationHistory,
} from 'conversationalist';
import {
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
} from 'conversationalist/conversation';
import type { AnthropicConversation } from 'conversationalist/adapters/anthropic';
import type { GeminiConversation } from 'conversationalist/adapters/gemini';
import type { OpenAIMessage } from 'conversationalist/adapters/openai';

const conversation = createConversationHistory();
const toolCalls: ToolCall[] = [
  {
    id: 'call-1',
    name: 'get_weather',
    arguments: { location: 'Denver' },
  },
];
const toolResults: ArmorerToolResult[] = [
  {
    callId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'get_weather',
    outcome: 'success',
    content: { location: 'Denver' },
    result: { location: 'Denver' },
  },
];

const withCalls: ConversationHistory = appendToolCalls(conversation, toolCalls);
const withResults: ConversationHistory = appendToolResults(withCalls, toolResults);
void withResults;
void appendToolResultsAsync(withCalls, toolResults).then((nextConversation) => {
  const typedConversation: ConversationHistory = nextConversation;
  void typedConversation;
});

const openAITools: OpenAITool[] = [];
const anthropicTools: AnthropicTool[] = [];
const geminiTools: GeminiTool[] = [];
const getTool = (
  configuration: Omit<ToolConfiguration, 'execute'>,
): ToolConfiguration['execute'] => async (parameters) => ({
  tool: configuration.name,
  parameters,
});

void createToolbox.fromOpenAITools(openAITools, { getTool }).then((toolbox) => {
  void toolbox.execute(toolCalls);
});
void createToolbox.fromAnthropicTools(anthropicTools, { getTool }).then((toolbox) => {
  void toolbox.execute(toolCalls);
});
void createToolbox.fromGeminiTools(geminiTools, { getTool }).then((toolbox) => {
  void toolbox.execute(toolCalls);
});

const openAIMessages: OpenAIMessage[] = [];
const anthropicConversation: AnthropicConversation = { messages: [] };
const geminiConversation: GeminiConversation = { contents: [] };

void Conversation.fromOpenAIMessages(openAIMessages).then((conversationState) => {
  const typedConversationState: Conversation = conversationState;
  void typedConversationState.toOpenAIMessages();
});
void Conversation.fromAnthropicMessages(anthropicConversation).then(
  (conversationState) => {
    const typedConversationState: Conversation = conversationState;
    void typedConversationState.toAnthropicMessages();
  },
);
void Conversation.fromGeminiMessages(geminiConversation).then((conversationState) => {
  const typedConversationState: Conversation = conversationState;
  void typedConversationState.toGeminiMessages();
});
