/**
 * AB-64's Catalog discipline (AC8) — the `'general'`/`'privileged'` catalog
 * projection (AB-247/mod-02e). Written test-first: every assertion below
 * encodes one of this issue's acceptance criteria.
 */
import { describe, expect, it } from 'bun:test';

import { type BackendDescriptor, createModelCatalog } from './model-catalog.ts';
import {
  GENERAL_PROJECTION_REDACTED_KEYS,
  projectCatalog,
  projectDescriptor,
} from './model-catalog-projection.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const fixedNow = () => FIXED_NOW;

/**
 * A synthetic descriptor with every `BackendDescriptor` field populated —
 * including every optional one (`generatedAssetBehavior`, `endpointAmbiguous`,
 * `pricing`) and a URL-shaped `endpoint` — so the exhaustive key-enumeration
 * test walks every key the type declares, not only the keys the static seed
 * happens to set. Frozen so a test accidentally mutating it fails loudly
 * rather than corrupting another test.
 */
const FULL_DESCRIPTOR: BackendDescriptor = Object.freeze({
  descriptorVersion: 1,
  provider: 'openai',
  endpoint: 'https://proxy.internal.example.com/v1/chat/completions',
  model: 'gpt-4.1',
  aliases: Object.freeze([{ alias: 'gpt-4.1-alias', resolvesTo: 'gpt-4.1' }]),
  lifecycle: 'stable',
  modalities: Object.freeze({
    text: Object.freeze({
      input: true,
      output: true,
      sourceForms: Object.freeze(['inline'] as const),
    }),
    image: Object.freeze({ input: false, output: false, sourceForms: Object.freeze([]) }),
    document: Object.freeze({ input: false, output: false, sourceForms: Object.freeze([]) }),
    audio: Object.freeze({ input: false, output: false, sourceForms: Object.freeze([]) }),
    video: Object.freeze({ input: false, output: false, sourceForms: Object.freeze([]) }),
    file: Object.freeze({ input: false, output: false, sourceForms: Object.freeze([]) }),
  }),
  mimeFamilies: Object.freeze(['text'] as const),
  mediaLimits: Object.freeze([]),
  generatedAssetBehavior: Object.freeze([
    Object.freeze({
      modality: 'image' as const,
      synchronous: true,
      maxConcurrentGenerations: 1,
    }),
  ]),
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  streaming: true,
  tools: true,
  parallelTools: true,
  structuredOutput: true,
  parameterCompatibility: Object.freeze(['model'] as const),
  caching: false,
  batchInference: true,
  explicitThinkingRequest: false,
  serverSideTokenCounting: false,
  effort: Object.freeze({
    portable: Object.freeze(['low'] as const),
    nativeMapping: 'unsupported',
    degradesTo: Object.freeze({ low: 'low' as const }),
  }),
  endpointAmbiguous: true,
  pricing: Object.freeze({ inputPerMillionTokens: 1, outputPerMillionTokens: 2, currency: 'USD' }),
  availability: 'unknown',
  health: 'unknown',
  source: 'static',
  freshness: FIXED_NOW,
});

describe('projectDescriptor: general projection redacts exactly AC8s four things', () => {
  it('omits pricing entirely', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(Object.prototype.hasOwnProperty.call(general, 'pricing')).toBe(false);
    expect(general.pricing).toBeUndefined();
  });

  it('replaces endpoint with the bare operation name, stripping host and origin detail', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(general.endpoint).toBe('v1/chat/completions');
    expect(general.endpoint.includes('proxy.internal.example.com')).toBe(false);
    expect(general.endpoint.includes('://')).toBe(false);
  });

  it('falls back to the raw endpoint value when it contains "://" but does not parse as a URL', () => {
    const unparseable = { ...FULL_DESCRIPTOR, endpoint: 'http://[invalid' };
    const general = projectDescriptor(unparseable, 'general');
    expect(general.endpoint).toBe('http://[invalid');
  });

  it('is a no-op on an already-bare endpoint, matching the real seed rows', () => {
    const seedDescriptor = createModelCatalog({ now: fixedNow }).descriptors.find(
      (descriptor) => descriptor.provider === 'anthropic',
    );
    if (!seedDescriptor) throw new Error('expected at least one Anthropic seed descriptor');
    const general = projectDescriptor(seedDescriptor, 'general');
    expect(general.endpoint).toBe(seedDescriptor.endpoint);
    expect(general.endpoint).toBe('messages');
  });

  it('omits endpointAmbiguous, because it discloses a configured proxy or custom base URL', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(Object.prototype.hasOwnProperty.call(general, 'endpointAmbiguous')).toBe(false);
    expect(general.endpointAmbiguous).toBeUndefined();
  });

  it('retains availability, health, source, and freshness so a caller can tell an unavailable backend from an available one', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(general.availability).toBe(FULL_DESCRIPTOR.availability);
    expect(general.health).toBe(FULL_DESCRIPTOR.health);
    expect(general.source).toBe(FULL_DESCRIPTOR.source);
    expect(general.freshness).toBe(FULL_DESCRIPTOR.freshness);
  });

  it('retains every other field unchanged', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(general.descriptorVersion).toBe(FULL_DESCRIPTOR.descriptorVersion);
    expect(general.provider).toBe(FULL_DESCRIPTOR.provider);
    expect(general.model).toBe(FULL_DESCRIPTOR.model);
    expect(general.aliases).toEqual(FULL_DESCRIPTOR.aliases);
    expect(general.modalities).toEqual(FULL_DESCRIPTOR.modalities);
    expect(general.contextWindowTokens).toBe(FULL_DESCRIPTOR.contextWindowTokens);
    expect(general.effort).toEqual(FULL_DESCRIPTOR.effort);
  });
});

describe('projectDescriptor: exhaustive key enumeration (AB-247)', () => {
  it('accounts for every BackendDescriptor key: present in general, or named in GENERAL_PROJECTION_REDACTED_KEYS', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    const keys = Object.keys(FULL_DESCRIPTOR) as (keyof BackendDescriptor)[];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const isRedacted = GENERAL_PROJECTION_REDACTED_KEYS.includes(key);
      const isPresent = Object.prototype.hasOwnProperty.call(general, key);
      // Every key is exactly one of "redacted" or "present" — never neither
      // (a silently dropped field) and never both (a field claimed redacted
      // that the implementation still emits).
      expect(isRedacted).toBe(!isPresent);
    }
  });

  it('GENERAL_PROJECTION_REDACTED_KEYS names only real BackendDescriptor keys', () => {
    const keys = new Set(Object.keys(FULL_DESCRIPTOR));
    for (const key of GENERAL_PROJECTION_REDACTED_KEYS) {
      expect(keys.has(key)).toBe(true);
    }
  });
});

describe('projectDescriptor: privileged projection', () => {
  it('returns a value structurally equal to its input, dropping no field', () => {
    const privileged = projectDescriptor(FULL_DESCRIPTOR, 'privileged');
    expect(privileged).toEqual(FULL_DESCRIPTOR);
    expect(Object.keys(privileged).sort()).toEqual(Object.keys(FULL_DESCRIPTOR).sort());
  });
});

describe('projectDescriptor: purity and immutability', () => {
  it('never mutates its input', () => {
    const before = JSON.parse(JSON.stringify(FULL_DESCRIPTOR)) as unknown;
    projectDescriptor(FULL_DESCRIPTOR, 'general');
    projectDescriptor(FULL_DESCRIPTOR, 'privileged');
    expect(JSON.parse(JSON.stringify(FULL_DESCRIPTOR))).toEqual(before);
  });

  it('is deterministic: repeated calls with the same input produce structurally equal output', () => {
    const first = projectDescriptor(FULL_DESCRIPTOR, 'general');
    const second = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(first).toEqual(second);
  });

  it('returns a deeply frozen value for both projections', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    const privileged = projectDescriptor(FULL_DESCRIPTOR, 'privileged');
    for (const value of [general, privileged]) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.aliases)).toBe(true);
      expect(Object.isFrozen(value.modalities)).toBe(true);
      expect(Object.isFrozen(value.effort)).toBe(true);
      expect(Object.isFrozen(value.effort.degradesTo)).toBe(true);
    }
  });

  it('rejects mutation of the frozen result', () => {
    const general = projectDescriptor(FULL_DESCRIPTOR, 'general');
    expect(() => {
      // @ts-expect-error -- deliberately mutating a readonly field to prove it's frozen at runtime.
      general.model = 'mutated';
    }).toThrow(TypeError);
  });
});

describe('projectCatalog', () => {
  it('projects every descriptor and stamps projection: general', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const general = projectCatalog(catalog, 'general');
    expect(general.projection).toBe('general');
    expect(general.descriptors.length).toBe(catalog.descriptors.length);
    for (const descriptor of general.descriptors) {
      expect(Object.prototype.hasOwnProperty.call(descriptor, 'pricing')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(descriptor, 'endpointAmbiguous')).toBe(false);
    }
  });

  it('passes through revision, generatedAt, and stale unchanged', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const general = projectCatalog(catalog, 'general');
    expect(general.revision).toBe(catalog.revision);
    expect(general.generatedAt).toBe(catalog.generatedAt);
    expect(general.stale).toBe(catalog.stale);
  });

  it('privileged projection is structurally equal to its input except for the projection field, dropping no field', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const privileged = projectCatalog(catalog, 'privileged');
    expect(privileged.projection).toBe('privileged');
    expect(privileged.descriptors).toEqual(catalog.descriptors);
    expect(privileged.descriptors.length).toBe(catalog.descriptors.length);
  });

  it('returns a deeply frozen catalog', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const general = projectCatalog(catalog, 'general');
    expect(Object.isFrozen(general)).toBe(true);
    expect(Object.isFrozen(general.descriptors)).toBe(true);
    for (const descriptor of general.descriptors) {
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });

  it('never mutates its input catalog', () => {
    const catalog = createModelCatalog({ now: fixedNow });
    const before = JSON.parse(JSON.stringify(catalog)) as unknown;
    projectCatalog(catalog, 'general');
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(before);
  });
});
