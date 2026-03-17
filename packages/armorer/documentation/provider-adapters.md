# Provider Adapters

## Overview

Export tools as static JSON Schema definitions for use with LLM provider SDKs. Each adapter is available as a separate subpath export (the legacy `armorer/openai`/`armorer/anthropic`/`armorer/gemini` paths still work).

These adapters are **schema-only converters**. They serialize your tool definitions (name, description, and Zod schema) into the JSON format each provider expects, but they do not execute tools or handle results. You pass the output directly to the provider SDK when making API calls.

> **Anthropic SDK vs Claude Agent SDK**: The `toAnthropic()` adapter here produces static `input_schema` objects for the [Anthropic Messages API](https://docs.anthropic.com/en/docs/tool-use). If you're building with the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), use [MCP](./mcp.md) with `createMCP()` (and optionally `toMcpTools()` / `fromMcpTools()`) for live executable tools.

### OpenAI

```typescript
import { toOpenAI } from 'armorer/adapters/openai';

// Single tool
const openAITool = toOpenAI(myTool);

// Multiple tools
const openAITools = toOpenAI([tool1, tool2]);

// From registry
const openAITools = toOpenAI(toolbox);

// Use with OpenAI SDK
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages,
  tools: toOpenAI(toolbox),
});
```

> **OpenAI Chat Completions vs OpenAI Agents SDK**: The `toOpenAI()` adapter here produces static tool definitions for the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat). If you're building with the **OpenAI Agents SDK** (`@openai/agents`), use the separate [OpenAI Agents adapter](./openai-agents-sdk.md) (`armorer/open-ai/agents` or `armorer/adapters/open-ai/agents`) instead — it produces executable tool objects with result handling and tool gating.

### Anthropic

```typescript
import { toAnthropic } from 'armorer/adapters/anthropic';

// Single tool
const anthropicTool = toAnthropic(myTool);

// Multiple tools
const anthropicTools = toAnthropic([tool1, tool2]);

// From registry
const anthropicTools = toAnthropic(toolbox);

// Use with Anthropic SDK
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  messages,
  tools: toAnthropic(toolbox),
});
```

### Google Gemini

```typescript
import { toGemini } from 'armorer/adapters/gemini';

// Single tool
const geminiDeclaration = toGemini(myTool);

// Multiple tools
const geminiDeclarations = toGemini([tool1, tool2]);

// From registry
const geminiDeclarations = toGemini(toolbox);

// Use with Gemini SDK
const model = genAI.getGenerativeModel({
  model: 'gemini-pro',
  tools: [{ functionDeclarations: toGemini(toolbox) }],
});
```
