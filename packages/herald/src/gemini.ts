import type { GeminiPart } from 'armorer/adapters/gemini';
import { parseGeminiToolCalls, toGeminiTools } from 'armorer/adapters/gemini';
import { toGeminiMessages } from 'conversationalist/adapters/gemini';

import { HeraldError } from './errors.ts';
import { resolveCommonParameters } from './resolve-common-parameters.ts';
import { toGeminiResponseFormat } from './structured-output/response-format-adapters.ts';
import { toGeminiToolChoice } from './structured-output/tool-choice-adapters.ts';
import type {
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GeminiStreamingModel,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
  StreamingHandle,
} from './types.ts';

/**
 * Creates a GenerateFunction backed by the Google Gemini API.
 *
 * When no `client` (a GenerativeModel instance) is provided, dynamically
 * imports `@google/generative-ai` and constructs one using `apiKey` or
 * the `GOOGLE_API_KEY` env var.
 */
export function createGeminiGenerate(options: GeminiProviderOptions): GenerateFunction {
  const { model } = options;
  const common = resolveCommonParameters(options);
  let modelPromise: Promise<GeminiGenerativeModel> | undefined;

  function getModel(): Promise<GeminiGenerativeModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!modelPromise) {
      modelPromise = import('@google/generative-ai').then((module) => {
        const GoogleGenerativeAI = module.GoogleGenerativeAI;
        const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'];
        if (!apiKey) {
          throw new HeraldError({
            provider: 'gemini',
            cause: undefined,
            message:
              '[herald:gemini] Missing API key: provide an apiKey option or set the GOOGLE_API_KEY environment variable.',
          });
        }
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
    if (hasTools && options.toolChoice)
      params['tool_config'] = toGeminiToolChoice(options.toolChoice);

    const generationConfig: Record<string, unknown> = {};
    if (common.maximumTokens !== undefined)
      generationConfig['maxOutputTokens'] = common.maximumTokens;
    if (common.temperature !== undefined) generationConfig['temperature'] = common.temperature;
    if (common.topP !== undefined) generationConfig['topP'] = common.topP;
    if (common.stopSequences) generationConfig['stopSequences'] = common.stopSequences;
    if (options.responseFormat) {
      const adapted = toGeminiResponseFormat(options.responseFormat);
      if (adapted !== undefined) Object.assign(generationConfig, adapted);
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

/**
 * Creates a StreamingGenerateFunction backed by the Google Gemini API.
 *
 * Streams chunks from the API, progressively calling `streaming.update`
 * with accumulated text and collecting function call parts into complete
 * ToolCallInput objects.
 *
 * When no `client` (a GeminiStreamingModel instance) is provided, dynamically
 * imports `@google/generative-ai` and constructs one using `apiKey` or
 * the `GOOGLE_API_KEY` env var.
 */
export function createGeminiGenerateStream(
  options: Omit<GeminiProviderOptions, 'client'> & { client?: GeminiStreamingModel },
): StreamingGenerateFunction {
  const { model } = options;
  const common = resolveCommonParameters(options);
  let modelPromise: Promise<GeminiStreamingModel> | undefined;

  function getModel(): Promise<GeminiStreamingModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!modelPromise) {
      modelPromise = import('@google/generative-ai').then((module) => {
        const GoogleGenerativeAI = module.GoogleGenerativeAI;
        const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'];
        if (!apiKey) {
          throw new HeraldError({
            provider: 'gemini',
            cause: undefined,
            message:
              '[herald:gemini] Missing API key: provide an apiKey option or set the GOOGLE_API_KEY environment variable.',
          });
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        return genAI.getGenerativeModel({ model }) as unknown as GeminiStreamingModel;
      });
    }
    return modelPromise;
  }

  return async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const generativeModel = await getModel();
    const { streaming } = context;
    const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
    const tools = toGeminiTools(context.toolbox);
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction !== undefined) params['systemInstruction'] = systemInstruction;
    if (hasTools) params['tools'] = tools;
    if (hasTools && options.toolChoice)
      params['tool_config'] = toGeminiToolChoice(options.toolChoice);

    const generationConfig: Record<string, unknown> = {};
    if (common.maximumTokens !== undefined)
      generationConfig['maxOutputTokens'] = common.maximumTokens;
    if (common.temperature !== undefined) generationConfig['temperature'] = common.temperature;
    if (common.topP !== undefined) generationConfig['topP'] = common.topP;
    if (common.stopSequences) generationConfig['stopSequences'] = common.stopSequences;
    if (options.responseFormat) {
      const adapted = toGeminiResponseFormat(options.responseFormat);
      if (adapted !== undefined) Object.assign(generationConfig, adapted);
    }

    if (Object.keys(generationConfig).length > 0) {
      params['generationConfig'] = generationConfig;
    }

    try {
      const result = await generativeModel.generateContentStream(params);

      let accumulatedText = '';
      const accumulatedFunctionCallParts: GeminiPart[] = [];
      let latestUsageMetadata:
        | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
        | undefined;

      for await (const chunk of result.stream) {
        if (context.signal?.aborted) break;
        const candidates = chunk.candidates ?? [];
        const parts = candidates[0]?.content?.parts ?? [];

        for (const part of parts) {
          if (part.text) {
            accumulatedText += part.text;
            streaming.update(accumulatedText);
          }
          if (part.functionCall) {
            accumulatedFunctionCallParts.push(part as unknown as GeminiPart);
          }
        }

        if (chunk.usageMetadata) {
          latestUsageMetadata = chunk.usageMetadata;
        }
      }

      const toolCalls = parseGeminiToolCalls(accumulatedFunctionCallParts);

      const usage = latestUsageMetadata
        ? {
            prompt: latestUsageMetadata.promptTokenCount ?? 0,
            completion: latestUsageMetadata.candidatesTokenCount ?? 0,
            total:
              latestUsageMetadata.totalTokenCount ??
              (latestUsageMetadata.promptTokenCount ?? 0) +
                (latestUsageMetadata.candidatesTokenCount ?? 0),
          }
        : undefined;

      return {
        content: accumulatedText,
        toolCalls,
        usage,
      };
    } catch (error) {
      throw new HeraldError({ provider: 'gemini', cause: error });
    }
  };
}
