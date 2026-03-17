# JSON Schema Output

## Overview

Generate JSON Schema output for provider tool formats.

You can export JSON Schema from either a single tool or an entire toolbox.

## Single Tool JSON Schema

Get JSON Schema representation for one tool definition:

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

const tool = createTool({
  name: 'my-tool',
  description: 'Does something',
  input: z.object({ input: z.string() }),
  execute: async () => 'done',
});

const jsonSchema = tool.toJSON();
// {
//   schemaVersion: '2020-12',
//   id: 'default:my-tool',
//   name: 'my-tool',
//   description: 'Does something',
//   input: { type: 'object', properties: { input: { type: 'string' } }, ... }
// }
```

`tool.toJSON()` returns plain JSON and is safe to `JSON.stringify`.

## Toolbox JSON Schema

Export all registered tools as JSON Schema:

```typescript
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox();

toolbox.register(
  createTool({
    name: 'send-email',
    description: 'Send an email',
    input: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
    async execute({ to, subject, body }) {
      return { sent: true, to };
    },
  }),
);

const toolboxJSONSchema = toolbox.toJSON({ format: 'json-schema' });
// [
//   {
//     schemaVersion: '2020-12',
//     id: 'default:send-email',
//     name: 'send-email',
//     description: 'Send an email',
//     input: { type: 'object', properties: { ... }, required: [...] }
//   }
// ]

const serialized = JSON.stringify(toolboxJSONSchema, null, 2); // valid JSON
```

`toolbox.toJSON()` without options still returns tool configurations for in-process rehydration. Use `toolbox.toJSON({ format: 'json-schema' })` when you need standards-based JSON Schema output.
