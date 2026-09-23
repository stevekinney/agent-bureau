import type {
  AnthropicClient,
  AnthropicStreamingClient,
  AnthropicTokenCountingClient,
} from './types.ts';

interface AnthropicConstructor {
  new (options?: Record<string, unknown>): unknown;
}

interface NodeModuleRuntime {
  createRequire: (url: string) => (moduleName: string) => unknown;
}

interface NodeProcessRuntime {
  getBuiltinModule: (moduleName: string) => unknown;
}

const BROWSER_CLIENT_ERROR =
  '[provider:anthropic] A client option is required in browser environments; ' +
  'the default Anthropic SDK client is available only in Node.js.';

export function createAnthropicSdkClient<Client>(
  options: Record<string, unknown>,
  isClient: (value: unknown) => value is Client,
): Client {
  const constructor = loadAnthropicConstructor();
  const client = new constructor(options);
  if (!isClient(client))
    throw new Error('[provider:anthropic] The Anthropic SDK client has an unexpected shape.');
  return client;
}

export function isAnthropicClient(value: unknown): value is AnthropicClient {
  const messages = isRecord(value) ? value['messages'] : undefined;
  return isRecord(messages) && typeof messages['create'] === 'function';
}

export function isAnthropicTokenCountingClient(
  value: unknown,
): value is AnthropicTokenCountingClient {
  const messages = isRecord(value) ? value['messages'] : undefined;
  return isRecord(messages) && typeof messages['countTokens'] === 'function';
}

export function isAnthropicStreamingClient(value: unknown): value is AnthropicStreamingClient {
  return isAnthropicClient(value);
}

function loadAnthropicConstructor(): AnthropicConstructor {
  const runtimeProcess = Reflect.get(globalThis, 'process');
  if (!isNodeProcessRuntime(runtimeProcess)) throw new Error(BROWSER_CLIENT_ERROR);

  const nodeModule = runtimeProcess.getBuiltinModule('node:module');
  if (!isNodeModuleRuntime(nodeModule))
    throw new Error('[provider:anthropic] Node.js module loading is unavailable.');

  const require = nodeModule.createRequire(import.meta.url);
  const sdk = require('@anthropic-ai/sdk');
  if (!isObjectLike(sdk))
    throw new Error('[provider:anthropic] The Anthropic SDK has no constructor.');
  const constructor = Reflect.get(sdk, 'default') ?? Reflect.get(sdk, 'Anthropic') ?? sdk;
  if (!isAnthropicConstructor(constructor))
    throw new Error('[provider:anthropic] The Anthropic SDK has no constructor.');
  return constructor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isAnthropicConstructor(value: unknown): value is AnthropicConstructor {
  return typeof value === 'function';
}

function isNodeModuleRuntime(value: unknown): value is NodeModuleRuntime {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'createRequire') === 'function'
  );
}

function isNodeProcessRuntime(value: unknown): value is NodeProcessRuntime {
  return isRecord(value) && typeof value['getBuiltinModule'] === 'function';
}
