# Memory

`memory` provides persistent recall for Agent Bureau agents. It defines the memory API, storage contracts, embedding-backed retrieval, hybrid search, ingestion helpers, runtime hooks, identity primitives, and tool surfaces for storing, recalling, and forgetting memory.

## Table of Contents

- [What It Does](#what-it-does)
- [How It Works](#how-it-works)
- [Project Role](#project-role)
- [Quick Start](#quick-start)
- [Core API](#core-api)
- [Storage Backends](#storage-backends)
- [Hooks](#hooks)
- [Tools](#tools)
- [Ingestion](#ingestion)
- [Retrieval Helpers](#retrieval-helpers)
- [Identity](#identity)
- [Testing](#testing)
- [Development](#development)

## What It Does

- Creates a `Memory` instance with `remember()`, `rememberOnce()`, `recall()`, `list()`, `forget()`, `forgetAll()`, and `count()`.
- Defines the `MemoryRecordStorage` contract used by Weft, Cloudflare, and test backends.
- Combines vector search, BM25 text search, temporal decay, and maximal marginal relevance.
- Supports deduplication, conflict detection, namespace isolation, and external text-search providers.
- Adds ingestion, chunking, file synchronization, reflection, run capture, and consolidation helpers.
- Provides memory tools and identity tools for use through `armorer` and `operative`.

## How It Works

`createMemory()` accepts an embedder and a storage backend. On writes, it embeds content, checks for duplicates or conflicts, persists a canonical memory record, and optionally indexes text. On recall, it gathers vector and text candidates, merges scores, applies temporal decay and diversity, and returns ranked `MemorySearchResult` entries.

The storage contract is intentionally lower-level than the public memory API. Backends own durable record reads and vector lookup, while `memory` owns retrieval semantics. `createWeftMemoryRecordStorage()` is the default durable workspace backend, and `cloudflare` provides a Workers backend with the same storage contract.

## Project Role

`operative` uses memory through hooks and bridges during agent runs. `gateway` wires configured memory into the composed runtime. `skills` can use memory to persist skill usage and self-improvement context. The package is the long-term knowledge layer shared by those higher-level surfaces.

## Quick Start

`createMemory()` needs two things: an **embedder** (an `Embedder` — `(texts: string[]) => number[][] | Promise<number[][]>`, mapping a batch of strings to one float vector each) and a **storage backend**. This Quick Start uses the deterministic test embedder and the in-memory backend from `memory/test` so it runs with no provider or runtime wiring:

```typescript
import { createMemory } from 'memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from 'memory/test';

// Deterministic, unit-normalized, hash-based vectors — no network calls.
const embedder = createMockEmbedder(128);
const storage = createInMemoryMemoryRecordStorage();

const memory = createMemory({ embedder, storage });
await memory.init();

// Store a fact.
await memory.remember('The user prefers concise bullet-point summaries.');

// Retrieve the most relevant memories for a query.
const results = await memory.recall('How should I format responses?');
// results[0] => { id: '...', score: 0.91, content: 'The user prefers concise bullet-point summaries.', ... }

await memory.close();
```

For production, supply a real embedder (your model provider's embedding endpoint) and the durable Weft-backed storage instead of the test doubles:

```typescript
import { createMemory, createWeftMemoryRecordStorage } from 'memory';

// Wire this to your provider — e.g. OpenAI's text-embedding-3-small (1536 dims).
// An `Embedder` may return vectors synchronously or as a promise; a provider
// call is async, so this one is too.
const embedder = async (texts: string[]): Promise<number[][]> => embedProvider(texts);

// `weftStorage` is a Weft Storage instance from the operative/gateway runtime.
const storage = createWeftMemoryRecordStorage(weftStorage);

const memory = createMemory({ embedder, storage });
await memory.init();
```

---

## Core API

```typescript
import {
  createMemory,
  withNamespaceIsolation,
  withEmbeddingCache,
  withHyDE,
  createHyDEGenerator,
  getMemoryStatus,
  createConsolidationTask,
} from 'memory';
```

### `createMemory(options)`

```typescript
function createMemory(options: CreateMemoryOptions): Memory;

interface CreateMemoryOptions {
  embedder: Embedder;
  storage: MemoryRecordStorage;
  namespace?: string; // default: 'default'
  dimension?: number;
  defaultSearchOptions?: Partial<MemorySearchOptions>;
  deduplicationThreshold?: number; // default: 0.95 — above this, update in place
  conflictThreshold?: number; // must be < deduplicationThreshold; calls onConflict between the two
  onConflict?: OnConflictHandler; // default: always 'keep-both'
  textSearchProvider?: TextSearchProvider;
  requireNamespace?: boolean; // default: false
}

type OnConflictHandler = (
  incoming: { content: string; metadata: Partial<MemoryMetadata> },
  existing: { id: string; content: string; metadata: MemoryMetadata; similarity: number },
) => Promise<'keep-both' | 'replace' | 'skip'> | 'keep-both' | 'replace' | 'skip';
```

Returns a `Memory` instance:

```typescript
interface Memory {
  remember(content: string, metadata?: Partial<MemoryMetadata>): Promise<MemoryEntry>;
  rememberOnce(
    content: string,
    metadata: Partial<MemoryMetadata> & { dedupeKey: string },
  ): Promise<MemoryEntry>;
  recall(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  list(options?: MemoryListOptions): Promise<MemorySearchResult[]>;
  forget(id: string, namespace?: string): Promise<void>;
  forgetAll(namespace?: string): Promise<void>;
  count(namespace?: string): Promise<number>;
  init(): Promise<void>;
  close(): Promise<void>;
}
```

**`remember(content, metadata?)`:** Embeds `content`, checks for near-duplicates (cosine similarity ≥ `deduplicationThreshold` → update in place; ≥ `conflictThreshold` → calls `onConflict`), then writes a `MemoryRecord`. Returns the persisted `MemoryEntry`.

**`rememberOnce(content, metadata)`:** Idempotent write keyed on `metadata.dedupeKey`. Requires the storage backend to implement `putOnce`.

**`recall(query, options?)`:** Embeds the query, runs vector search and optional BM25, merges scores, applies temporal decay and MMR if configured, and returns ranked `MemorySearchResult[]`.

**`list(options?)`:** Returns stored entries newest-first without embedding the caller's query. Useful for browsing, not ranked retrieval.

**`forget(id, namespace?)`:** Removes one entry by id. The observable guarantee is that the record disappears from reads; how that removal is realized is backend-specific (physical row deletion in the local backend, a tombstone elsewhere).

**`forgetAll(namespace?)`:** Deletes all entries in the given namespace (defaults to the instance namespace). Also clears the embedding cache if one is attached.

**`count(namespace?)`:** Returns the number of active entries.

```typescript
interface MemorySearchOptions {
  limit?: number;
  threshold?: number;
  namespace?: string;
  includeVector?: boolean;
  vectorWeight?: number; // default: 0.7
  textWeight?: number; // default: 0.3
  temporalDecay?: { halfLifeMilliseconds: number; evergreenExempt?: boolean };
  diversify?: { lambda: number }; // 1 = pure relevance, 0 = pure diversity
  vectorOnly?: boolean; // skip BM25 entirely
}

interface MemoryListOptions {
  limit?: number; // default: 100
  offset?: number; // default: 0
  namespace?: string;
}

interface MemoryMetadata {
  namespace: string;
  source: 'auto-capture' | 'tool' | 'manual' | 'experiential';
  conversationId?: string;
  agentId?: string;
  importance?: number;
  evergreen?: boolean;
  tags?: string[];
  dedupeKey?: string;
  [key: string]: unknown;
}

interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  metadata: MemoryMetadata;
  createdAt: number;
}
```

### Conflict vs. deduplication

`conflictThreshold` < `deduplicationThreshold`. When an incoming entry's cosine similarity to an existing entry is above `deduplicationThreshold` (default: 0.95), the existing record is updated in place. When it falls between `conflictThreshold` and `deduplicationThreshold`, `onConflict` is called. Below `conflictThreshold`, both entries coexist.

### `withNamespaceIsolation(memory, options)`

Wraps a `Memory` instance so every read and write is scoped to a specific namespace, with optional enforcement on unauthorized cross-namespace access.

```typescript
function withNamespaceIsolation(memory: Memory, options: NamespaceIsolationOptions): Memory;

interface NamespaceIsolationOptions {
  namespace: string;
  onUnauthorized?: 'throw' | 'ignore'; // default: 'throw'
}
```

```typescript
// All operations on `agentMemory` are confined to the 'agent-42' namespace.
const agentMemory = withNamespaceIsolation(memory, { namespace: 'agent-42' });
await agentMemory.remember('User prefers dark mode.');
```

### `withEmbeddingCache(embedder, options?)`

Wraps an `Embedder` with an LRU cache, keyed by text content. Avoids re-embedding strings that have already been seen this session.

```typescript
function withEmbeddingCache(embedder: Embedder, options?: EmbeddingCacheOptions): CachedEmbedder;

interface EmbeddingCacheOptions {
  maximumEntries?: number; // default: 10_000
  hash?: (text: string) => string | Promise<string>;
  namespace?: string;
}

type CachedEmbedder = Embedder & {
  cache: ReadonlyMap<string, EmbeddingVector>;
  clearCache(): void;
  clearNamespace(namespace: string): void;
};
```

```typescript
const cachedEmbedder = withEmbeddingCache(myEmbedder, { maximumEntries: 5_000 });
const memory = createMemory({ embedder: cachedEmbedder, storage });
```

### `withHyDE(memory, options)` and `createHyDEGenerator(options)`

Hypothetical Document Embeddings: instead of embedding the raw query, the system generates a plausible hypothetical answer and embeds that. Produces better recall for factual queries.

```typescript
function withHyDE(memory: Memory, options: HyDEOptions): Memory;

interface HyDEOptions {
  generateHypothetical: HypotheticalAnswerGenerator;
  augmentTextSearch?: boolean; // default: true — also passes hypothetical to BM25
}

type HypotheticalAnswerGenerator = (query: string) => Promise<string>;

function createHyDEGenerator(options: CreateHyDEGeneratorOptions): HypotheticalAnswerGenerator;

interface CreateHyDEGeneratorOptions {
  generateText: (prompt: string) => Promise<string>;
  systemPrompt?: string;
}
```

```typescript
const generator = createHyDEGenerator({
  generateText: async (prompt) => await llm.complete(prompt),
});

const hydeMemory = withHyDE(memory, { generateHypothetical: generator });
// hydeMemory.recall() now embeds a hypothetical answer, not the raw query.
const results = await hydeMemory.recall('What does the user prefer for error messages?');
```

### `getMemoryStatus(storage, options)`

Diagnostic snapshot of storage state across named namespaces.

```typescript
function getMemoryStatus(
  storage: MemoryRecordStorage,
  options: GetMemoryStatusOptions,
): Promise<MemoryStatus>;

interface GetMemoryStatusOptions {
  namespaces: string[];
  tenantId?: string;
  embedder?: unknown;
  storageType?: string;
}

interface MemoryStatus {
  totalEntries: number;
  namespaces: Array<{ name: string; count: number }>;
  storageType: string;
  embeddingCacheSize?: number;
}
```

### `createConsolidationTask(options)`

Returns a chunked-task descriptor compatible with `operative`'s `createChunkedTask`. When run, consolidation scans stored memories in batches, merges near-duplicates (above `mergeThreshold`), resolves conflicts within `conflictRange`, and prunes entries whose evaluated importance falls below `pruneThreshold`. It operates only on stored memory records — it does not touch the identity/soul system.

```typescript
function createConsolidationTask(
  options: CreateConsolidationOptions,
): ConsolidationChunkedTaskOptions;

interface CreateConsolidationOptions {
  memory: Memory;
  namespace?: string;
  chunkSize?: number; // default: 20
  mergeThreshold?: number; // default: 0.75
  merge: (entryA: string, entryB: string) => Promise<string>;
  deduplicationThreshold?: number; // default: 0.95
  resolveConflict?: (entryA: string, entryB: string) => Promise<string | null>;
  conflictRange?: [number, number]; // default: [0.6, 0.9]
  evaluateImportance?: (entry: string, metadata: MemoryMetadata) => Promise<number>;
  pruneThreshold?: number; // default: 0.2
  boostConfidenceOnMerge?: boolean; // default: true
}
```

---

## Storage Backends

```typescript
import { createWeftMemoryRecordStorage, DEFAULT_MEMORY_KEY_PREFIX } from 'memory';
```

### `MemoryRecordStorage` (contract)

All backends implement this interface. Backends own durable record reads and vector lookup; `createMemory` owns retrieval semantics on top.

```typescript
interface MemoryRecordStorage {
  init(): Promise<void>;
  close(): Promise<void>;
  put(record: MemoryRecord): Promise<void>;
  get(id: string, scope: MemoryRecordScope): Promise<MemoryRecord | undefined>;
  getMany(ids: string[], scope: MemoryRecordScope): Promise<MemoryRecord[]>;
  getByDedupeKey?(scope: MemoryRecordScope, dedupeKey: string): Promise<MemoryRecord | undefined>;
  putOnce?(record: MemoryRecord): Promise<MemoryRecordPutOnceResult>;
  list(
    scope: MemoryRecordScope,
    options?: { limit?: number; offset?: number },
  ): Promise<MemoryRecord[]>;
  count(scope: MemoryRecordScope): Promise<number>;
  searchByVector(
    vector: EmbeddingVectorLike,
    scope: MemoryRecordScope,
    options: { limit: number; threshold?: number },
  ): Promise<MemoryVectorSearchResult[]>;
  update(
    id: string,
    scope: MemoryRecordScope,
    patch: { content?: string; vector?: Float32Array; metadata?: Record<string, unknown> },
  ): Promise<MemoryRecord | undefined>;
  delete(id: string, scope: MemoryRecordScope): Promise<boolean>;
  deleteNamespace(scope: MemoryRecordScope): Promise<number>;
}

interface MemoryRecord {
  id: string;
  tenantId?: string;
  namespace: string;
  content: string;
  vector: Float32Array;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  version: number;
  status: 'active' | 'deleted';
}

interface MemoryRecordScope {
  tenantId?: string;
  namespace: string;
}

interface MemoryVectorSearchResult {
  id: string;
  score: number;
  record: MemoryRecord;
}

type MemoryRecordPutOnceResult =
  | { record: MemoryRecord; inserted: true }
  | { record: MemoryRecord; inserted: false };
```

### `createWeftMemoryRecordStorage(storage, options?)`

The default durable backend. Wraps a Weft `Storage` instance with the `MemoryRecordStorage` contract.

```typescript
const DEFAULT_MEMORY_KEY_PREFIX = 'app:agent-bureau:memory:v1:';

function createWeftMemoryRecordStorage(
  storage: Storage,
  options?: CreateWeftMemoryRecordStorageOptions,
): MemoryRecordStorage;

interface CreateWeftMemoryRecordStorageOptions {
  keyPrefix?: string;
  disposeUnderlyingStorage?: boolean; // default: false
}
```

```typescript
import { createWeftMemoryRecordStorage } from 'memory';

// `weftStorage` comes from the operative/gateway runtime (ctx.services or similar)
const storage = createWeftMemoryRecordStorage(weftStorage, {
  keyPrefix: 'my-app:memory:v1:',
});

const memory = createMemory({ embedder, storage });
```

### `TextSearchProvider` (contract)

An optional external text-search provider for hybrid BM25+vector recall. Pass one to `createMemory` as `textSearchProvider`.

```typescript
interface TextSearchProvider {
  init(): Promise<void>;
  close(): Promise<void>;
  index(id: string, content: string, namespace: string): Promise<void>;
  remove(id: string): Promise<void>;
  clear(namespace?: string): Promise<void>;
  search(query: string, namespace: string): Promise<Map<string, number>>; // id → score
}
```

---

## Hooks

```typescript
import {
  createMemoryHooks,
  createRunCaptureHook,
  createReflectionHook,
  summarizeRun,
} from 'memory';
```

### `createMemoryHooks(options)`

Returns `operative`-compatible hook functions that inject recalled memories into each agent step and capture tool outputs back to memory.

```typescript
function createMemoryHooks(options: MemoryHookOptions): {
  prepareStep: (context: StepContextLike) => Promise<void>;
  afterToolExecution: (context: ToolExecutionResultContextLike) => Promise<void>;
};

interface MemoryHookOptions {
  memory: Memory;
  namespace?: string;
  autoRecall?: boolean; // default: true — inject recalled context before each step
  autoCapture?: boolean; // default: true — capture tool results after execution
  recallLimit?: number; // default: 5
}
```

```typescript
import { createMemoryHooks } from 'memory';
import { createRun } from '@lostgradient/operative';

const hooks = createMemoryHooks({ memory, recallLimit: 10 });

// Wire into an operative run via the top-level hook options. (RunOptions.hooks is
// a HookRegistry, not an object map — individual hooks go at the top level.)
const run = createRun({
  generate,
  toolbox,
  conversation,
  prepareStep: hooks.prepareStep,
  afterToolExecution: hooks.afterToolExecution,
});
```

### `createRunCaptureHook(options)`

Captures a summary of each completed step as an experiential memory. Useful for building an agent's episodic memory over time.

```typescript
function createRunCaptureHook(options: RunCaptureHookOptions): {
  onStep: (context: StepResultLike) => Promise<void>;
};

interface RunCaptureHookOptions {
  memory: Memory;
  namespace?: string; // default: 'experiential'
  summarize?: (result: StepResultLike) => string;
}

// Default summarizer — exposed for customization.
function summarizeRun(result: StepResultLike): string;
```

```typescript
import { createRunCaptureHook } from 'memory';
import { createRun } from '@lostgradient/operative';

const captureHook = createRunCaptureHook({
  memory,
  namespace: 'experiential',
  summarize: (result) => `Step ${result.step}${result.final ? ' (final)' : ''}: ${result.content}`,
});

// Wire into an operative run via the top-level `onStep` option:
const run = createRun({
  generate,
  toolbox,
  conversation,
  onStep: captureHook.onStep,
});
```

### `createReflectionHook(options)`

Calls a `reflect` function after each step and stores the resulting insight as an experiential memory. The optional `shouldReflect` guard lets you filter which steps trigger reflection.

```typescript
function createReflectionHook(options: CreateReflectionHookOptions): {
  onStep: (context: StepResultLike) => Promise<void>;
};

interface CreateReflectionHookOptions {
  memory: Memory;
  reflect: (runSummary: string) => Promise<string>;
  namespace?: string; // default: 'experiential'
  shouldReflect?: (result: StepResultLike) => boolean;
}
```

```typescript
import { createReflectionHook, summarizeRun } from 'memory';

const reflectionHook = createReflectionHook({
  memory,
  reflect: async (summary) => await llm.complete(`Reflect on: ${summary}`),
  shouldReflect: (result) => result.final,
});
```

---

## Tools

```typescript
import { createMemoryStoreTool, createMemoryRecallTool, createMemoryForgetTool } from 'memory';
```

Memory tools are `armorer` `Tool` instances. Pass them to a `Toolbox` alongside your other tools so the model can self-direct its memory operations.

### `createMemoryStoreTool(memory)`

Tool name: `memory_store`. Stores a string to memory with optional tags, importance score, and evergreen flag.

```typescript
function createMemoryStoreTool(memory: Memory): Tool;
// input: { content: string; tags?: string[]; importance?: number; evergreen?: boolean }
```

### `createMemoryRecallTool(memory)`

Tool name: `memory_recall`. Retrieves relevant memories for a query string.

```typescript
function createMemoryRecallTool(memory: Memory): Tool;
// input: { query: string; limit?: number; namespace?: string }
```

### `createMemoryForgetTool(memory)`

Tool name: `memory_forget`. Deletes a memory entry by id.

```typescript
function createMemoryForgetTool(memory: Memory): Tool;
// input: { id: string }
```

```typescript
import { createToolbox } from 'armorer';
import { createMemoryStoreTool, createMemoryRecallTool, createMemoryForgetTool } from 'memory';

const memoryToolbox = createToolbox([
  createMemoryStoreTool(memory),
  createMemoryRecallTool(memory),
  createMemoryForgetTool(memory),
]);
```

---

## Ingestion

```typescript
import {
  chunkMarkdown,
  chunkText,
  chunkHtml,
  ingest,
  createFileSynchronizer,
  SOURCE_DOCUMENT_KEY,
  CHUNK_INDEX_KEY,
} from 'memory';
```

Every loader below implements the same contract — `(document: string, options?: ChunkingOptions) => ContentChunk[] | Promise<ContentChunk[]>` — and produces `ContentChunk[]`. `ingest()` accepts any function matching that shape via its `chunk` option, so adding a format doesn't require changes to this package: write (or wrap) a loader, pass it to `ingest()`.

### `chunkMarkdown(content, options?)`

Splits a Markdown string into overlapping chunks suitable for embedding. Chunks track their source line range so individual chunks can be located back in the original document. This is `ingest()`'s default loader.

```typescript
function chunkMarkdown(content: string, options?: ChunkingOptions): ContentChunk[];

interface ChunkingOptions {
  maximumTokens?: number; // default: 400
  overlapTokens?: number; // default: 80
}

interface ContentChunk {
  text: string;
  startLine: number;
  endLine: number;
  index: number;
  heading?: string; // nearest preceding structure-hint label, when known
}
```

### `chunkText(document, options?)`

The ingestion contract for pre-extracted text: hand it plain text plus optional structural boundaries (headings, page breaks, ...) and it chunks by token count same as `chunkMarkdown`, except a chunk never spans across a boundary. This is the seam every non-Markdown loader (including `chunkHtml`) is built on, and the one to use for formats this package doesn't parse itself (PDF, DOCX, plain extracted text, ...).

```typescript
function chunkText(document: ExtractedDocument, options?: ChunkingOptions): ContentChunk[];

interface StructureHint {
  startLine: number; // 0-based line within `document.text`
  label?: string; // e.g. a heading's text or "page 3"
}

interface ExtractedDocument {
  text: string;
  structure?: StructureHint[];
}
```

With no `structure` hints, `chunkText({ text })` behaves exactly like `chunkMarkdown(text)`.

### `chunkHtml(html, options?)`

First-party HTML loader. Strips tags with Bun's built-in `HTMLRewriter` (a lightweight streaming parser — no DOM dependency), drops `<script>`/`<style>`/`<template>` content, inserts line breaks between block-level elements, and carries heading text forward as each chunk's `heading`. Built on `chunkText`, so headings become structure hints and a chunk never spans a heading boundary.

```typescript
function chunkHtml(html: string, options?: ChunkingOptions): Promise<ContentChunk[]>;
```

```typescript
import { chunkHtml, ingest } from 'memory';

const html = await Bun.file('docs/page.html').text();

await ingest(memory, html, {
  sourceIdentifier: 'docs/page.html',
  chunk: chunkHtml,
});
```

### PDF (recipe, not a bundled dependency)

This package intentionally does not bundle a PDF parser — extracting PDF text pulls in a heavyweight, native-dependent library, and only some consumers need it. Extract the text yourself (e.g. with [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) or [`unpdf`](https://www.npmjs.com/package/unpdf), whichever fits your runtime), and feed the result to `chunkText` with page breaks as structure hints:

```typescript
import { chunkText, ingest } from 'memory';
// npm install pdf-parse (or your extractor of choice) as a project dependency
import pdf from 'pdf-parse';

const buffer = await Bun.file('report.pdf').arrayBuffer();
const { text: fullText, numpages } = await pdf(Buffer.from(buffer));

// pdf-parse joins pages with form-feed (\f); rebuild page-break structure hints.
const pages = fullText.split('\f');
const lines: string[] = [];
const structure: { startLine: number; label: string }[] = [];
for (let i = 0; i < pages.length; i++) {
  structure.push({ startLine: lines.length, label: `page ${i + 1}` });
  lines.push(...pages[i]!.split('\n'));
}
const text = lines.join('\n');

await ingest(memory, text, {
  sourceIdentifier: 'report.pdf',
  chunk: (document, options) => chunkText({ text: document, structure }, options),
});
```

### `ingest(memory, content, options?)`

Chunks a document — via `options.chunk`, default `chunkMarkdown` — and calls `memory.rememberOnce()` for each chunk, tagged with `SOURCE_DOCUMENT_KEY` and `CHUNK_INDEX_KEY` metadata. Each chunk's `dedupeKey` is derived from the source identifier, chunk index, and chunk text, so **re-ingesting the same document through any loader (with the same `sourceIdentifier`) stores no new entries** — it's a no-op. Re-ingesting with different content under the same `sourceIdentifier` stores fresh entries alongside the old ones (see `createFileSynchronizer` below for a pattern that also removes stale chunks). During recall, only the highest-scoring chunk per source document is returned.

```typescript
const SOURCE_DOCUMENT_KEY = '__sourceDocument';
const CHUNK_INDEX_KEY = '__chunkIndex';

function ingest(memory: Memory, content: string, options?: IngestOptions): Promise<IngestResult>;

interface IngestOptions extends ChunkingOptions {
  sourceIdentifier?: string;
  metadata?: Partial<MemoryMetadata>;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Loader that turns `content` into chunks. Defaults to `chunkMarkdown`. */
  chunk?: (document: string, options?: ChunkingOptions) => ContentChunk[] | Promise<ContentChunk[]>;
}

interface IngestResult {
  sourceIdentifier: string;
  entries: MemoryEntry[];
  chunkCount: number;
}
```

```typescript
import { ingest } from 'memory';

const markdown = await Bun.file('docs/getting-started.md').text();

const result = await ingest(memory, markdown, {
  sourceIdentifier: 'docs/getting-started.md',
  metadata: { source: 'manual', tags: ['docs', 'onboarding'] },
  onProgress: ({ completed, total }) => {
    // e.g. "3/12 chunks"
    process.stdout.write(`\r${completed}/${total} chunks`);
  },
});
// result => { sourceIdentifier: 'docs/getting-started.md', entries: [...], chunkCount: 12 }
```

### `createFileSynchronizer(options)`

Watches a directory for Markdown files and keeps memory in sync: new and modified files are ingested, deleted files are removed. Can run on a polling interval or be triggered manually.

```typescript
function createFileSynchronizer(options: FileSynchronizerOptions): FileSynchronizer;

interface FileSynchronizerOptions {
  memory: Memory;
  directory: string;
  extensions?: string[]; // default: ['.md']
  chunking?: ChunkingOptions;
  metadata?: Partial<MemoryMetadata>;
  pollingInterval?: number; // default: 5000 ms
  setIntervalFunction?: ScheduleInterval;
  clearIntervalFunction?: ClearScheduledInterval;
}

interface FileSynchronizer {
  start(): Promise<void>;
  stop(): void;
  synchronize(): Promise<SynchronizeResult>;
}

interface SynchronizeResult {
  added: number;
  updated: number;
  removed: number;
}
```

```typescript
import { createFileSynchronizer } from 'memory';

const synchronizer = createFileSynchronizer({
  memory,
  directory: './docs',
  extensions: ['.md', '.mdx'],
  pollingInterval: 10_000,
});

await synchronizer.start(); // Begin polling

// Or trigger a one-shot sync:
const result = await synchronizer.synchronize();
// result => { added: 3, updated: 1, removed: 0 }

synchronizer.stop();
```

---

## Retrieval Helpers

```typescript
import {
  mergeHybridResults,
  computeBM25Scores,
  tokenize,
  applyTemporalDecay,
  computeTemporalDecay,
  applyMaximalMarginalRelevance,
  extractKeywords,
  isStopWord,
} from 'memory';
```

These helpers power `recall()` internally but are exported for custom retrieval pipelines.

### `computeBM25Scores(query, documents, options?)`

Returns a `Map<number, number>` from document index to raw BM25 score. Scores are _not_ normalized—`recall()` normalizes via `score / (1 + score)` before merging with cosine similarity.

```typescript
function computeBM25Scores(
  query: string,
  documents: string[],
  options?: BM25Options,
): Map<number, number>;

interface BM25Options {
  k1?: number; // default: 1.2
  b?: number; // default: 0.75
  queryTerms?: string[];
}

function tokenize(text: string): string[];
```

### `mergeHybridResults(vectorResults, textScores, candidates, options?)`

Merges pre-computed vector scores with BM25 text scores into a ranked list.

```typescript
function mergeHybridResults(
  vectorResults: VectorSearchResult[],
  textScores: Map<number, number>,
  candidates: HybridSearchCandidate[],
  options?: HybridSearchOptions,
): HybridSearchResult[];

interface HybridSearchOptions {
  vectorWeight?: number; // default: 0.7
  textWeight?: number; // default: 0.3
  limit?: number; // default: 10
  threshold?: number; // default: 0
  candidateMultiplier?: number; // default: 3
}
```

### `applyTemporalDecay(results, options)`

Multiplies each result's score by an exponential decay factor based on `createdAt`. Entries with `metadata.evergreen = true` are exempt when `evergreenExempt` is `true` (default).

```typescript
function applyTemporalDecay<
  T extends { score: number; createdAt: number; metadata: { evergreen?: boolean } },
>(results: T[], options: TemporalDecayOptions): T[];

function computeTemporalDecay(
  score: number,
  createdAt: number,
  options: TemporalDecayOptions,
): number;

interface TemporalDecayOptions {
  halfLifeMilliseconds: number;
  referenceTime?: number; // default: Date.now()
  evergreenExempt?: boolean; // default: true
}
```

### `applyMaximalMarginalRelevance(results, limit, options)`

Reranks results to balance relevance against diversity. `lambda` of `1` returns pure relevance order; `lambda` of `0` maximizes diversity.

```typescript
function applyMaximalMarginalRelevance<T extends { score: number; vector?: number[] }>(
  results: T[],
  limit: number,
  options: MaximalMarginalRelevanceOptions,
): T[];

interface MaximalMarginalRelevanceOptions {
  lambda: number; // 1 = pure relevance, 0 = pure diversity
}
```

### `extractKeywords(query)` and `isStopWord(token)`

Keyword extraction and stop-word filtering used inside the BM25 pipeline.

```typescript
function extractKeywords(query: string): string[];
function isStopWord(token: string): boolean;
```

---

## Identity

```typescript
import {
  createStorageIdentityProvider,
  createStaticIdentityProvider,
  createSoulSeed,
  resolveIdentity,
  getSoulDiff,
  acceptSoulUpdate,
  rejectSoulUpdate,
  pinSoulItem,
  unpinSoulItem,
  createSoulDistillationTask,
  createIdentityToolbox,
  createSoulDiffTool,
  createSoulAcceptTool,
  createSoulRejectTool,
  createSoulPinTool,
  createSoulViewTool,
  createPersonaListTool,
  createPersonaViewTool,
  createPersonaCreateTool,
  createPersonaUpdateTool,
  createPersonaDeleteTool,
} from 'memory';
```

Identity captures who an agent _is_—its soul (durable values and traits), personas (role/domain descriptors), and user context. Soul distillation promotes high-confidence experiential memories into pinned soul items over time.

### Core types

```typescript
interface SoulItem {
  id: string;
  content: string;
  source: 'seed' | 'graduated' | 'user-edit';
  sourceEntryIds?: string[];
  pinned: boolean;
  topic?: string;
  updatedAt: string; // ISO 8601
  reinforcementCount: number;
}

interface PersonaDescriptor {
  name: string;
  role: string;
  expertise?: string;
  taskContext?: string;
  domain?: string;
}

interface AgentIdentity {
  soul: SoulItem[];
  persona?: PersonaDescriptor;
  personaText?: string;
  userContext?: string;
}
```

### `createStorageIdentityProvider(adapter)`

Persistent identity backed by a `TextValueStore` (e.g., a Weft-backed store). Archives every `saveSoul` call to history before overwriting.

```typescript
function createStorageIdentityProvider(adapter: TextValueStore): IdentityProvider;
```

### `createStaticIdentityProvider(initial?)`

In-memory identity for tests or single-session use.

```typescript
function createStaticIdentityProvider(initial?: Partial<AgentIdentity>): IdentityProvider;
```

### `createSoulSeed(options?)`

Generates an initial set of `SoulItem[]` from declarative traits and values. Pass the result to an `IdentityProvider` on first startup to give the agent a personality.

```typescript
function createSoulSeed(options?: CreateSoulSeedOptions): SoulItem[];

interface CreateSoulSeedOptions {
  name?: string;
  traits?: string[];
  values?: string[];
  style?: string[];
  additional?: string;
}
```

```typescript
import { createSoulSeed, createStaticIdentityProvider } from 'memory';

const soul = createSoulSeed({
  name: 'Aria',
  traits: ['curious', 'concise'],
  values: ['accuracy', 'transparency'],
  style: ['direct', 'friendly'],
});

const provider = createStaticIdentityProvider({ soul });
```

### `resolveIdentity(identity, budget?)`

Serializes an `AgentIdentity` into a system-prompt string, respecting token budget constraints.

```typescript
function resolveIdentity(identity: AgentIdentity, budget?: SoulBudget): string;

interface SoulBudget {
  maxTokens: number;
  estimateTokens: (text: string) => number;
  maxItemsPerTopic: number;
}
```

### Soul lifecycle helpers

```typescript
function getSoulDiff(provider: IdentityProvider, agentId?: string): Promise<SoulDiff>;
function acceptSoulUpdate(
  provider: IdentityProvider,
  agentId?: string,
): Promise<{ version: number } | undefined>;
function rejectSoulUpdate(provider: IdentityProvider, agentId?: string): Promise<void>;
function pinSoulItem(
  provider: IdentityProvider,
  itemId: string,
  agentId?: string,
): Promise<boolean>;
function unpinSoulItem(
  provider: IdentityProvider,
  itemId: string,
  agentId?: string,
): Promise<boolean>;

interface SoulDiff {
  additions: SoulDiffEntry[];
  removals: SoulDiffEntry[];
  modifications: SoulDiffEntry[];
  empty: boolean;
}
```

Soul distillation _never_ auto-applies. It produces a pending update that requires explicit `acceptSoulUpdate()` or `rejectSoulUpdate()`.

### `createSoulDistillationTask(options)`

Returns a chunked-task descriptor compatible with `operative`'s `createChunkedTask`. Scans experiential memories and promotes high-confidence, high-reinforcement entries to pending soul updates.

```typescript
function createSoulDistillationTask(
  options: CreateSoulDistillationOptions,
): SoulDistillationChunkedTaskOptions;

interface CreateSoulDistillationOptions {
  memory: Memory;
  provider: IdentityProvider;
  agentId?: string;
  namespace?: string;
  budget: SoulBudget;
  graduationConfidence?: number; // default: 0.9
  graduationReinforcement?: number; // default: 3
  distill: (
    currentSoul: string,
    candidates: Array<{ content: string; confidence: number; topic?: string }>,
  ) => Promise<string>;
  safetyFilter?: (item: string) => Promise<boolean>;
  chunkSize?: number; // default: 50
}
```

### Identity tools

Individual tool factories and a convenience bundle:

```typescript
// Individual tools — each takes IdentityProvider:
function createSoulDiffTool(provider: IdentityProvider): Tool; // 'soul_diff'
function createSoulAcceptTool(provider: IdentityProvider): Tool; // 'soul_accept'
function createSoulRejectTool(provider: IdentityProvider): Tool; // 'soul_reject'
function createSoulPinTool(provider: IdentityProvider): Tool; // 'soul_pin'
function createSoulViewTool(provider: IdentityProvider): Tool; // 'soul_view'
function createPersonaListTool(provider: IdentityProvider): Tool; // 'persona_list'
function createPersonaViewTool(provider: IdentityProvider): Tool; // 'persona_view'
function createPersonaCreateTool(provider: IdentityProvider): Tool; // 'persona_create'
function createPersonaUpdateTool(provider: IdentityProvider): Tool; // 'persona_update'
function createPersonaDeleteTool(provider: IdentityProvider): Tool; // 'persona_delete'

// Convenience bundle returning all ten tools:
function createIdentityToolbox(provider: IdentityProvider): {
  soulDiff: Tool;
  soulAccept: Tool;
  soulReject: Tool;
  soulPin: Tool;
  soulView: Tool;
  personaList: Tool;
  personaView: Tool;
  personaCreate: Tool;
  personaUpdate: Tool;
  personaDelete: Tool;
};
```

```typescript
import { createToolbox, combineToolboxes } from 'armorer';
import { createIdentityToolbox } from 'memory';

const identityTools = createIdentityToolbox(identityProvider);

const toolbox = createToolbox([
  identityTools.soulView,
  identityTools.soulDiff,
  identityTools.soulAccept,
  identityTools.personaList,
]);
```

---

## Testing

Two dedicated test entry points ship with the package.

### `memory/test`

```typescript
import { createMockEmbedder, createInMemoryMemoryRecordStorage } from 'memory/test';
```

**`createMockEmbedder(dimension?)`:** Returns a deterministic, hash-based `Embedder`. No network calls. `dimension` defaults to 128.

**`createInMemoryMemoryRecordStorage()`:** Full in-memory backend with the identical observable contract as the Weft local backend—including `putOnce`, `searchByVector` with cosine ranking, and `deleteNamespace`.

```typescript
import { createMemory } from 'memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from 'memory/test';

const storage = createInMemoryMemoryRecordStorage();
const embedder = createMockEmbedder(128);

const memory = createMemory({ embedder, storage, namespace: 'test' });
await memory.init();

await memory.remember('The sky is blue.');
const results = await memory.recall('What color is the sky?');
expect(results[0]?.content).toBe('The sky is blue.');
```

### `memory/test/contract-harness`

Use this to verify that a custom `MemoryRecordStorage` backend conforms to the full contract. It covers put/get round-trips, `putOnce` semantics, namespace isolation, pagination, vector search ranking and thresholds, update, delete invariants, and `deleteNamespace`.

```typescript
import { runMemoryRecordStorageContract } from 'memory/test/contract-harness';

interface RunMemoryRecordStorageContractOptions {
  label: string;
  makeBackend: () => MemoryRecordStorage;
  scope?: (base: MemoryRecordScope) => MemoryRecordScope;
}

function runMemoryRecordStorageContract(options: RunMemoryRecordStorageContractOptions): void;
```

```typescript
import { runMemoryRecordStorageContract } from 'memory/test/contract-harness';
import { createMyCustomStorage } from './my-custom-storage';

runMemoryRecordStorageContract({
  label: 'MyCustomStorage',
  makeBackend: () => createMyCustomStorage({ connectionString: ':memory:' }),
});
```

---

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
