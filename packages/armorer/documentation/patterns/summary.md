# Summary

These patterns demonstrate how to build advanced functionality using Toolbox's existing primitives:

- **Circuit Breaker**: Use middleware to track failures and implement circuit breaker logic
- **Session Management**: Use context and middleware to inject session data
- **Request Deduplication**: Use middleware to track in-flight requests
- **Resource Pooling**: Use context to share resource pools across tools
- **Fallback Tools**: Use middleware or `when` for graceful degradation
- **Tool Dependencies**: Use middleware to enforce execution order
- **Audit Trails**: Use events or middleware to track all executions
- **Cost Tracking**: Use middleware to calculate and track costs
- **Conditional Execution**: Use `when` and composition for branching
- **State Management**: Use context to share state stores
- **Logging**: Use middleware for structured logging
- **Streaming**: Use events and async iterators for streaming data

All patterns are built on top of Toolbox's core features: middleware, events, context, and composition utilities.
