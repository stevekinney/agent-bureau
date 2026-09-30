import type { PolicyPauseTier, SatisfiedPolicyPause, ToolAction } from '../types';

export const approvalResumeSymbol: unique symbol = Symbol('armorer.approvalResume');
export const approvalConsumeSymbol: unique symbol = Symbol('armorer.approvalConsume');
export const policyAuthorizationOnlySymbol: unique symbol = Symbol(
  'armorer.policyAuthorizationOnly',
);
/**
 * Carries a deduplicated call's recorded result into a policy-authorization-only execution, so the
 * settled event that execution emits reports the result the model receives instead of `undefined`.
 */
export const policyAuthorizationResultSymbol: unique symbol = Symbol(
  'armorer.policyAuthorizationResult',
);
export const executionCallbackStartSymbol: unique symbol = Symbol('armorer.executionCallbackStart');
export const policyPauseDecisionsSymbol: unique symbol = Symbol('armorer.policyPauseDecisions');
export const policyPauseTierSymbol: unique symbol = Symbol('armorer.policyPauseTier');

export type ApprovalAdmissionRollback = () => Promise<void>;

export type ApprovalResumeState = {
  approvedAction: ToolAction;
  approvedPolicyPauseTier?: PolicyPauseTier;
  proposedArguments: unknown;
  reason?: string;
  satisfiedPauses: readonly SatisfiedPolicyPause[];
};
