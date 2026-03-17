# Pinecone Integration

## Overview

[Pinecone](https://www.pinecone.io/) is a managed vector database designed for semantic search and retrieval workloads at scale.

This guide shows how to integrate Pinecone with Toolbox for persistent semantic tool search.

## Setup

Install the required dependencies:

```bash
bun add @pinecone-database/pinecone openai
```

## Basic Pinecone Integration

Here's a minimal example using Pinecone as vector storage for Toolbox tool embeddings:

```typescript
import { createToolbox, createTool } from 'armorer';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { z } from 'zod';

// Initialize clients
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const openai = new OpenAI();

// Get an existing index
const index = pinecone.index('toolbox-tools');

// Create an embedder that uses OpenAI
async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });

  return response.data.map((item) => item.embedding);
}

// Create the toolbox with embedding support
const toolbox = createToolbox([], { embed });

// Helper to upsert tool embeddings to Pinecone
async function syncToolToPinecone(toolName: string): Promise<void> {
  const tool = toolbox.getTool(toolName);
  if (!tool) return;

  const fields = [
    { field: 'name', text: tool.name },
    { field: 'description', text: tool.description },
    { field: 'tags', text: tool.tags?.join(' ') ?? '' },
  ].filter((f) => f.text);

  const embeddings = await embed(fields.map((f) => f.text));

  await index.upsert(
    fields.map((field, i) => ({
      id: `${toolName}:${field.field}`,
      values: embeddings[i],
      metadata: {
        toolName,
        field: field.field,
        text: field.text,
      },
    })),
  );
}

// Sync tools to Pinecone on registration
toolbox.addEventListener('registered', async (event) => {
  await syncToolToPinecone(event.detail.name);
});
```

## Semantic Search with Pinecone

Use Pinecone vector queries to find semantically similar tools:

```typescript
async function findToolsBySemanticQuery(
  query: string,
  topK: number = 5,
): Promise<string[]> {
  const [queryEmbedding] = await embed([query]);

  const results = await index.query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
  });

  const toolNames = new Set<string>();
  for (const match of results.matches ?? []) {
    const toolName = match.metadata?.toolName as string;
    if (toolName) {
      toolNames.add(toolName);
    }
  }

  return Array.from(toolNames);
}

// Usage
const toolNames = await findToolsBySemanticQuery('send a message to someone');
const tools = toolNames.map((name) => toolbox.getTool(name)).filter(Boolean);
```

## Hybrid Search: Pinecone + Toolbox Filters

For more precise results, combine Pinecone retrieval with Toolbox filtering:

```typescript
import { queryTools, type Tool } from 'armorer/query';

async function hybridToolSearch(
  query: string,
  filters?: { tags?: string[]; metadata?: Record<string, unknown> },
): Promise<Tool[]> {
  const [queryEmbedding] = await embed([query]);
  const pineconeResults = await index.query({
    vector: queryEmbedding,
    topK: 20,
    includeMetadata: true,
  });

  const candidateNames = new Set<string>();
  for (const match of pineconeResults.matches ?? []) {
    const toolName = match.metadata?.toolName as string;
    if (toolName) {
      candidateNames.add(toolName);
    }
  }

  const candidates = Array.from(candidateNames)
    .map((name) => toolbox.getTool(name))
    .filter((tool): tool is Tool => Boolean(tool));

  if (!filters) {
    return candidates;
  }

  return queryTools(candidates, {
    tags: filters.tags ? { all: filters.tags } : undefined,
    metadata: filters.metadata ? { eq: filters.metadata } : undefined,
  });
}

const tools = await hybridToolSearch('notify user', {
  tags: ['communication'],
  metadata: { readOnly: true },
});
```

## Full Example: Pinecone-backed Tool Registry

```typescript
import { createToolbox, createTool, type Tool } from 'armorer';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { z } from 'zod';

const PINECONE_INDEX = 'toolbox-tools';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const openai = new OpenAI();

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  return response.data.map((item) => item.embedding);
}

async function ensureIndex(): Promise<void> {
  const indexes = await pinecone.listIndexes();
  const exists = indexes.indexes?.some((idx) => idx.name === PINECONE_INDEX);

  if (!exists) {
    await pinecone.createIndex({
      name: PINECONE_INDEX,
      dimension: EMBEDDING_DIMENSIONS,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1',
        },
      },
    });

    // Wait for index initialization
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function createPineconeToolbox() {
  await ensureIndex();

  const index = pinecone.index(PINECONE_INDEX);
  const toolbox = createToolbox([], { embed });

  toolbox.addEventListener('registered', async (event) => {
    const tool = event.detail;
    const fields = [
      { field: 'name', text: tool.name },
      { field: 'description', text: tool.description },
      { field: 'tags', text: tool.tags?.join(' ') ?? '' },
    ].filter((f) => f.text);

    const embeddings = await embed(fields.map((f) => f.text));

    await index.upsert(
      fields.map((field, i) => ({
        id: `${tool.name}:${field.field}`,
        values: embeddings[i],
        metadata: {
          toolName: tool.name,
          field: field.field,
          text: field.text,
          tags: tool.tags ?? [],
        },
      })),
    );
  });

  return {
    toolbox,

    async search(query: string, limit = 10): Promise<Tool[]> {
      const [queryEmbedding] = await embed([query]);
      const results = await index.query({
        vector: queryEmbedding,
        topK: limit * 3,
        includeMetadata: true,
      });

      const seen = new Set<string>();
      const tools: Tool[] = [];

      for (const match of results.matches ?? []) {
        const toolName = match.metadata?.toolName as string;
        if (toolName && !seen.has(toolName)) {
          seen.add(toolName);
          const tool = toolbox.getTool(toolName);
          if (tool) {
            tools.push(tool);
          }
          if (tools.length >= limit) break;
        }
      }

      return tools;
    },

    async deleteTool(toolName: string): Promise<void> {
      await index.deleteMany({
        filter: { toolName: { $eq: toolName } },
      });
    },
  };
}

const { toolbox, search } = await createPineconeToolbox();

createTool(
  {
    name: 'send-email',
    description: 'Send an email message to one or more recipients',
    input: z.object({
      to: z.array(z.string().email()),
      subject: z.string(),
      body: z.string(),
    }),
    tags: ['communication', 'email'],
    async execute({ to, subject, body }) {
      console.log(`Sending email to ${to.join(', ')}`);
      return { sent: true, recipients: to.length };
    },
  },
  toolbox,
);

createTool(
  {
    name: 'schedule-meeting',
    description: 'Create a calendar event and invite attendees',
    input: z.object({
      title: z.string(),
      startTime: z.string().datetime(),
      duration: z.number().describe('Duration in minutes'),
      attendees: z.array(z.string().email()),
    }),
    tags: ['calendar', 'scheduling'],
    async execute({ title, startTime, duration, attendees }) {
      console.log(`Scheduling: ${title}`);
      return { scheduled: true, eventId: 'evt_123' };
    },
  },
  toolbox,
);

const tools = await search('I need to contact my team');
console.log(
  'Found tools:',
  tools.map((t) => t.name),
);
```

## Pinecone vs LanceDB vs Chroma

| Feature             | Pinecone          | LanceDB        | Chroma          |
| ------------------- | ----------------- | -------------- | --------------- |
| Deployment          | Cloud only        | Embedded/Cloud | Embedded/Server |
| Open Source         | No                | Yes            | Yes             |
| Built-in embeddings | No                | No             | Yes             |
| Local development   | Requires internet | Native         | Native          |
| Managed scaling     | Yes               | No             | No              |

Choose Pinecone when:

- You want fully managed vector infrastructure
- You need hosted scaling for large retrieval workloads
- You prefer cloud-native operations over local data management

## Related Documentation

- [Embeddings & Semantic Search](../embeddings.md) - Core embedding concepts for Toolbox
- [LanceDB Integration](lancedb.md) - Serverless vector database guide
- [Chroma Integration](chroma.md) - Open-source embedding database guide
- [Toolbox Registry](../registry.md) - Querying and searching tools
- [API Reference](../api-reference.md) - Complete type definitions
