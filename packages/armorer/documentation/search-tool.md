# Search Tools Tool

## Overview

Toolbox provides a pre-configured `search-tools` tool that enables semantic discovery of registered tools. This is particularly useful for:

- **Agentic workflows**: Where the LLM needs to discover which tools are available for a task
- **Large tool registries**: When you have many tools and don't want to pass all of them in every request
- **Meta-tools**: Building assistants that help users find the right tool for their task

The search tool works both with and without vector embeddings:

- **With embeddings**: Enables semantic search (e.g., "notify someone" finds `send-email`)
- **Without embeddings**: Falls back to fuzzy text matching on names, descriptions, and tags

## Installation

The search tools tool is available via the `armorer/tools` export:

```typescript
import { createSearchTool } from 'armorer/tools';
```

## Basic Usage

```typescript
import { createToolbox, createTool } from 'armorer';
import { createSearchTool } from 'armorer/tools';
import { z } from 'zod';

// Create a toolbox and register some tools
const toolbox = createToolbox();

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
      return { sent: true };
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
      attendees: z.array(z.string().email()),
    }),
    tags: ['calendar', 'scheduling'],
    async execute({ title }) {
      return { scheduled: true, eventId: 'evt_123' };
    },
  },
  toolbox,
);

// Create the search tool (automatically registered with toolbox)
const searchTool = createSearchTool(toolbox);

// Search for tools
const results = await searchTool({ query: 'contact someone' });
console.log(results);
// [
//   { name: 'send-email', description: '...', tags: ['communication', 'email'], score: 1.5 },
//   { name: 'schedule-meeting', description: '...', tags: ['calendar', 'scheduling'], score: 0.8 }
// ]
```

## With Semantic Search (Embeddings)

For better search results, configure your toolbox with an embedding function:

```typescript
import { createToolbox } from 'armorer';
import { createSearchTool } from 'armorer/tools';
import OpenAI from 'openai';

const openai = new OpenAI();

const toolbox = createToolbox([], {
  embed: async (texts) => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map((item) => item.embedding);
  },
});

// Register tools...

// Create search tool
const searchTool = createSearchTool(toolbox);

// Semantic search finds relevant tools even without exact keyword matches
const results = await searchTool({ query: 'notify user about something' });
// Finds 'send-email' even though 'notify' isn't in the name or description
```

## Configuration Options

```typescript
interface CreateSearchToolOptions {
  /** Default maximum number of tools to return. @default 10 */
  limit?: number;

  /** Include matching reasons in results for debugging. @default false */
  explain?: boolean;

  /** Custom name for the tool. @default 'search-tools' */
  name?: string;

  /** Custom description for the tool. */
  description?: string;

  /** Additional tags to add to the tool. */
  tags?: string[];

  /** Automatically register the tool with the toolbox. @default true */
  register?: boolean;
}
```

### Example with Options

```typescript
const searchTool = createSearchTool(toolbox, {
  limit: 5, // Return at most 5 tools
  explain: true, // Include match reasons
  name: 'find-tools', // Custom tool name
  tags: ['meta'], // Additional tags
});

const results = await searchTool({ query: 'send message' });
// Results include reasons when explain is true:
// [
//   {
//     name: 'send-email',
//     description: '...',
//     score: 2.1,
//     reasons: ['text:description', 'tag:communication']
//   }
// ]
```

## Search Input Parameters

The search tool accepts these parameters:

| Parameter | Type       | Required | Description                                          |
| --------- | ---------- | -------- | ---------------------------------------------------- |
| `query`   | `string`   | Yes      | The search query to find relevant tools              |
| `limit`   | `number`   | No       | Override the default limit for this search           |
| `tags`    | `string[]` | No       | Filter to tools that have at least one of these tags |

### Filtering by Tags

```typescript
// Find only communication-related tools
const results = await searchTool({
  query: 'send something',
  tags: ['communication', 'messaging'],
});
```

## Search Results

Each result contains:

| Field         | Type       | Description                                    |
| ------------- | ---------- | ---------------------------------------------- |
| `name`        | `string`   | The tool's name                                |
| `description` | `string`   | The tool's description                         |
| `tags`        | `string[]` | Tags associated with the tool (if any)         |
| `score`       | `number`   | Relevance score (higher is more relevant)      |
| `reasons`     | `string[]` | Match explanations (when `explain` is enabled) |

## Dynamic Tool Discovery

The search tool automatically discovers tools registered at any time—before or after the search tool itself is installed. This is because it queries `toolbox.tools()` at execution time, not at creation time.

```typescript
const toolbox = createToolbox();

// Install the search tool first
createSearchTool(toolbox);

// Register tools later - they will be discoverable
toolbox.register(
  createTool({
    name: 'send-email',
    description: 'Send an email',
    input: z.object({ to: z.string(), body: z.string() }),
    async execute({ to, body }) {
      return { sent: true };
    },
  }),
);

// The search tool finds tools registered after it was installed
const results = await toolbox.execute({
  name: 'search-tools',
  arguments: { query: 'send' },
});
// Results include 'send-email'
```

This means you can:

- Install the search tool early in your application setup
- Dynamically register tools based on user permissions or feature flags
- Load tools lazily and have them immediately searchable

## Without Auto-Registration

If you want to create the search tool without automatically registering it:

```typescript
const searchTool = createSearchTool(toolbox, {
  register: false,
});

// Manually register later if needed
toolbox.register(searchTool);
```

## Using with Provider Adapters

The search tool integrates seamlessly with provider adapters:

```typescript
import { toOpenAI } from 'armorer/adapters/openai';

// Get all tools including the search tool
const tools = toOpenAI(toolbox);

// Use with OpenAI
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Find tools that can help me contact someone' }],
  tools,
});
```

## Agentic Workflow Example

Here's a complete example of using the search tool in an agentic workflow:

```typescript
import { createToolbox, createTool } from 'armorer';
import { createSearchTool } from 'armorer/tools';
import { toOpenAI } from 'armorer/adapters/openai';
import OpenAI from 'openai';
import { z } from 'zod';

const openai = new OpenAI();

// Create toolbox with embeddings for semantic search
const toolbox = createToolbox([], {
  embed: async (texts) => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map((item) => item.embedding);
  },
});

// Register your tools
createTool(
  {
    name: 'send-email',
    description: 'Send an email to recipients',
    input: z.object({
      to: z.array(z.string().email()),
      subject: z.string(),
      body: z.string(),
    }),
    tags: ['communication'],
    async execute({ to, subject, body }) {
      // Implementation
      return { sent: true };
    },
  },
  toolbox,
);

createTool(
  {
    name: 'get-contacts',
    description: 'Retrieve contact information',
    input: z.object({
      filter: z.string().optional(),
    }),
    tags: ['contacts', 'readonly'],
    async execute({ filter }) {
      // Implementation
      return [{ name: 'John', email: 'john@example.com' }];
    },
  },
  toolbox,
);

// Add the search tool
createSearchTool(toolbox, { explain: true });

// Agent loop
async function runAgent(userMessage: string) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a helpful assistant with access to various tools.

If you're not sure which tool to use, use the search-tools tool to find relevant tools.
Always explain which tools you found and why you chose the one you're using.`,
    },
    { role: 'user', content: userMessage },
  ];

  while (true) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      tools: toOpenAI(toolbox),
    });

    const choice = response.choices[0];
    if (!choice) break;

    if (choice.finish_reason === 'stop') {
      console.log('Assistant:', choice.message?.content);
      break;
    }

    if (choice.message?.tool_calls) {
      messages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        const result = await toolbox.execute({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.result ?? result.error),
        });
      }
    }
  }
}

// Example: The agent will first search for tools, then use the appropriate one
runAgent('I need to notify John about the meeting tomorrow');
```

## Best Practices

1. **Use embeddings for better results**: Semantic search significantly improves tool discovery, especially when queries don't match exact keywords.

2. **Add descriptive tool descriptions**: The search tool relies on tool names, descriptions, and tags. Better metadata means better search results.

3. **Use consistent tags**: Establish a tagging convention across your tools (e.g., `communication`, `database`, `file-system`) to enable tag-based filtering.

4. **Enable explain for debugging**: When developing or troubleshooting, enable `explain: true` to see why tools are being matched.

5. **Consider the search tool count**: The search tool counts against your tool limit if you're using provider-specific limits. Factor this in when designing your tool set.

## Related Documentation

- [Searching Tools](searching-tools.md) - Programmatic `queryTools` guide
- [Embeddings & Semantic Search](embeddings.md) - Configure embeddings for semantic search
- [Toolbox Registry](registry.md) - Learn about `queryTools`
- [Provider Adapters](provider-adapters.md) - Use tools with OpenAI, Anthropic, and Gemini
