import { ProviderError } from '../errors.ts';
import type {
  OpenAIBatch,
  OpenAIBatchClient,
  OpenAIBatchCreateRequest,
  OpenAIBatchListQuery,
} from '../types.ts';

/**
 * Options for createOpenAIBatchClient.
 *
 * There is deliberately no `baseURL` here, unlike every other OpenAI factory in
 * this package.
 *
 * `OpenAIProviderOptions.baseURL` exists to point the *chat* surface at an
 * OpenAI-compatible server — LM Studio, Ollama, vLLM, Groq. None of those
 * implement `/v1/batches`; they reuse the chat shape and nothing more. Offering
 * a `baseURL` knob on a batch factory would advertise a configuration that
 * cannot work, and would contradict `getProviderCapabilities('openai', {
 * baseURL })`, which reports `batchInference: false` for exactly that reason.
 *
 * A caller who genuinely has a batch-capable endpoint behind another origin — a
 * credential-injecting proxy in front of `api.openai.com`, say — constructs
 * their own `OpenAI` client with whatever `baseURL` they need and passes it as
 * `client`. That path is unchanged and needs no cast.
 */
export interface OpenAIBatchClientOptions {
  /**
   * An already-constructed client. A real `OpenAI` instance satisfies
   * {@link OpenAIBatchClient} with no cast — see
   * `providers/batch-client-assignability.test-d.ts`. This is also the escape
   * hatch for a non-default base URL; see the note on this interface.
   */
  client?: OpenAIBatchClient;
  /** Falls back to the SDK's own `OPENAI_API_KEY` lookup when omitted. */
  apiKey?: string;
}

/**
 * The OpenAI Batch API operations, error-normalized.
 *
 * A thin wrapper over `client.batches`: the verbs, the argument shapes, and the
 * returned objects are OpenAI's own. The wrapper adds a lazily constructed
 * client and {@link ProviderError} normalization, and nothing else.
 */
export interface OpenAIBatchOperations {
  /**
   * Creates a batch from an already-uploaded JSONL file. Unlike Anthropic and
   * Gemini, OpenAI accepts no inline requests: upload the file first (purpose
   * `batch`, through `client.files`) and name it by `input_file_id`.
   */
  create(request: OpenAIBatchCreateRequest): Promise<OpenAIBatch>;
  /** Polls one batch. `status: 'completed'` means `output_file_id` is set. */
  retrieve(batchId: string): Promise<OpenAIBatch>;
  /** Iterates batches, fetching further pages as it goes. */
  list(query?: OpenAIBatchListQuery): AsyncIterable<OpenAIBatch>;
  /**
   * Requests cancellation. The batch sits in `cancelling` for up to ten minutes
   * before reaching `cancelled` with whatever partial results it produced.
   */
  cancel(batchId: string): Promise<OpenAIBatch>;
}

/**
 * Creates a client for OpenAI's native Batch API.
 *
 * When no `client` is provided, dynamically imports `openai` and constructs one
 * from `apiKey` — so a consumer that never calls a batch method never loads the
 * SDK.
 *
 * There is no `results` operation, and that is not an omission: OpenAI returns
 * a batch's output as an uploaded file, so results are read through
 * `client.files` using the `output_file_id` (and `error_file_id`) on the
 * retrieved batch, not streamed off the batch itself.
 */
export function createOpenAIBatchClient(
  options: OpenAIBatchClientOptions = {},
): OpenAIBatchOperations {
  let clientPromise: Promise<OpenAIBatchClient> | undefined;

  function getClient(): Promise<OpenAIBatchClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('openai').then((module) => {
        const OpenAI = module.default ?? module.OpenAI;
        const clientOptions: { apiKey?: string } = {};
        if (options.apiKey) clientOptions.apiKey = options.apiKey;
        // No cast: a real `OpenAI` satisfies `OpenAIBatchClient` as declared,
        // the same guarantee a consumer passing their own client relies on.
        // `batch-client-assignability.test-d.ts` locks it in.
        return new OpenAI(clientOptions);
      });
    }
    return clientPromise;
  }

  function wrap(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    return new ProviderError({ provider: 'openai', cause: error });
  }

  return {
    async create(request: OpenAIBatchCreateRequest): Promise<OpenAIBatch> {
      try {
        const client = await getClient();
        return await client.batches.create(request);
      } catch (error) {
        throw wrap(error);
      }
    },

    async retrieve(batchId: string): Promise<OpenAIBatch> {
      try {
        const client = await getClient();
        return await client.batches.retrieve(batchId);
      } catch (error) {
        throw wrap(error);
      }
    },

    async *list(query?: OpenAIBatchListQuery): AsyncIterable<OpenAIBatch> {
      try {
        const client = await getClient();
        yield* client.batches.list(query);
      } catch (error) {
        throw wrap(error);
      }
    },

    async cancel(batchId: string): Promise<OpenAIBatch> {
      try {
        const client = await getClient();
        return await client.batches.cancel(batchId);
      } catch (error) {
        throw wrap(error);
      }
    },
  };
}
