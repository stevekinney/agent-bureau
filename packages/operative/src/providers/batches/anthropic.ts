import { ProviderError } from '../errors.ts';
import type {
  AnthropicBatchClient,
  AnthropicBatchCreateRequest,
  AnthropicBatchListQuery,
  AnthropicMessageBatch,
  AnthropicMessageBatchIndividualResponse,
} from '../types.ts';

/**
 * Options for createAnthropicBatchClient.
 */
export interface AnthropicBatchClientOptions {
  /**
   * An already-constructed client. A real `Anthropic` instance satisfies
   * {@link AnthropicBatchClient} with no cast — see
   * `providers/batch-client-assignability.test-d.ts`.
   */
  client?: AnthropicBatchClient;
  /** Falls back to the SDK's own `ANTHROPIC_API_KEY` lookup when omitted. */
  apiKey?: string;
  /**
   * Overrides the Anthropic SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape validation,
   * matching `AnthropicProviderOptions.baseURL`. A proxy in front of Anthropic
   * still speaks the Message Batches API, which is why
   * `getProviderCapabilities('anthropic')` keeps reporting `batchInference:
   * true` regardless of this value.
   */
  baseURL?: string;
}

/**
 * The Anthropic Message Batches operations, error-normalized.
 *
 * A thin wrapper over `client.messages.batches`: the verbs, the argument
 * shapes, and the returned objects are Anthropic's own. The wrapper adds two
 * things and nothing else — a lazily constructed client, and {@link
 * ProviderError} normalization so batch failures classify and retry the same
 * way generate failures already do.
 */
export interface AnthropicBatchOperations {
  /** Submits a batch of Messages requests. Processing starts immediately. */
  create(request: AnthropicBatchCreateRequest): Promise<AnthropicMessageBatch>;
  /** Polls one batch. `processing_status: 'ended'` means results are ready. */
  retrieve(batchId: string): Promise<AnthropicMessageBatch>;
  /** Iterates batches, most recent first, fetching further pages as it goes. */
  list(query?: AnthropicBatchListQuery): AsyncIterable<AnthropicMessageBatch>;
  /** Requests cancellation. In-progress requests may still complete. */
  cancel(batchId: string): Promise<AnthropicMessageBatch>;
  /**
   * Streams one batch's results, one line of the `.jsonl` file per item.
   * Results are not guaranteed to be in request order — match them up by
   * `custom_id`. Flattened from the SDK's `Promise<AsyncIterable<…>>` to a
   * plain `AsyncIterable` so a failure mid-stream is wrapped too.
   */
  results(batchId: string): AsyncIterable<AnthropicMessageBatchIndividualResponse>;
}

/**
 * Creates a client for Anthropic's native Message Batches API.
 *
 * When no `client` is provided, dynamically imports `@anthropic-ai/sdk` and
 * constructs one from `apiKey`/`baseURL` — so a consumer that never calls a
 * batch method never loads the SDK.
 *
 * Batching is a genuinely different lifecycle from a generate call: submit,
 * poll for up to 24 hours, then read results. This factory exposes exactly that
 * and does not pretend to be a `GenerateFunction`.
 */
export function createAnthropicBatchClient(
  options: AnthropicBatchClientOptions = {},
): AnthropicBatchOperations {
  let clientPromise: Promise<AnthropicBatchClient> | undefined;

  function getClient(): Promise<AnthropicBatchClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((module) => {
        const Anthropic = module.default ?? module.Anthropic;
        const clientOptions: { apiKey?: string; baseURL?: string } = {};
        if (options.apiKey) clientOptions.apiKey = options.apiKey;
        if (options.baseURL) clientOptions.baseURL = options.baseURL;
        // No cast: a real `Anthropic` satisfies `AnthropicBatchClient` as
        // declared, the same guarantee a consumer passing their own client
        // relies on. `batch-client-assignability.test-d.ts` locks it in.
        return new Anthropic(clientOptions);
      });
    }
    return clientPromise;
  }

  function wrap(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    return new ProviderError({ provider: 'anthropic', cause: error });
  }

  return {
    async create(request: AnthropicBatchCreateRequest): Promise<AnthropicMessageBatch> {
      try {
        const client = await getClient();
        return await client.messages.batches.create(request);
      } catch (error) {
        throw wrap(error);
      }
    },

    async retrieve(batchId: string): Promise<AnthropicMessageBatch> {
      try {
        const client = await getClient();
        return await client.messages.batches.retrieve(batchId);
      } catch (error) {
        throw wrap(error);
      }
    },

    async *list(query?: AnthropicBatchListQuery): AsyncIterable<AnthropicMessageBatch> {
      try {
        const client = await getClient();
        yield* client.messages.batches.list(query);
      } catch (error) {
        throw wrap(error);
      }
    },

    async cancel(batchId: string): Promise<AnthropicMessageBatch> {
      try {
        const client = await getClient();
        return await client.messages.batches.cancel(batchId);
      } catch (error) {
        throw wrap(error);
      }
    },

    async *results(batchId: string): AsyncIterable<AnthropicMessageBatchIndividualResponse> {
      try {
        const client = await getClient();
        yield* await client.messages.batches.results(batchId);
      } catch (error) {
        throw wrap(error);
      }
    },
  };
}
