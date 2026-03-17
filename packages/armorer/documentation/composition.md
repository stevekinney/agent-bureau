# Tool Composition

## Overview

Compose tools with pipelines and branching utilities.

Chain and specialize tools with `pipe()`, `bind()`, `tap()`, `when()`, `parallel()`, and `retry()`. The output of each tool flows as input to the next, with full TypeScript type inference preserved across the chain. Composition helpers are exported from `armorer/utilities` to keep the core export small.

Pipelines are first-class tools. The result of `pipe()` is an `Tool`, so you can register it, query it via registry helpers, serialize it, and export it to provider adapters just like any other tool.

### pipe()

Chains tools left-to-right (data flows forward):

```typescript
import { createTool } from 'armorer';
import { pipe } from 'armorer/utilities';
import { z } from 'zod';

const parseNumber = createTool({
  name: 'parse-number',
  description: 'Parse string to number',
  input: z.object({ str: z.string() }),
  execute: async ({ str }) => parseInt(str, 10),
});

const double = createTool({
  name: 'double',
  description: 'Double a number',
  input: z.object({ value: z.number() }),
  execute: async ({ value }) => ({ value: value * 2 }),
});

const stringify = createTool({
  name: 'stringify',
  description: 'Format as result string',
  input: z.object({ value: z.number() }),
  execute: async ({ value }) => `Result: ${value}`,
});

// Chain tools together - types flow through automatically
const pipeline = pipe(parseNumber, double, stringify);

// Input type is inferred from first tool: { str: string }
// Output type is inferred from last tool: string
const result = await pipeline({ str: '21' });
console.log(result); // "Result: 42"
```

### bind()

Bind some or all parameters of a tool and get back a new tool that only needs the remaining inputs. Bound keys are removed from the new tool's schema; any provided values for those keys are ignored in favor of the bound values.

Optional third argument: `{ name?: string; description?: string }`.

```typescript
import { createTool } from 'armorer';
import { bind } from 'armorer/utilities';

const sendEmail = createTool({
  name: 'send-email',
  description: 'Send an email',
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  async execute({ to, subject, body }) {
    // ...
    return { to, subject, body };
  },
});

const sendAlert = bind(sendEmail, { to: 'alerts@example.com' }, { name: 'send-alert' });
await sendAlert({ subject: 'Outage', body: 'Investigating' });
```

`bind()` operates on object schemas and removes the bound keys from the input shape.

### tap()

Run a side effect after a tool and pass through its output unchanged.

```typescript
import { tap } from 'armorer/utilities';

const loggedFetch = tap(fetchUser, (user) => {
  console.log('Fetched user', user.id);
});

const user = await loggedFetch({ id: 'user-123' });
```

### when()

Branch between tools based on a predicate. If no else tool is provided, the input is returned unchanged.

```typescript
import { when } from 'armorer/utilities';

const route = when(({ severity }) => severity === 'high', sendAlert, logTicket);

await route({ severity: 'high' });
```

### parallel()

Run multiple tools with the same input concurrently and return their outputs in order.

```typescript
import { parallel } from 'armorer/utilities';

const fanout = parallel(fetchUser, fetchOrders, fetchUsage);
const [user, orders, usage] = await fanout({ id: 'user-123' });
```

### retry()

Retry a tool on failure with configurable attempts and backoff.

```typescript
import { retry } from 'armorer/utilities';

const reliableFetch = retry(fetchUser, {
  attempts: 3,
  delayMs: 200,
  backoff: 'exponential',
});

const user = await reliableFetch({ id: 'user-123' });
```

### preprocess()

Transform inputs before they're passed to a tool. Useful for normalizing, validating, or enriching input data.

```typescript
import { preprocess } from 'armorer/utilities';

const addNumbers = createTool({
  name: 'add-numbers',
  input: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => a + b,
});

// Preprocess to convert string numbers to actual numbers
const addNumbersWithPreprocessing = preprocess(
  addNumbers,
  async (input: { a: string; b: string }) => ({
    a: Number(input.a),
    b: Number(input.b),
  }),
);

// Now accepts string inputs
const result = await addNumbersWithPreprocessing({ a: '5', b: '3' });
console.log(result); // 8
```

### postprocess()

Transform outputs after a tool executes. Useful for formatting, enriching, or normalizing output data.

```typescript
import { postprocess } from 'armorer/utilities';

const fetchUser = createTool({
  name: 'fetch-user',
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ userId: id, name: 'John' }),
});

// Postprocess to format the output
const fetchUserFormatted = postprocess(fetchUser, async (output) => ({
  ...output,
  displayName: `${output.name} (${output.userId})`,
}));

// Returns enriched output
const result = await fetchUserFormatted({ id: '123' });
// { userId: '123', name: 'John', displayName: 'John (123)' }
```

### Composed Tools are Tools

Pipelines created with `pipe()`, as well as tools created with `bind()`, `tap()`, `when()`, `parallel()`, `retry()`, `preprocess()`, and `postprocess()`, are valid tools in their own right. They implement the full `Tool` interface (and pass `isTool()`), so you can register, query via registry helpers, serialize, and adapt them just like any other tool.

```typescript
import { isTool } from 'armorer';
import { pipe } from 'armorer/utilities';

const pipeline = pipe(parseNumber, double);
console.log(isTool(pipeline)); // true

// Register in a toolbox
toolbox.register(pipeline);

// Serialize or export
const json = pipeline.toJSON();

// Listen to events
pipeline.addEventListener('step-start', (e) => {
  console.log(`Step ${e.detail.stepIndex}: ${e.detail.stepName}`);
});

pipeline.addEventListener('step-complete', (e) => {
  console.log(`Step ${e.detail.stepIndex} output:`, e.detail.output);
});

// Compose further
const extendedPipeline = pipe(pipeline, stringify);
```

### Error Handling

Errors are wrapped with step context for debugging:

```typescript
import { PipelineError } from 'armorer/utilities';

try {
  await pipeline({ str: 'invalid' });
} catch (e) {
  if (e.message.includes('Pipeline failed at step')) {
    // Error message includes: "Pipeline failed at step 1 (double)"
    console.error(e.message);
  }
}

// Or use executeWith for detailed results
const result = await pipeline.executeWith({ params: { str: '21' } });
if (result.error) {
  console.error('Pipeline error:', result.error);
}
```
