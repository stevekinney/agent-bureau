# Embeddings and Semantic Search

## Overview

Toolbox supports semantic search for tools using vector embeddings. When you provide an `embed` function to `createToolbox`, the registry generates embeddings for each tool's name, description, tags, schema keys, and metadata keys. These embeddings enable fuzzy, meaning-based searches that go beyond exact text matching.

## Basic Embedding Integration

The `embed` option accepts a function that takes an array of strings and returns an array of numeric vectors:

```typescript
import { createToolbox } from 'armorer';

const toolbox = createToolbox([], {
  embed: async (texts: string[]): Promise<number[][]> => {
    // Return embeddings for each text
    return texts.map((text) => generateEmbedding(text));
  },
});
```

## Using OpenAI Embeddings

The most common approach is to use OpenAI's embedding API:

```typescript
import { createToolbox, createTool } from 'armorer';
import { queryTools } from 'armorer/query';
import OpenAI from 'openai';
import { z } from 'zod';

const openai = new OpenAI();

const toolbox = createToolbox([], {
  embed: async (texts: string[]): Promise<number[][]> => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map((item) => item.embedding);
  },
});

// Register tools - embeddings are generated automatically
createTool(
  {
    name: 'send-email',
    description: 'Send an email to a recipient',
    input: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
    tags: ['communication', 'email', 'messaging'],
    async execute({ to, subject, body }) {
      return { sent: true, to };
    },
  },
  toolbox,
);

createTool(
  {
    name: 'create-calendar-event',
    description: 'Schedule a meeting or event on the calendar',
    input: z.object({
      title: z.string(),
      startTime: z.string(),
      attendees: z.array(z.string().email()),
    }),
    tags: ['calendar', 'scheduling', 'meetings'],
    async execute({ title, startTime, attendees }) {
      return { created: true, title };
    },
  },
  toolbox,
);

// Semantic query - can still find "send-email" even though "notify" is not in the name
const results = queryTools(toolbox, {
  text: { query: 'notify someone about something', mode: 'fuzzy' },
  tags: { any: ['communication'] },
});

console.log(results[0]?.name); // 'send-email'
```

## Pinecone Integration

For a full Pinecone setup, see the dedicated [Pinecone Integration](integrations/pinecone.md) guide. It covers:

- Syncing tool embeddings to Pinecone on registration
- Semantic and hybrid search workflows
- Production-ready index initialization and cleanup patterns

Quick start dependencies:

```bash
bun add @pinecone-database/pinecone openai
```

## Embedding Best Practices

1. **Choose the right model**: `text-embedding-3-small` is a good balance of quality and cost. Use `text-embedding-3-large` for higher accuracy.

2. **Batch embedding requests**: When registering many tools, batch your embedding calls to reduce API latency.

3. **Cache embeddings**: Store pre-computed embeddings in tool metadata for faster startup.

4. **Use hybrid search**: Combine semantic search with Toolbox's tag and metadata filters for precise results.

5. **Index management**: If tool metadata changes at runtime, rebuild cached indexes with `reindexSearchIndex()`.

## Alternative Vector Databases

### LanceDB

For a serverless vector database that can run embedded (no separate server required), see the [LanceDB Integration](integrations/lancedb.md) guide. LanceDB is ideal for:

- Local development without cloud dependencies
- Desktop or edge applications
- Privacy-focused deployments with local embedding models

### Chroma

For an open-source embedding database with built-in embedding functions, see the [Chroma Integration](integrations/chroma.md) guide. Chroma is ideal for:

- Projects that want open-source flexibility
- Built-in support for OpenAI, Cohere, and HuggingFace embeddings
- Flexible deployment (embedded or client-server)
- Document content filtering alongside metadata filtering

## Comparison

| Feature             | Pinecone          | LanceDB        | Chroma          |
| ------------------- | ----------------- | -------------- | --------------- |
| Deployment          | Cloud only        | Embedded/Cloud | Embedded/Server |
| Open Source         | No                | Yes            | Yes             |
| Built-in embeddings | No                | No             | Yes             |
| Local development   | Requires internet | Native         | Native          |
| Managed scaling     | Yes               | No             | No              |

## Related Documentation

- [Pinecone Integration](integrations/pinecone.md) - Managed vector database guide
- [LanceDB Integration](integrations/lancedb.md) - Serverless vector database guide
- [Chroma Integration](integrations/chroma.md) - Open-source embedding database guide
- [Toolbox Registry](registry.md) - Querying and execution patterns
- [API Reference](api-reference.md) - Complete type definitions for embeddings
