---
"armorer": minor
---

Add `createToolboxFromOpenAPI` at the `armorer/openapi` subpath: generates a schema-validated armorer tool for every operation in an OpenAPI 3.x document.

- Parameter and request-body JSON Schemas become Zod input schemas via `jsonSchemaToZod`; local `$ref`s are resolved against `spec.components.schemas` before conversion.
- Per-operation `ToolMetadata` follows the HTTP method: `GET`/`HEAD`/`OPTIONS`/`TRACE` are `readOnly`, the rest `mutates` (with `DELETE` additionally flagged `dangerous`).
- `auth` supports bearer-token and API-key header injection; `allowOperations` filters the generated surface by `operationId` (a list or a predicate).
- `baseUrl` defaults to `spec.servers[0].url`; `fetch` is injectable for testing.

Tested against a vendored real-world OpenAPI 3.0 document (the Petstore-expanded example from `OAI/OpenAPI-Specification`), covering query/path parameters, a `$ref`-based request body, and `allOf` schema composition.
