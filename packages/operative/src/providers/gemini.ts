import type { GeminiPart } from 'armorer/adapters/gemini';
import { parseGeminiToolCalls } from 'armorer/adapters/gemini';
import { toGeminiMessages } from 'conversationalist/adapters/gemini';

import { ProviderError } from './errors.ts';
import { resolveGeminiEffort } from './shared/effort.ts';
import { resolveGeminiModel } from './shared/model-registry.ts';
import { resolveCommonParameters } from './shared/resolve-common-parameters.ts';
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
 *
 * Note: "Provider" here is distinct from the Vercel AI SDK's concept of
 * "provider". This factory returns a `GenerateFunction` — a plain async
 * function that produces a `GenerateResponse` — not an SDK provider object.
 */
export function createGeminiProvider(options: GeminiProviderOptions): GenerateFunction {
  const resolvedModel = resolveGeminiModel(options.model);
  const resolvedEffort = options.effort
    ? resolveGeminiEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  let modelPromise: Promise<GeminiGenerativeModel> | undefined;

  function getModel(): Promise<GeminiGenerativeModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!modelPromise) {
      modelPromise = import('@google/generative-ai').then((module) => {
        const GoogleGenerativeAI = module.GoogleGenerativeAI;
        const apiKey =
          options.apiKey ??
          (typeof Bun !== 'undefined' ? Bun.env['GOOGLE_API_KEY'] : process.env['GOOGLE_API_KEY']);
        if (!apiKey) {
          throw new ProviderError({
            provider: 'gemini',
            cause: undefined,
            message:
              '[provider:gemini] Missing API key: provide an apiKey option or set the GOOGLE_API_KEY environment variable.',
          });
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        const requestOptions = options.baseURL ? { baseUrl: options.baseURL } : undefined;
        return genAI.getGenerativeModel(
          { model: resolvedModel },
          requestOptions,
        ) as unknown as GeminiGenerativeModel;
      });
    }
    return modelPromise;
  }

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const generativeModel = await getModel();
    const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
    const tools = await context.toolbox.toGeminiTools();
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction !== undefined) params['systemInstruction'] = systemInstruction;
    if (hasTools && options.toolChoice !== 'none') params['tools'] = tools;
    if (hasTools && options.toolChoice && options.toolChoice !== 'none')
      params['toolConfig'] = toGeminiToolChoice(options.toolChoice);

    const generationConfig: Record<string, unknown> = {};
    const effectiveMaxOutputTokens = context.maximumTokens ?? common.maximumTokens;
    if (effectiveMaxOutputTokens !== undefined)
      generationConfig['maxOutputTokens'] = effectiveMaxOutputTokens;
    if (common.temperature !== undefined) generationConfig['temperature'] = common.temperature;
    if (common.topP !== undefined) generationConfig['topP'] = common.topP;
    if (common.stopSequences) generationConfig['stopSequences'] = common.stopSequences;
    if (resolvedEffort !== undefined) {
      generationConfig['thinkingConfig'] = { thinkingBudget: resolvedEffort.thinkingBudget };
    }
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
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ? resolvedEffort.effort : 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'gemini', cause: error });
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
export function createGeminiProviderStream(
  options: Omit<GeminiProviderOptions, 'client'> & { client?: GeminiStreamingModel },
): StreamingGenerateFunction {
  const resolvedModel = resolveGeminiModel(options.model);
  const resolvedEffort = options.effort
    ? resolveGeminiEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  let modelPromise: Promise<GeminiStreamingModel> | undefined;

  function getModel(): Promise<GeminiStreamingModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!modelPromise) {
      modelPromise = import('@google/generative-ai').then((module) => {
        const GoogleGenerativeAI = module.GoogleGenerativeAI;
        const apiKey =
          options.apiKey ??
          (typeof Bun !== 'undefined' ? Bun.env['GOOGLE_API_KEY'] : process.env['GOOGLE_API_KEY']);
        if (!apiKey) {
          throw new ProviderError({
            provider: 'gemini',
            cause: undefined,
            message:
              '[provider:gemini] Missing API key: provide an apiKey option or set the GOOGLE_API_KEY environment variable.',
          });
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        const requestOptions = options.baseURL ? { baseUrl: options.baseURL } : undefined;
        return genAI.getGenerativeModel(
          { model: resolvedModel },
          requestOptions,
        ) as unknown as GeminiStreamingModel;
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
    const tools = await context.toolbox.toGeminiTools();
    const hasTools = tools.length > 0;

    const params: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction !== undefined) params['systemInstruction'] = systemInstruction;
    if (hasTools && options.toolChoice !== 'none') params['tools'] = tools;
    if (hasTools && options.toolChoice && options.toolChoice !== 'none')
      params['toolConfig'] = toGeminiToolChoice(options.toolChoice);

    const generationConfig: Record<string, unknown> = {};
    const effectiveMaxOutputTokensStream = context.maximumTokens ?? common.maximumTokens;
    if (effectiveMaxOutputTokensStream !== undefined)
      generationConfig['maxOutputTokens'] = effectiveMaxOutputTokensStream;
    if (common.temperature !== undefined) generationConfig['temperature'] = common.temperature;
    if (common.topP !== undefined) generationConfig['topP'] = common.topP;
    if (common.stopSequences) generationConfig['stopSequences'] = common.stopSequences;
    if (resolvedEffort !== undefined) {
      generationConfig['thinkingConfig'] = { thinkingBudget: resolvedEffort.thinkingBudget };
    }
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
        metadata: {
          effectiveModel: resolvedModel,
          effectiveEffort: resolvedEffort ? resolvedEffort.effort : 'none',
        },
      };
    } catch (error) {
      throw new ProviderError({ provider: 'gemini', cause: error });
    }
  };
}
