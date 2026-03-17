# Testing (`armorer/test`)

## Overview

`armorer/test` provides helpers for testing tool execution and agent/toolbox workflows:

- `createMockTool(options)`
- `createTestRegistry()`

Import:

```typescript
import { createMockTool, createTestRegistry } from 'armorer/test';
```

## `createMockTool(options)`

Creates a mock `Tool` with built-in call tracking and behavior controls.

Options (`MockToolOptions`):

- `name?`: mock tool name (default: `'mock-tool'`)
- `input?`: Zod schema for input validation
- `impl?`: sync or async implementation for custom behavior

Returned value:

- Standard `Tool` interface
- `calls: TInput[]`: all captured inputs
- `mockResolve(value)`: force future executions to resolve with `value`
- `mockReject(error)`: force future executions to reject with `error`
- `mockReset()`: clear call history and reset forced behavior

```typescript
import { createMockTool } from 'armorer/test';
import { z } from 'zod';

const weather = createMockTool({
  name: 'weather',
  input: z.object({ city: z.string() }),
});

weather.mockResolve({ temp: 72, conditions: 'sunny' });

const result = await weather({ city: 'Chicago' });
console.log(result); // { temp: 72, conditions: 'sunny' }
console.log(weather.calls); // [{ city: 'Chicago' }]
```

## `createTestRegistry()`

Creates a `Toolbox` configured for tests with execution history tracking.

Returned value (`TestRegistry`):

- Full `Toolbox` API
- `history`: array of `{ call, result?, error? }`
- `clearHistory()`: reset recorded history

`history` is populated from `tool.finished` events while tools execute through the registry.

```typescript
import { createMockTool, createTestRegistry } from 'armorer/test';

const toolbox = createTestRegistry();
const greet = createMockTool({ name: 'greet' });

greet.mockResolve({ message: 'hello' });
toolbox.register(greet);

await toolbox.execute({ name: 'greet', arguments: {} });

console.log(toolbox.history.length); // 1
console.log(toolbox.history[0]?.call.name); // 'greet'
```

## End-to-End Example

```typescript
import { describe, expect, it } from 'bun:test';
import { createMockTool, createTestRegistry } from 'armorer/test';

describe('agent workflow', () => {
  it('records calls and results', async () => {
    const toolbox = createTestRegistry();
    const lookupUser = createMockTool<{ id: string }, { id: string; role: string }>({
      name: 'lookup-user',
    });

    lookupUser.mockResolve({ id: 'u1', role: 'admin' });
    toolbox.register(lookupUser);

    const result = await toolbox.execute({
      name: 'lookup-user',
      arguments: { id: 'u1' },
    });

    expect(result.error).toBeUndefined();
    expect(lookupUser.calls).toEqual([{ id: 'u1' }]);
    expect(toolbox.history).toHaveLength(1);
    expect(toolbox.history[0]?.call.name).toBe('lookup-user');
  });
});
```
