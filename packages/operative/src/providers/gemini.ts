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

/** A function call as `@google/genai` reports it: every field optional. */
interface GeminiSdkFunctionCall {
  name?: string | undefined;
  args?: Record<string, unknown> | undefined;
}

/** A response part as `@google/genai` reports it: every field optional. */
interface GeminiSdkPart {
  text?: string | undefined;
  functionCall?: GeminiSdkFunctionCall | undefined;
}

/**
 * Narrows a `@google/genai` function call into armorer's stricter
 * `GeminiFunctionCallPart`, which requires both a name and an argument object.
 *
 * The maintained SDK marks `name` and `args` optional, so a call with no name
 * cannot be dispatched to any tool and is dropped, while a named call carrying
 * no arguments becomes an empty argument object.
 */
function toGeminiFunctionCallPart(functionCall: GeminiSdkFunctionCall): GeminiPart | undefined {
  if (functionCall.name === undefined) return undefined;
  return { functionCall: { name: functionCall.name, args: functionCall.args ?? {} } };
}

/**
 * `@google/genai` models a response part as a single object with every field
 * optional, while armorer's `GeminiPart` is a union whose variants each require
 * their own field. Narrow the SDK shape into that union, dropping parts that
 * carry neither text nor a dispatchable function call.
 */
function toGeminiParts(parts: ReadonlyArray<GeminiSdkPart>): GeminiPart[] {
  const narrowed: GeminiPart[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      const functionCallPart = toGeminiFunctionCallPart(part.functionCall);
      if (functionCallPart) narrowed.push(functionCallPart);
    } else if (part.text !== undefined) {
      narrowed.push({ text: part.text });
    }
  }
  return narrowed;
}

/**
 * Builds the `config` block shared by the streaming and non-streaming Gemini
 * request bodies.
 *
 * `@google/genai` takes a single flat `GenerateContentConfig` — the frozen
 * SDK's separate top-level `systemInstruction` / `tools` / `toolConfig` fields
 * and its nested `generationConfig` object all collapse into it.
 */
function buildGeminiConfig(input: {
  systemInstruction: unknown;
  tools: unknown[];
  toolChoice: GeminiProviderOptions['toolChoice'];
  responseFormat: GeminiProviderOptions['responseFormat'];
  maximumTokens: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  stopSequences: readonly string[] | undefined;
  thinkingBudget: number | undefined;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const hasTools = input.tools.length > 0;

  if (input.systemInstruction !== undefined) config['systemInstruction'] = input.systemInstruction;
  if (hasTools && input.toolChoice !== 'none') config['tools'] = input.tools;
  if (hasTools && input.toolChoice && input.toolChoice !== 'none')
    config['toolConfig'] = toGeminiToolChoice(input.toolChoice);

  if (input.maximumTokens !== undefined) config['maxOutputTokens'] = input.maximumTokens;
  if (input.temperature !== undefined) config['temperature'] = input.temperature;
  if (input.topP !== undefined) config['topP'] = input.topP;
  if (input.stopSequences) config['stopSequences'] = input.stopSequences;
  if (input.thinkingBudget !== undefined) {
    config['thinkingConfig'] = { thinkingBudget: input.thinkingBudget };
  }
  if (input.responseFormat) {
    const adapted = toGeminiResponseFormat(input.responseFormat);
    if (adapted !== undefined) Object.assign(config, adapted);
  }

  return config;
}

/**
 * Resolves the API key from the explicit option or the `GOOGLE_API_KEY`
 * environment variable, throwing a `ProviderError` when neither is set.
 */
function resolveGeminiApiKey(apiKey: string | undefined): string {
  const resolved =
    apiKey ??
    (typeof Bun !== 'undefined' ? Bun.env['GOOGLE_API_KEY'] : process.env['GOOGLE_API_KEY']);
  if (!resolved) {
    throw new ProviderError({
      provider: 'gemini',
      cause: undefined,
      message:
        '[provider:gemini] Missing API key: provide an apiKey option or set the GOOGLE_API_KEY environment variable.',
    });
  }
  return resolved;
}

/**
 * Dynamically imports `@google/genai` and constructs a `GoogleGenAI` client.
 *
 * The returned client is cast to the local structural interface: that interface
 * intentionally widens the request parameter to `Record<string, unknown>` so
 * consumer fakes stay trivial to write, which makes it contravariantly
 * incompatible with the SDK's precise `GenerateContentParameters` even though
 * the runtime shape is exactly what the SDK expects.
 */
async function importGeminiClient<T>(options: {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
}): Promise<T> {
  const module = await import('@google/genai');
  const apiKey = resolveGeminiApiKey(options.apiKey);
  const client = new module.GoogleGenAI({
    apiKey,
    ...(options.baseURL ? { httpOptions: { baseUrl: options.baseURL } } : {}),
  });
  return client as unknown as T;
}

/**
 * Creates a GenerateFunction backed by the Google Gemini API.
 *
 * When no `client` (a `GoogleGenAI` instance) is provided, dynamically
 * imports `@google/genai` and constructs one using `apiKey` or
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
  let clientPromise: Promise<GeminiGenerativeModel> | undefined;

  function getClient(): Promise<GeminiGenerativeModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = importGeminiClient<GeminiGenerativeModel>(options);
    }
    return clientPromise;
  }

  return async (context: GenerateContext): Promise<GenerateResponse> => {
    const client = await getClient();
    const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
    const tools = await context.toolbox.toGeminiTools();

    const config = buildGeminiConfig({
      systemInstruction,
      tools,
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat,
      maximumTokens: context.maximumTokens ?? common.maximumTokens,
      temperature: common.temperature,
      topP: common.topP,
      stopSequences: common.stopSequences,
      thinkingBudget: resolvedEffort?.thinkingBudget,
    });

    const params: Record<string, unknown> = {
      model: resolvedModel,
      contents,
    };

    if (Object.keys(config).length > 0) {
      params['config'] = config;
    }

    try {
      const result = await client.models.generateContent(params);

      const candidates = result.candidates ?? [];
      const parts = candidates[0]?.content?.parts ?? [];

      const textParts: string[] = [];
      for (const part of parts) {
        if (part.text) {
          textParts.push(part.text);
        }
      }

      const toolCalls = parseGeminiToolCalls(toGeminiParts(parts));

      const usageMetadata = result.usageMetadata;
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
 * When no `client` (a `GoogleGenAI` instance) is provided, dynamically
 * imports `@google/genai` and constructs one using `apiKey` or
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
  let clientPromise: Promise<GeminiStreamingModel> | undefined;

  function getClient(): Promise<GeminiStreamingModel> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = importGeminiClient<GeminiStreamingModel>(options);
    }
    return clientPromise;
  }

  return async (
    context: GenerateContext & { streaming: StreamingHandle },
  ): Promise<GenerateResponse> => {
    const client = await getClient();
    const { streaming } = context;
    const { systemInstruction, contents } = toGeminiMessages(context.conversation.current);
    const tools = await context.toolbox.toGeminiTools();

    const config = buildGeminiConfig({
      systemInstruction,
      tools,
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat,
      maximumTokens: context.maximumTokens ?? common.maximumTokens,
      temperature: common.temperature,
      topP: common.topP,
      stopSequences: common.stopSequences,
      thinkingBudget: resolvedEffort?.thinkingBudget,
    });

    const params: Record<string, unknown> = {
      model: resolvedModel,
      contents,
    };

    if (Object.keys(config).length > 0) {
      params['config'] = config;
    }

    try {
      const stream = await client.models.generateContentStream(params);

      let accumulatedText = '';
      const accumulatedFunctionCallParts: GeminiPart[] = [];
      let latestUsageMetadata:
        | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
        | undefined;

      for await (const chunk of stream) {
        if (context.signal?.aborted) break;
        const candidates = chunk.candidates ?? [];
        const parts = candidates[0]?.content?.parts ?? [];

        for (const part of parts) {
          if (part.text) {
            accumulatedText += part.text;
            streaming.update(accumulatedText);
          }
          if (part.functionCall) {
            const functionCallPart = toGeminiFunctionCallPart(part.functionCall);
            if (functionCallPart) accumulatedFunctionCallParts.push(functionCallPart);
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
