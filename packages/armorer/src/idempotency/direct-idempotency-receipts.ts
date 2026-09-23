import type {
  IdempotencyResolutionReceipt,
  LegacyIdempotencyResolutionReceipt,
  StartedToolExecution,
} from './types';

export function hasLegacyReceiptFields(
  receipt: LegacyIdempotencyResolutionReceipt | undefined,
  cached: StartedToolExecution,
  key: string,
  tenantId: string,
  toolRevision: string,
): receipt is LegacyIdempotencyResolutionReceipt {
  return Boolean(
    receipt &&
    receipt.version === 1 &&
    receipt.key === key &&
    receipt.tenantId === tenantId &&
    receipt.toolRevision === toolRevision &&
    receipt.toolName === cached.toolName &&
    receipt.legacyStartedAt === cached.startedAt,
  );
}

export function hasReceiptFields(
  receipt: IdempotencyResolutionReceipt | undefined,
  cached: StartedToolExecution,
  inputDigest: string,
  key: string,
  tenantId: string,
  toolRevision: string,
): receipt is IdempotencyResolutionReceipt {
  return Boolean(
    receipt &&
    cached.inputDigest !== undefined &&
    receipt.inputDigest === cached.inputDigest &&
    receipt.inputDigest === inputDigest &&
    receipt.version === 1 &&
    receipt.key === key &&
    receipt.attemptId === cached.attemptId &&
    receipt.tenantId === tenantId &&
    receipt.toolRevision === toolRevision,
  );
}

export function hasRetryAuthorization(
  receipt: IdempotencyResolutionReceipt | LegacyIdempotencyResolutionReceipt,
): boolean {
  return Boolean(
    receipt.decision === 'retry' &&
    receipt.evidence &&
    receipt.authorizedAt !== undefined &&
    receipt.authorizedBy &&
    receipt.nonce &&
    receipt.authorization,
  );
}
