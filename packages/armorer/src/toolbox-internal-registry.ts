import type { InternalToolboxOptions } from './toolbox-approval-contracts';
import type { SerializedToolbox, ToolboxOptions } from './toolbox-contracts';

/**
 * Keeps resolved private toolbox options keyed by the stable `toJSON` method.
 * A WeakMap avoids exposing approval secrets through the public toolbox, and
 * the method key survives transparent Proxy wrappers used by consumers.
 */
export const internalToolboxOptionsRegistry = new WeakMap<
  () => SerializedToolbox,
  InternalToolboxOptions
>();

export function registerInternalToolboxOptions(
  toJSON: () => SerializedToolbox,
  values: {
    registryPolicy: ToolboxOptions['policy'];
    registryPolicyContext: ToolboxOptions['policyContext'];
    approvalPolicy: ToolboxOptions['approvalPolicy'];
    approvalSecret: ToolboxOptions['approvalSecret'];
    approvalStateStore: ToolboxOptions['approvalStateStore'];
    grantStateStore: ToolboxOptions['grantStateStore'];
    approvalBindingTtlMs: number;
    approvalNow: NonNullable<ToolboxOptions['approvalNow']>;
    approvalNonce: NonNullable<ToolboxOptions['approvalNonce']>;
    policyRevision: string;
    approvalRevision: string;
    toolboxRevision: string;
    readOnly: boolean;
    allowMutation: boolean;
    allowDangerous: boolean;
  },
): void {
  const internalOptions = {
    approvalBindingTtlMs: values.approvalBindingTtlMs,
    approvalNow: values.approvalNow,
    approvalNonce: values.approvalNonce,
    policyRevision: values.policyRevision,
    approvalRevision: values.approvalRevision,
    toolboxRevision: values.toolboxRevision,
    readOnly: values.readOnly,
    allowMutation: values.allowMutation,
    allowDangerous: values.allowDangerous,
    ...(values.registryPolicy ? { policy: values.registryPolicy } : {}),
    ...(values.registryPolicyContext ? { policyContext: values.registryPolicyContext } : {}),
    ...(values.approvalPolicy ? { approvalPolicy: values.approvalPolicy } : {}),
    ...(values.approvalSecret ? { approvalSecret: values.approvalSecret } : {}),
    ...(values.approvalStateStore ? { approvalStateStore: values.approvalStateStore } : {}),
    ...(values.grantStateStore ? { grantStateStore: values.grantStateStore } : {}),
  };
  internalToolboxOptionsRegistry.set(toJSON, internalOptions);
}
