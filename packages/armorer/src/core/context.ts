import type { JsonObject } from './serialization/json';

export type Logger = {
  debug?: (message: string, data?: JsonObject) => void;
  info?: (message: string, data?: JsonObject) => void;
  warn?: (message: string, data?: JsonObject) => void;
  error?: (message: string, data?: JsonObject) => void;
};

export type Span = {
  setAttribute?: (key: string, value: string | number | boolean) => void;
  addEvent?: (name: string, attributes?: JsonObject) => void;
  end?: () => void;
};

export type Tracer = {
  startSpan?: (name: string, attributes?: JsonObject) => Span;
};

export type AbortSignalLike = {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener: (type: 'abort', listener: () => void, options?: unknown) => void;
  removeEventListener: (type: 'abort', listener: () => void, options?: unknown) => void;
};

export type ToolUser = {
  id?: string;
  name?: string;
  roles?: readonly string[];
  metadata?: JsonObject;
};

export type ToolTenant = {
  id?: string;
  name?: string;
  metadata?: JsonObject;
};

export type ToolContext = {
  runId?: string;
  requestId?: string;
  logger?: Logger;
  tracer?: Tracer;
  user?: ToolUser;
  tenant?: ToolTenant;
  signal?: AbortSignal | AbortSignalLike;
};
