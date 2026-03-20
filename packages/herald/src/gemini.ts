import type { GeminiPart } from 'armorer/adapters/gemini';
import { parseGeminiToolCalls, toGeminiTools } from 'armorer/adapters/gemini';
import { toGeminiMessages } from 'conversationalist/adapters/gemini';

import { HeraldError } from './errors.ts';
import type {
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
} from './types.ts';

/**
 * Creates a GenerateFunction backed by the Google Gemini API.
 *
 * When no `client` (a GenerativeModel instance) is provided, dynamically
 * imports `@google/generative-ai` and constructs one using `apiKey` or
 * the `GOOGLE_API_KEY` env var.
 */
export function createGeminiGenerate(options: GeminiProviderOptions): GenerateFunction {
  const { model, maximumTokens, temperature, topP, stopSequences } = options;
  let modelPromise: Promise<GeminiGenerativeModel> | undefined;

  function getModel(): Promise<GeminiGenerativeModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!modelPromise) {
      modelPromise = import('@google/generative-ai').then((module) => {
        const GoogleGenerativeAI = module.GoogleGenerativeAI;
        const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
        const genAI = new GoogleGenerativeAI(apiKey);
        return genAI.getGenerativeModel({ model }) as unknown as GeminiGenerativeModel;
      });
    }
    return modelPromise;
  }

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const generativeModel = await getModel();
    const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
    const tools = toGeminiTools(context.toolbox);
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction !== undefined) params['systemInstruction'] = systemInstruction;
    if (hasTools) params['tools'] = tools;

    const generationConfig: Record<string, unknown> = {};
    if (maximumTokens !== undefined) generationConfig['maxOutputTokens'] = maximumTokens;
    if (temperature !== undefined) generationConfig['temperature'] = temperature;
    if (topP !== undefined) generationConfig['topP'] = topP;
    if (stopSequences !== undefined && stopSequences.length > 0) {
      generationConfig['stopSequences'] = stopSequences;
    }

    if (Object.keys(generationConfig).length > 0) {
      params['generationConfig'] = generationConfig;
    }

    try {
      const result = await generativeModel.generateContent(params);

      const candidates = result.response.candidates ?? [];
      const parts = candidates[0]?.content?.parts ?? [];

      const textParts: string[] = [];
      for (const part of parts) {
        if (part.text) {
          textParts.push(part.text);
        }
      }

      const toolCalls = parseGeminiToolCalls(parts as unknown as GeminiPart[]);

      const usageMetadata = result.response.usageMetadata;
      const usage = usageMetadata
        ? {
            prompt: usageMetadata.promptTokenCount ?? 0,
            completion: usageMetadata.candidatesTokenCount ?? 0,
            total:
              usageMetadata.totalTokenCount ??
              (usageMetadata.promptTokenCount ?? 0) + (usageMetadata.candidatesTokenCount ?? 0),
          }
        : undefined;

      return {
        content: textParts.join(''),
        toolCalls,
        usage,
      };
    } catch (error) {
      throw new HeraldError({ provider: 'gemini', cause: error });
    }
  };
}
