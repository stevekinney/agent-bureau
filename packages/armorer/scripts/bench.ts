import { z } from 'zod';

import { defineTool } from '../src/core';
import { createToolbox } from '../src/create-toolbox';
import type { ToolConfiguration } from '../src/is-tool';
import {
  queryTools,
  reindexSearchIndex,
  searchTools,
  type ToolQueryInput,
} from '../src/registry';

const TOOL_COUNT = Number(process.env['BENCH_TOOLS'] ?? 2000);
const RUNS = Number(process.env['BENCH_RUNS'] ?? 50);
const WARMUP = Number(process.env['BENCH_WARMUP'] ?? 10);
const EMBED_DIM = Number(process.env['BENCH_EMBED_DIM'] ?? 64);

const now = (() => {
  if (typeof Bun !== 'undefined' && typeof Bun.nanoseconds === 'function') {
    return () => Number(Bun.nanoseconds()) / 1e6;
  }
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return () => performance.now();
  }
  return () => Date.now();
})();

const verbs = [
  'audit',
  'convert',
  'summarize',
  'extract',
  'format',
  'analyze',
  'normalize',
  'filter',
];
const domains = [
  'payments',
  'logs',
  'profiles',
  'sessions',
  'inventory',
  'analytics',
  'messages',
  'reports',
];
const tags = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'fast',
  'slow',
  'math',
  'text',
  'network',
  'storage',
];
const tiers = ['free', 'pro', 'enterprise'];
const owners = ['team-a', 'team-b', 'team-c', 'team-d'];

const schemas = [
  z.object({ input: z.string(), count: z.number().optional() }),
  z.object({ userId: z.string(), detail: z.boolean().optional() }),
  z.object({ logId: z.string(), since: z.string().optional() }),
  z.object({ query: z.string(), limit: z.number().optional() }),
];

const tools = Array.from({ length: TOOL_COUNT }, (_, index) =>
  makeToolConfiguration(index),
);

const embed = (texts: string[]) => texts.map((text) => vectorFromText(text, EMBED_DIM));

const toolbox = createToolbox(tools, { embed });
const registryInput = toolbox as unknown as ToolQueryInput;
reindexSearchIndex(registryInput);

console.log(
  `Benchmarks (tools=${TOOL_COUNT}, runs=${RUNS}, warmup=${WARMUP}, embedDim=${EMBED_DIM})`,
);
console.log('---');

runBench('query: tags + schema + contains', () => {
  queryTools(registryInput, {
    tags: { any: ['alpha', 'fast'] },
    schema: { keys: ['input'] },
    text: { query: 'audit', mode: 'contains' },
  });
});

runBench('query: fuzzy text', () => {
  queryTools(registryInput, {
    text: { query: 'anlyze repot', mode: 'fuzzy', threshold: 0.5 },
  });
});

runBench('search: rank text', () => {
  searchTools(registryInput, {
    rank: { text: { query: 'audit logs', mode: 'contains' } },
    limit: 25,
  });
});

runBench('search: rank text + embedding', () => {
  searchTools(registryInput, {
    rank: { text: { query: 'semantic insight', mode: 'fuzzy', threshold: 0.4 } },
    limit: 25,
  });
});

function runBench(name: string, fn: () => void): void {
  for (let i = 0; i < WARMUP; i += 1) {
    fn();
  }
  const start = now();
  for (let i = 0; i < RUNS; i += 1) {
    fn();
  }
  const elapsed = now() - start;
  const perOp = elapsed / RUNS;
  const ops = perOp > 0 ? 1000 / perOp : 0;
  console.log(`${name}: ${perOp.toFixed(2)} ms/op (${ops.toFixed(0)} ops/s)`);
}

function makeToolConfiguration(index: number): ToolConfiguration {
  const verb = verbs[index % verbs.length] ?? 'process';
  const domain = domains[index % domains.length] ?? 'data';
  const tagA = tags[index % tags.length] ?? 'alpha';
  const tagB = tags[(index + 3) % tags.length] ?? 'beta';
  const schema = schemas[index % schemas.length] ?? schemas[0]!;
  const tier = tiers[index % tiers.length] ?? 'free';
  const owner = owners[index % owners.length] ?? 'team-a';
  const definition = defineTool({
    name: `tool-${index}-${verb}-${domain}`,
    description: `${verb} ${domain} with ${tagA} output and ${tier} tier`,
    tags: [tagA, tagB, domain],
    metadata: { tier, owner, group: domain },
    input: schema,
  });
  return {
    ...definition,
    parameters: schema,
    execute: () => Promise.resolve(null),
  } as unknown as ToolConfiguration;
}

function vectorFromText(text: string, dimension: number): number[] {
  let seed = hashString(text);
  const values = new Array<number>(dimension);
  for (let i = 0; i < dimension; i += 1) {
    seed = (seed * 1664525 + 1013904223) | 0;
    values[i] = ((seed >>> 0) % 2000) / 1000 - 1;
  }
  return values;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}
