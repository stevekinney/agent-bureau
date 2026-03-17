# AbortSignal Support

## Overview

Use AbortSignal to cancel tool execution and propagate cancellation.

Cancel tool execution with standard AbortController:

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort('Timeout'), 5000);

const result = await tool.execute(
  { id: 'call-1', name: 'slow-tool', arguments: {} },
  { signal: controller.signal },
);

if (result.error) {
  console.log('Cancelled:', result.error);
}
```
