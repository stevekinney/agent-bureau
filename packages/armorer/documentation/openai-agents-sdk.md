# OpenAI Agents SDK Integration

## Overview

Integrate Toolbox tools with the OpenAI Agents SDK (`@openai/agents`). This integration converts Toolbox tools into live, executable SDK tool objects with tool classification (mutating/dangerous/read-only) and permission-based gating.

> **Not the same as `toOpenAI()`**: The [provider adapter](./provider-adapters.md) `toOpenAI()` produces static JSON Schema definitions for the OpenAI Chat Completions API. This integration is different — it produces runnable tool objects that the OpenAI Agents SDK's `tool()` function expects, including execution handlers and tool classification. Use `toOpenAI()` when calling the Chat Completions API directly; use this integration when building with the OpenAI Agents SDK.

## Prerequisites

Install the OpenAI Agents SDK as a runtime dependency:

```bash
bun add @openai/agents
```

## Converting Tools

Use `toOpenAIAgentTools` to convert Toolbox tools to OpenAI Agents SDK tools. This helper is async because the SDK is loaded lazily:

```typescript
import { createToolbox, createTool } from 'armorer';
import { toOpenAIAgentTools } from 'armorer/open-ai/agents';
import { Agent, run } from '@openai/agents';
import { z } from 'zod';

const toolbox = createToolbox();
createTool(
  {
    name: 'sum',
    description: 'adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    async execute({ a, b }) {
      return a + b;
    },
  },
  toolbox,
);

// Convert to OpenAI Agents SDK tools
const { tools } = await toOpenAIAgentTools(toolbox);

// Use with OpenAI Agents SDK
const agent = new Agent({
  name: 'Calculator',
  instructions: 'You are a helpful calculator assistant',
  tools,
});

const result = await run(agent, 'What is 7 plus 22?');
console.log(result.finalOutput);
```

### Tool Classification

The conversion automatically classifies tools and returns lists for permission control:

```typescript
const { tools, toolNames, mutatingToolNames, dangerousToolNames } =
  await toOpenAIAgentTools(toolbox);

console.log('All tools:', toolNames);
console.log('Mutating tools:', mutatingToolNames);
console.log('Dangerous tools:', dangerousToolNames);
```

Tools are classified as:

- **Mutating**: via `metadata.mutates: true` or `tags: ['mutating']`
- **Dangerous**: via `metadata.dangerous: true` or `tags: ['dangerous']`
- **Read-only**: via `metadata.readOnly: true` or `tags: ['read-only', 'readonly']`

### Custom Tool Configuration

Override tool properties during conversion:

```typescript
const { tools } = await toOpenAIAgentTools(toolbox, {
  toolConfiguration: (tool) => ({
    name: `custom_${tool.name}`,
    description: `Enhanced: ${tool.description}`,
  }),
  formatResult: (result) => {
    return { success: true, data: result.result };
  },
});
```

## Tool Gating

Use `createOpenAIToolGate` to implement permission-based tool access control. This is useful for CLI applications or agent systems that need to restrict tool usage based on flags like `--apply` or `--dangerous`.

```typescript
import { createToolbox, createTool } from 'armorer';
import { createOpenAIToolGate } from 'armorer/open-ai/agents';
import { z } from 'zod';

const toolbox = createToolbox();

createTool(
  {
    name: 'read-file',
    description: 'reads a file',
    input: z.object({ path: z.string() }),
    metadata: { readOnly: true },
    async execute({ path }) {
      return { content: '...' };
    },
  },
  toolbox,
);

createTool(
  {
    name: 'write-file',
    description: 'writes a file',
    input: z.object({ path: z.string(), content: z.string() }),
    metadata: { mutates: true },
    async execute({ path, content }) {
      return { success: true };
    },
  },
  toolbox,
);

createTool(
  {
    name: 'delete-file',
    description: 'deletes a file',
    input: z.object({ path: z.string() }),
    metadata: { mutates: true, dangerous: true },
    async execute({ path }) {
      return { success: true };
    },
  },
  toolbox,
);

// Create a gate function
const toolGate = createOpenAIToolGate({
  registry: toolbox,
  readOnly: false, // Set to true to deny all mutating tools
  allowMutation: true, // Allow mutating tools (overridden by readOnly)
  allowDangerous: false, // Deny dangerous tools
});

// Use the gate to check tool permissions
const readDecision = await toolGate('read-file');
console.log(readDecision); // { behavior: 'allow' }

const writeDecision = await toolGate('write-file');
console.log(writeDecision); // { behavior: 'allow' }

const deleteDecision = await toolGate('delete-file');
console.log(deleteDecision); // { behavior: 'deny', message: 'Use --dangerous to allow this tool.' }
```

### Gate Options

```typescript
type OpenAIToolGateOptions = {
  // The registry, tool, or array of tools to gate
  registry: Toolbox | Tool | Tool[];

  // Enable read-only mode (denies all mutating tools)
  readOnly?: boolean;

  // Allow mutating tools (default: !readOnly)
  allowMutation?: boolean;

  // Allow dangerous tools (default: true)
  allowDangerous?: boolean;

  // Classify builtin tools that aren't in the registry
  builtin?: {
    readOnly?: string[];
    mutating?: string[];
    dangerous?: string[];
  };

  // Allow tools not in registry or builtin lists (default: false)
  allowUnknown?: boolean;

  // Custom tool configuration (for name overrides)
  toolConfiguration?: (tool: Tool) => OpenAIAgentToolConfiguration;

  // Custom deny messages
  messages?: {
    mutating?: string;
    dangerous?: string;
    unknown?: (toolName: string) => string;
  };
};
```

### Handling Builtin Tools

When working with agent systems that have their own builtin tools (like file system access), use the `builtin` option to classify them:

```typescript
const toolGate = createOpenAIToolGate({
  registry: toolbox,
  readOnly: true,
  builtin: {
    readOnly: ['View', 'GlobTool', 'GrepTool', 'LS'],
    mutating: ['Edit', 'Replace', 'Write', 'Bash'],
    dangerous: ['Bash'],
  },
});

// Builtin read-only tools are allowed
const viewDecision = await toolGate('View');
console.log(viewDecision); // { behavior: 'allow' }

// Builtin mutating tools are denied in read-only mode
const editDecision = await toolGate('Edit');
console.log(editDecision); // { behavior: 'deny', message: '...' }
```

## Using MCP Servers

Alternatively, you can expose Toolbox tools as an MCP server and connect the OpenAI Agents SDK to it. See [Agent SDK Integrations](./agent-sdk-integrations.md#openai-agents-sdk-openaiagents) for examples.

## Type Exports

The integration exports the following types:

- `OpenAIAgentTool`: Return type of OpenAI Agents SDK's `tool()` function
- `OpenAIAgentToolConfiguration`: Tool configuration override options
- `OpenAIAgentToolOptions`: Options for `toOpenAIAgentTools()`
- `OpenAIAgentToolsResult`: Return type of `toOpenAIAgentTools()`
- `OpenAIToolGateOptions`: Options for `createOpenAIToolGate()`
- `OpenAIToolGateDecision`: Return type of the gate function (`{ behavior: 'allow' | 'deny', message?: string }`)
