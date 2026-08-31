import { ProviderError } from '../errors.ts';
import type { BatchSurfaceRequirement } from '../shared/batch-support.ts';
import { assertBatchSurface } from '../shared/batch-support.ts';
import type {
  OpenAIBatch,
  OpenAIBatchClient,
  OpenAIBatchCreateRequest,
  OpenAIBatchListQuery,
} from '../types.ts';

/**
 * `openai` 4.34.0 introduced `client.batches` with `create`/`retrieve`/`cancel`;
 * `list` landed in 4.38.0. See `shared/batch-support.ts` for how both were
 * established and why the declared peer range stays `>=4.0.0`.
 */
const OPENAI_BATCH_REQUIREMENT: BatchSurfaceRequirement = {
  provider: 'openai',
  packageName: 'openai',
  minimumVersion: '4.38.0',
  path: ['batches'],
  methods: ['create', 'retrieve', 'list', 'cancel'],
};

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
 *
 * Omitting the knob does not pin the endpoint, though. A client this factory
 * constructs for itself carries no explicit `baseURL`, and `openai` documents
 * that option as defaulting to `process.env['OPENAI_BASE_URL']` — so an
 * ambient override routes these batch calls wherever it points.
 * `getProviderCapabilities('openai')` reads the same variable for exactly that
 * reason, so what it advertises and where a request lands stay in agreement.
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
 *
 * Requires `openai >= 4.38.0` — the first release whose `client.batches`
 * carries every method {@link OpenAIBatchOperations} advertises. The package's
 * declared peer range is intentionally wider (`>=4.0.0`), because chat-only
 * consumers should not be held to a batch-API floor; a client that predates
 * 4.38.0 is rejected here with a {@link ProviderError} naming the requirement
 * rather than failing with an opaque `TypeError` on every operation. An
 * injected `client` is checked when this factory is called; a lazily imported
 * one is checked as soon as it is constructed.
 */
export function createOpenAIBatchClient(
  options: OpenAIBatchClientOptions = {},
): OpenAIBatchOperations {
  if (options.client) assertBatchSurface(options.client, OPENAI_BATCH_REQUIREMENT);

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
        const client = new OpenAI(clientOptions);
        assertBatchSurface(client, OPENAI_BATCH_REQUIREMENT);
        return client;
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
