import type { ResponseFormat } from './types.ts';

/**
 * OpenAI response_format parameter shape.
 */
type OpenAIResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; schema: Record<string, unknown>; strict: boolean };
    }
  | undefined;

/**
 * Gemini generationConfig fields for response format (camelCase per @google/generative-ai SDK).
 */
type GeminiResponseFormat =
  | { responseMimeType: 'application/json'; responseSchema?: Record<string, unknown> }
  | undefined;

/**
 * Converts a ResponseFormat to the OpenAI API's response_format parameter.
 *
 * Returns `undefined` for text format since OpenAI defaults to text.
 */
export function toOpenAIResponseFormat(format: ResponseFormat): OpenAIResponseFormat {
  if (format.type === 'text') return undefined;
  if (format.type === 'json') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name ?? 'response',
      schema: format.schema,
      strict: true,
    },
  };
}

/**
 * Converts a ResponseFormat to the Gemini API's generation config fields.
 *
 * Returns `undefined` for text format since Gemini defaults to text.
 */
export function toGeminiResponseFormat(format: ResponseFormat): GeminiResponseFormat {
  if (format.type === 'text') return undefined;
  if (format.type === 'json') return { responseMimeType: 'application/json' };
  return {
    responseMimeType: 'application/json',
    responseSchema: format.schema,
  };
}
