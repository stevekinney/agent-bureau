# Agent Bureau

This workspace contains the public packages that power the tool and conversation layers for agentic applications.

## Packages

- [Armorer](/Users/stevekinney/Developer/agent-bureau/packages/armorer/README.md): tool definition, execution, registry, provider tool adapters, MCP integration, and testing helpers.
- [Conversationalist](/Users/stevekinney/Developer/agent-bureau/packages/conversationalist/README.md): immutable conversation state, history management, provider message adapters, serialization, and testing helpers.
- [Interoperability](/Users/stevekinney/Developer/agent-bureau/packages/interoperability/README.md): shared tool-call and tool-result types plus JSON-safe materializers used by both libraries.
- `packages/integration`: private cross-package integration suite for the published package surfaces.

## Key Links

- [Armorer README](/Users/stevekinney/Developer/agent-bureau/packages/armorer/README.md)
- [Conversationalist README](/Users/stevekinney/Developer/agent-bureau/packages/conversationalist/README.md)
- [Armorer API Reference](/Users/stevekinney/Developer/agent-bureau/packages/armorer/documentation/api-reference.md)
- [Conversationalist API Reference](/Users/stevekinney/Developer/agent-bureau/packages/conversationalist/documentation/api-reference.md)

## Workspace Commands

```bash
bun run build
bun run test
bun run integration
bun run coverage:check
```

The workspace uses Bun and Turbo. Package-level validation should be run from the package directory when you want the strict package-local gates.
Use `bun run coverage:check` from the repository root to run the strict 100% package-local coverage gate for the scoped public packages.
