# Querying Tools

## Overview

Toolbox uses `queryTools(...)` for programmatic tool discovery.

- Filter by tags, text, schema keys, metadata, and custom predicates.
- Works with a toolbox, a single tool, or any iterable of tools.
- Supports semantic text matching when the toolbox has an `embed` function.

Import from `armorer/query`:

```typescript
import { queryTools } from 'armorer/query';
```

## Quick Start

```typescript
import { createToolbox } from 'armorer';
import { queryTools } from 'armorer/query';

const toolbox = createToolbox();

const communicationTools = queryTools(toolbox, {
  tags: { any: ['communication'] },
});

const nonDangerous = queryTools(toolbox, {
  tags: { none: ['dangerous'] },
});
```

## Query Criteria

```typescript
import { queryTools } from 'armorer/query';
import { z } from 'zod';

const byText = queryTools(toolbox, {
  text: { query: 'send message', mode: 'fuzzy', threshold: 0.6 },
});

const bySchemaKeys = queryTools(toolbox, {
  schema: { keys: ['recipient', 'subject'] },
});

const bySchemaShape = queryTools(toolbox, {
  schema: { matches: z.object({ recipient: z.string() }) },
});

const byMetadata = queryTools(toolbox, {
  metadata: { eq: { tier: 'premium' } },
});

const booleanGroups = queryTools(toolbox, {
  and: [{ tags: { any: ['communication'] } }],
  or: [{ text: 'email' }, { text: 'sms' }],
  not: { tags: { any: ['deprecated'] } },
});
```

## Embeddings

When `createToolbox` is configured with `embed`, `queryTools` can match semantically through `text` queries.

```typescript
import { createToolbox } from 'armorer';
import { queryTools } from 'armorer/query';

const toolbox = createToolbox([], {
  embed: async (texts) => embeddingClient.embed(texts),
});

const matches = queryTools(toolbox, {
  text: { query: 'notify customer about shipment delay', mode: 'fuzzy' },
  tags: { any: ['communication'] },
});
```

## Type Safety and IntelliSense

`queryTools` is generic over the toolbox’s concrete tool set:

- `tags.any/all/none` get IntelliSense from known tool tags.
- `schema.keys` gets IntelliSense from known input schema keys.
- Result shapes stay typed when you use `select`.

This is especially helpful when your toolbox is created from `as const` tool entries.

## Selection and Pagination

```typescript
const summaries = queryTools(toolbox, {
  select: 'summary',
  includeSchema: true,
  includeToolConfiguration: false,
  offset: 10,
  limit: 10,
});

const names = queryTools(toolbox, { select: 'name' });
```

## Events

Calling `queryTools` with a toolbox emits a `query` event on that toolbox.

See [Eventing](eventing.md) for subscription patterns.
