import { ProviderError } from '../errors.ts';
import type { BatchSurfaceRequirement } from '../shared/batch-support.ts';
import { assertBatchSurface } from '../shared/batch-support.ts';
import { resolveGeminiApiKey } from '../shared/gemini-api-key.ts';
import type {
  GeminiBatchClient,
  GeminiBatchJob,
  GeminiBatchJobReference,
  GeminiCreateBatchJobRequest,
  GeminiDeleteResourceJob,
  GeminiListBatchJobsRequest,
} from '../types.ts';

/**
 * `@google/genai` 1.7.0 introduced `client.batches`. The declared peer floor
 * (`>=2.19.0`) is already well above it, so this guard exists for symmetry with
 * OpenAI's and for installs that ignore peer warnings — see
 * `shared/batch-support.ts`.
 */
const GEMINI_BATCH_REQUIREMENT: BatchSurfaceRequirement = {
  provider: 'gemini',
  packageName: '@google/genai',
  minimumVersion: '1.7.0',
  path: ['batches'],
  methods: ['create', 'get', 'list', 'cancel', 'delete'],
};

/**
 * Options for createGeminiBatchClient.
 */
export interface GeminiBatchClientOptions {
  /**
   * An already-constructed client. A real `GoogleGenAI` instance satisfies
   * {@link GeminiBatchClient} with no cast — see
   * `providers/batch-client-assignability.test-d.ts`.
   */
  client?: GeminiBatchClient;
  /** Falls back to the `GOOGLE_API_KEY` environment variable when omitted. */
  apiKey?: string;
  /**
   * Overrides the Gemini SDK's default base URL (`HttpOptions.baseUrl`).
   * Accepts any string — including a credential-injecting proxy origin — with
   * no shape validation, matching `GeminiProviderOptions.baseURL`. A proxy in
   * front of Gemini still speaks the batches API, which is why
   * `getProviderCapabilities('gemini')` keeps reporting `batchInference: true`
   * regardless of this value.
   */
  baseURL?: string;
}

/**
 * The `@google/genai` batch-job operations, error-normalized.
 *
 * A thin wrapper over `client.batches`: the verbs, the argument shapes, and the
 * returned objects are Gemini's own, and they look nothing like Anthropic's or
 * OpenAI's. `create` takes `{ model, src, config }` rather than a request list
 * or a file id; jobs are addressed by server-generated resource name inside a
 * parameter object rather than by a bare id string; the retrieval verb is
 * `get`; `cancel` resolves to nothing; and Gemini alone can `delete` a job.
 * Flattening those into a shared shape would invent an API none of the three
 * providers actually has, so this interface keeps them.
 */
export interface GeminiBatchOperations {
  /**
   * Creates a batch job. `src` is Gemini's source union: inline requests, a
   * GCS or BigQuery URI, or the name of an uploaded file.
   */
  create(request: GeminiCreateBatchJobRequest): Promise<GeminiBatchJob>;
  /** Polls one job by resource name. `state` reports where it has got to. */
  get(reference: GeminiBatchJobReference): Promise<GeminiBatchJob>;
  /**
   * Iterates batch jobs, fetching further pages as it goes. Flattened from the
   * SDK's `Promise<Pager<…>>` to a plain `AsyncIterable` so a failure while
   * paging is wrapped too.
   */
  list(request?: GeminiListBatchJobsRequest): AsyncIterable<GeminiBatchJob>;
  /** Cancels a job. Gemini returns no body, so this resolves to nothing. */
  cancel(reference: GeminiBatchJobReference): Promise<void>;
  /** Deletes a job. Gemini alone among the three providers offers this. */
  delete(reference: GeminiBatchJobReference): Promise<GeminiDeleteResourceJob>;
}

/**
 * Creates a client for Gemini's native batch-jobs API.
 *
 * When no `client` is provided, dynamically imports `@google/genai` and
 * constructs one from `apiKey`/`baseURL` — so a consumer that never calls a
 * batch method never loads the SDK. The key comes from `apiKey` or the
 * `GOOGLE_API_KEY` environment variable, resolved by the same helper the
 * generate factories use; a missing key fails here rather than as an opaque
 * auth error on the first request.
 *
 * Requires `@google/genai >= 1.7.0`, the first release carrying
 * `client.batches`. The package's declared peer floor (`>=2.19.0`) is already
 * well above that, so this is a belt-and-braces check rather than a gap in the
 * range; a client without the namespace is rejected with a
 * {@link ProviderError} naming the requirement instead of failing with an
 * opaque `TypeError` on every operation.
 */
export function createGeminiBatchClient(
  options: GeminiBatchClientOptions = {},
): GeminiBatchOperations {
  if (options.client) assertBatchSurface(options.client, GEMINI_BATCH_REQUIREMENT);

  let clientPromise: Promise<GeminiBatchClient> | undefined;

  function getClient(): Promise<GeminiBatchClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      const apiKey = resolveGeminiApiKey(options.apiKey);
      // No cast: a real `GoogleGenAI` satisfies `GeminiBatchClient` as
      // declared, the same guarantee a consumer passing their own client
      // relies on. `batch-client-assignability.test-d.ts` locks it in.
      clientPromise = import('@google/genai').then((module) => {
        const client = new module.GoogleGenAI({
          apiKey,
          ...(options.baseURL ? { httpOptions: { baseUrl: options.baseURL } } : {}),
        });
        assertBatchSurface(client, GEMINI_BATCH_REQUIREMENT);
        return client;
      });
    }
    return clientPromise;
  }

  function wrap(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    return new ProviderError({ provider: 'gemini', cause: error });
  }

  return {
    async create(request: GeminiCreateBatchJobRequest): Promise<GeminiBatchJob> {
      try {
        const client = await getClient();
        return await client.batches.create(request);
      } catch (error) {
        throw wrap(error);
      }
    },

    async get(reference: GeminiBatchJobReference): Promise<GeminiBatchJob> {
      try {
        const client = await getClient();
        return await client.batches.get(reference);
      } catch (error) {
        throw wrap(error);
      }
    },

    async *list(request?: GeminiListBatchJobsRequest): AsyncIterable<GeminiBatchJob> {
      try {
        const client = await getClient();
        yield* await client.batches.list(request);
      } catch (error) {
        throw wrap(error);
      }
    },

    async cancel(reference: GeminiBatchJobReference): Promise<void> {
      try {
        const client = await getClient();
        await client.batches.cancel(reference);
      } catch (error) {
        throw wrap(error);
      }
    },

    async delete(reference: GeminiBatchJobReference): Promise<GeminiDeleteResourceJob> {
      try {
        const client = await getClient();
        return await client.batches.delete(reference);
      } catch (error) {
        throw wrap(error);
      }
    },
  };
}
