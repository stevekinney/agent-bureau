import type { ToolChoice } from './types.ts';

/**
 * Anthropic tool_choice parameter shape.
 */
type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | undefined;

/**
 * OpenAI tool_choice parameter shape.
 */
type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

/**
 * Gemini tool_config parameter shape.
 */
type GeminiToolConfig = {
  function_calling_config: {
    mode: 'AUTO' | 'ANY' | 'NONE';
    allowed_function_names?: string[];
  };
};

/**
 * Converts a ToolChoice to the Anthropic API's tool_choice format.
 *
 * When `'none'` is passed, returns `undefined` — the caller should omit
 * the tools array entirely from the Anthropic request.
 */
export function toAnthropicToolChoice(choice: ToolChoice): AnthropicToolChoice {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return undefined;
  return { type: 'tool', name: choice.tool };
}

/**
 * Converts a ToolChoice to the OpenAI API's tool_choice format.
 */
export function toOpenAIToolChoice(choice: ToolChoice): OpenAIToolChoice {
  if (choice === 'auto') return 'auto';
  if (choice === 'required') return 'required';
  if (choice === 'none') return 'none';
  return { type: 'function', function: { name: choice.tool } };
}

/**
 * Converts a ToolChoice to the Gemini API's tool_config format.
 */
export function toGeminiToolChoice(choice: ToolChoice): GeminiToolConfig {
  if (choice === 'auto') return { function_calling_config: { mode: 'AUTO' } };
  if (choice === 'required') return { function_calling_config: { mode: 'ANY' } };
  if (choice === 'none') return { function_calling_config: { mode: 'NONE' } };
  return {
    function_calling_config: { mode: 'ANY', allowed_function_names: [choice.tool] },
  };
}
