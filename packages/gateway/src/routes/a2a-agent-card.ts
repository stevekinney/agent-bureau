/**
 * A2A Agent Card (AB-71): `GET /.well-known/agent-card.json`.
 *
 * Verified against the A2A Protocol Specification v1.0.0 — GitHub
 * `a2aproject/A2A`, `docs/specification.md` at commit
 * `3303592588e388e62e0f69f701af531d2f4e3991` (tag `v1.0.1`, same content as
 * `v1.0.0`):
 *
 * - Well-known URI: Section 14.3 ("Well-Known URI Registration") registers
 *   the URI suffix `agent-card.json`, i.e. `/.well-known/agent-card.json`.
 * - Agent Card shape: Section 4.4.1 (`AgentCard` message,
 *   `specification/a2a.proto`) — `name`, `description`, `supportedInterfaces`,
 *   `provider`, `version`, `capabilities`, `defaultInputModes`,
 *   `defaultOutputModes`, `skills` are all REQUIRED except `provider`.
 *
 * `bureau` has no first-class "agent identity" — a bureau dispatches one or
 * more agents by name (`CreateRunRequest.agentName`), it isn't itself a
 * single named agent. The card surfaces the bureau's registered tools
 * (`Bureau.getConfiguration().tools`) as A2A skills, which is the closest
 * existing capability descriptor bureau already has, and lets an operator
 * override name/description/version/provider via `GatewayOptions.a2a`.
 */
import { Hono } from 'hono';

import type { A2AAgentCardOptions, Bureau } from '../types';

/** A2A `AgentSkill` (Section 4.4.4 / `specification/a2a.proto`). */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/** A2A `AgentInterface` (Section 4.4.2 / `specification/a2a.proto`). */
export interface A2AAgentInterface {
  url: string;
  protocolBinding: 'JSONRPC';
  protocolVersion: string;
}

/** A2A `AgentCard` (Section 4.4.1 / `specification/a2a.proto`), JSON shape. */
export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: A2AAgentInterface[];
  provider?: { organization: string; url: string };
  version: string;
  iconUrl?: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
}

const A2A_PROTOCOL_VERSION = '1.0';
const DEFAULT_NAME = 'Agent Bureau';
const DEFAULT_DESCRIPTION =
  'An agent-bureau server exposing bureau agents over the A2A JSON-RPC transport.';
const DEFAULT_VERSION = '0.0.0';

/**
 * Builds the Agent Card. `origin` is the incoming request's own
 * scheme+host — the default base URL for `supportedInterfaces[].url` —
 * overridden by `options.baseUrl` for reverse-proxied deployments.
 */
export function buildAgentCard(
  bureau: Bureau,
  options: A2AAgentCardOptions | undefined,
  origin: string,
): A2AAgentCard {
  const configuration = bureau.getConfiguration();
  const baseUrl = options?.baseUrl ?? origin;
  const skills: A2AAgentSkill[] = configuration.tools.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: [],
  }));

  return {
    name: options?.name ?? DEFAULT_NAME,
    description: options?.description ?? DEFAULT_DESCRIPTION,
    supportedInterfaces: [
      {
        url: new URL('/a2a', baseUrl).toString(),
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    ...(options?.provider ? { provider: options.provider } : {}),
    version: options?.version ?? DEFAULT_VERSION,
    ...(options?.iconUrl ? { iconUrl: options.iconUrl } : {}),
    capabilities: {
      // Streaming (`message/stream`/SSE binding) is deferred — see the header
      // comment in `routes/a2a.ts` for the spec citation permitting
      // non-streaming servers.
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
  };
}

export function createAgentCardRoutes(bureau: Bureau, options: A2AAgentCardOptions | undefined) {
  const app = new Hono();

  app.get('/', (context) => {
    const origin = new URL(context.req.url).origin;
    return context.json(buildAgentCard(bureau, options, origin), 200);
  });

  return app;
}
