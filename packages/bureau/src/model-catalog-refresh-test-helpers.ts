import type { BackendDescriptor } from '@lostgradient/operative';
import type { MimeFamily, ModalityMatrix } from 'conversationalist';

import {
  type CatalogDescriptorSource,
  type CatalogRefreshRequest,
  createModelCatalogService,
  type ModelCatalogService,
} from './model-catalog-refresh';

export const UNSUPPORTED: ModalityMatrix[keyof ModalityMatrix] = {
  input: false,
  output: false,
  sourceForms: [],
};

export const FULL_MODALITIES: ModalityMatrix = Object.freeze({
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: UNSUPPORTED,
  document: UNSUPPORTED,
  audio: UNSUPPORTED,
  video: UNSUPPORTED,
  file: UNSUPPORTED,
});

export function descriptor(
  provider: BackendDescriptor['provider'],
  model: string,
  overrides: Partial<BackendDescriptor> = {},
): BackendDescriptor {
  return Object.freeze({
    descriptorVersion: 1,
    provider,
    endpoint: 'messages',
    model,
    aliases: [],
    lifecycle: 'stable',
    modalities: FULL_MODALITIES,
    mimeFamilies: ['text'] as readonly MimeFamily[],
    mediaLimits: [],
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    streaming: true,
    tools: true,
    parallelTools: true,
    structuredOutput: true,
    parameterCompatibility: [],
    caching: false,
    batchInference: false,
    explicitThinkingRequest: false,
    serverSideTokenCounting: false,
    effort: { portable: [], nativeMapping: 'unsupported' as const, degradesTo: {} },
    availability: 'available',
    health: 'unknown',
    source: 'static',
    freshness: '2026-09-02T00:00:00.000Z',
    ...overrides,
  });
}

export function createClock(startIso = '2026-09-02T00:00:00.000Z'): () => string {
  let counter = 0;
  return () => {
    const base = new Date(startIso).getTime();
    return new Date(base + counter++).toISOString();
  };
}

export function createIdMinter(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

export function createService(
  descriptorSource: CatalogDescriptorSource,
  overrides: { readonly initialDescriptors?: readonly BackendDescriptor[] } = {},
): { service: ModelCatalogService; now: () => string; newRefreshId: () => string } {
  const now = createClock();
  const newRefreshId = createIdMinter('refresh');
  const service = createModelCatalogService({
    seed: Object.freeze({
      revision: 1,
      descriptors: Object.freeze(
        overrides.initialDescriptors ?? [descriptor('anthropic', 'model-a')],
      ),
      generatedAt: now(),
      stale: false,
      projection: 'privileged',
    }),
    descriptorSource,
    now,
    newRefreshId,
  });
  return { service, now, newRefreshId };
}

export function request(id = 'request-1'): CatalogRefreshRequest {
  return { id, requestedAt: '2026-09-02T00:00:00.000Z' };
}
