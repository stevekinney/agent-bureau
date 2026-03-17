# Circuit Breaker

Prevent cascading failures by tracking error rates and temporarily disabling failing tools.

```typescript
import { createToolbox, createMiddleware } from 'armorer';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerConfiguration {
  failureThreshold: number; // Number of failures before opening
  resetTimeout: number; // Time in ms before attempting recovery
  halfOpenRequests: number; // Requests to try in half-open state
}

function createCircuitBreaker(configuration: CircuitBreakerConfiguration) {
  const {
    failureThreshold = 5,
    resetTimeout = 60000,
    halfOpenRequests = 3,
  } = configuration;

  const circuits = new Map<
    string,
    {
      state: CircuitState;
      failures: number;
      lastFailureTime: number;
      halfOpenAttempts: number;
    }
  >();

  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: unknown) {
        // Initialize circuit for this tool
        if (!circuits.has(toolName)) {
          circuits.set(toolName, {
            state: 'closed',
            failures: 0,
            lastFailureTime: 0,
            halfOpenAttempts: 0,
          });
        }

        const circuit = circuits.get(toolName)!;
        const now = Date.now();

        // Check if circuit should transition from open to half-open
        if (circuit.state === 'open' && now - circuit.lastFailureTime > resetTimeout) {
          circuit.state = 'half-open';
          circuit.halfOpenAttempts = 0;
        }

        // Reject if circuit is open
        if (circuit.state === 'open') {
          throw new Error(
            `Circuit breaker is OPEN for tool "${toolName}". Service temporarily unavailable.`,
          );
        }

        // Limit requests in half-open state
        if (circuit.state === 'half-open') {
          if (circuit.halfOpenAttempts >= halfOpenRequests) {
            throw new Error(
              `Circuit breaker is HALF-OPEN for tool "${toolName}". Maximum concurrent attempts reached.`,
            );
          }
          circuit.halfOpenAttempts++;
        }

        try {
          // Resolve execute function if lazy
          const executeFn =
            typeof originalExecute === 'function'
              ? originalExecute
              : await originalExecute;

          const result = await executeFn(params, context);

          // Success - reset circuit if it was half-open
          if (circuit.state === 'half-open') {
            circuit.state = 'closed';
            circuit.failures = 0;
            circuit.halfOpenAttempts = 0;
          }

          return result;
        } catch (error) {
          // Failure - track and potentially open circuit
          circuit.failures++;
          circuit.lastFailureTime = now;

          if (circuit.state === 'half-open') {
            // Failed during recovery - reopen circuit
            circuit.state = 'open';
            circuit.halfOpenAttempts = 0;
          } else if (circuit.failures >= failureThreshold) {
            // Too many failures - open circuit
            circuit.state = 'open';
          }

          throw error;
        }
      },
    };
  });
}

// Usage
const toolbox = createToolbox([], {
  middleware: [
    createCircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 30000, // 30 seconds
      halfOpenRequests: 2,
    }),
  ],
});
```

## Circuit Breaker with Monitoring

Add observability to track circuit state changes:

```typescript
function createCircuitBreakerWithEvents(configuration: CircuitBreakerConfiguration) {
  const middleware = createCircuitBreaker(configuration);
  const eventTarget = new EventTarget();

  // Wrap the middleware to emit events
  return {
    middleware,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      eventTarget.addEventListener(type, listener);
    },
  };
}

// Usage
const breaker = createCircuitBreakerWithEvents({
  failureThreshold: 5,
  resetTimeout: 60000,
});

breaker.addEventListener('circuit-opened', (event) => {
  console.log('Circuit opened for tool:', event.detail.toolName);
});

const toolbox = createToolbox([], {
  middleware: [breaker.middleware],
});
```
