import { BureauError } from 'bureau';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { resolvePrincipal, resolveTrustedRequestContext } from '../middleware/authentication';
import type { Bureau, CreateRunRequest } from '../types';

const HOOK_RUN_OPERATION = 'hooks:create-run';

type HookReceipt =
  | { status: 202; body: Awaited<ReturnType<Bureau['createRun']>> }
  | {
      status: 400 | 404 | 429 | 503;
      body: { error: { code: string; message: string; requestId?: string } };
    };

type IdempotencyEntry = {
  requestFingerprint: string;
  receipt: Promise<HookReceipt>;
};

export type HookIdempotencyRegistry = {
  delete(principal: string, idempotencyKey: string): void;
  get(principal: string, idempotencyKey: string): IdempotencyEntry | undefined;
  has(principal: string, idempotencyKey: string): boolean;
  set(principal: string, idempotencyKey: string, entry: IdempotencyEntry): void;
};

export function createHookIdempotencyRegistry(): HookIdempotencyRegistry {
  const entries = new Map<string, IdempotencyEntry>();
  const scopedKey = (principal: string, idempotencyKey: string) =>
    JSON.stringify([principal, HOOK_RUN_OPERATION, idempotencyKey]);

  return {
    delete: (principal, idempotencyKey) => entries.delete(scopedKey(principal, idempotencyKey)),
    get: (principal, idempotencyKey) => entries.get(scopedKey(principal, idempotencyKey)),
    has: (principal, idempotencyKey) => entries.has(scopedKey(principal, idempotencyKey)),
    set: (principal, idempotencyKey, entry) =>
      entries.set(scopedKey(principal, idempotencyKey), entry),
  };
}

const bureauErrorHttpStatus = {
  NOT_CONFIGURED: 503,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
} as const;

const httpErrorCode = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
} as const;

function bureauErrorReceipt(error: BureauError, requestId?: string): HookReceipt | undefined {
  const status = bureauErrorHttpStatus[error.code as keyof typeof bureauErrorHttpStatus];
  if (status === undefined) return undefined;
  return {
    status,
    body: {
      error: {
        code: httpErrorCode[status],
        message: error.message,
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}

function bureauErrorHttpException(error: BureauError): HTTPException | undefined {
  const status = bureauErrorHttpStatus[error.code as keyof typeof bureauErrorHttpStatus];
  return status === undefined ? undefined : new HTTPException(status, { message: error.message });
}

async function createRunReceipt(
  bureau: Bureau,
  request: CreateRunRequest,
  requestId?: string,
): Promise<HookReceipt> {
  try {
    return { status: 202, body: await bureau.createRun(request) };
  } catch (error) {
    if (error instanceof BureauError) {
      const receipt = bureauErrorReceipt(error, requestId);
      if (receipt) return receipt;
    }
    throw error;
  }
}

async function createRunWithoutIdempotency(bureau: Bureau, request: CreateRunRequest) {
  try {
    return await bureau.createRun(request);
  } catch (error) {
    if (error instanceof BureauError) {
      const exception = bureauErrorHttpException(error);
      if (exception) throw exception;
    }
    throw error;
  }
}

/**
 * Webhook ingress routes—typed dispatch endpoints.
 *
 * Callers MUST name the agent explicitly via the `?agent=<name>` query
 * parameter. No default-agent fallback, no binding table, no routing logic.
 *
 * Idempotency entries are scoped to the authenticated principal and the
 * `hooks:create-run` operation. Identical retries receive the original status
 * and body; materially different requests receive an `IDEMPOTENCY_CONFLICT`.
 * Entries remain for the lifetime of this process-local route instance, which
 * is at least as long as its process-local run locators. Neither idempotency
 * receipts nor run locators survive a restart or coordinate across instances.
 *
 * `POST /hooks/*`—fires a run synchronously and returns the run summary.
 * The session is named via the optional `?session=<id>` query parameter; omit
 * it for a fresh anonymous session.
 */
export function createHooksRoutes(
  bureau: Bureau,
  idempotencyRegistry = createHookIdempotencyRegistry(),
) {
  const app = new Hono();

  app.post('/*', async (context) => {
    const agentName = context.req.query('agent');
    if (!agentName || agentName.trim().length === 0) {
      throw new HTTPException(422, {
        message: 'Missing required query parameter: agent. Callers must name the agent explicitly.',
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await context.req.json<Record<string, unknown>>();
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    const message = body['message'];
    if (!message || typeof message !== 'string') {
      throw new HTTPException(400, { message: 'Request body must include a "message" string' });
    }

    const rawSessionId = context.req.query('session') ?? body['sessionId'];
    const sessionId =
      typeof rawSessionId === 'string' ? rawSessionId.trim() : (rawSessionId as string | undefined);
    const trimmedAgentName = agentName.trim();
    const principal = resolvePrincipal(context);
    const requestContext = resolveTrustedRequestContext(context, trimmedAgentName);
    const request: CreateRunRequest = {
      message,
      agentName: trimmedAgentName,
      principal,
      ...(requestContext ? { requestContext } : {}),
      ...(rawSessionId ? { sessionId } : {}),
      ...(typeof body['systemPrompt'] === 'string' ? { systemPrompt: body['systemPrompt'] } : {}),
      ...(typeof body['maximumSteps'] === 'number' ? { maximumSteps: body['maximumSteps'] } : {}),
    };

    const idempotencyKey = context.req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return context.json(await createRunWithoutIdempotency(bureau, request), 202);
    }

    const requestFingerprint = JSON.stringify(request);
    const existing = idempotencyRegistry.get(principal, idempotencyKey);
    let receiptPromise: Promise<HookReceipt>;
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        return context.json(
          {
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: `Idempotency key "${idempotencyKey}" was reused with a different canonical request.`,
            },
          },
          409,
        );
      }
      receiptPromise = existing.receipt;
    } else {
      // Reserve synchronously before starting the run. Identical concurrent
      // requests share this promise, so only one call reaches createRun.
      receiptPromise = createRunReceipt(
        bureau,
        request,
        context.get('requestId' as never) as string | undefined,
      );
      idempotencyRegistry.set(principal, idempotencyKey, {
        requestFingerprint,
        receipt: receiptPromise,
      });
      void receiptPromise.catch(() => idempotencyRegistry.delete(principal, idempotencyKey));
    }

    const receipt = await receiptPromise;
    return context.json(receipt.body, receipt.status);
  });

  return app;
}
