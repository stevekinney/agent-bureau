import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import type { JsonValue } from '../core/serialization/json';
import type { ToolCallWithArguments } from '../is-tool';
import type { ToolCall } from '../types';

const defaultCallIdRuntime = createDefaultRuntimeServices();
const TOOL_CALL_KEYS = new Set(['id', 'name', 'arguments']);

export function createToolCall<Args extends JsonValue>(
  toolName: string,
  args: Args,
  id?: string,
): ToolCall & { arguments: Args } {
  return {
    id: id ?? defaultCallIdRuntime.identifiers.next('call'),
    name: toolName,
    arguments: args,
  };
}

export function normalizeToolCall<T extends ToolCallWithArguments>(
  toolCall: T,
  runtime: RuntimeServices,
): T {
  if (toolCall.id) return toolCall;
  return { ...toolCall, id: runtime.identifiers.next('call') };
}

export function looksLikeToolCall(
  value: unknown,
  toolName: string,
): value is ToolCallWithArguments {
  if (!value || typeof value !== 'object') return false;
  if (typeof Reflect.get(value, 'name') !== 'string') return false;
  if (Reflect.get(value, 'name') !== toolName) return false;
  if (typeof Reflect.get(value, 'id') !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'arguments')) return false;
  return Object.keys(value).every((key) => TOOL_CALL_KEYS.has(key));
}
