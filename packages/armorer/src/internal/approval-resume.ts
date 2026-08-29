import type { PolicyPauseTier, SatisfiedPolicyPause, ToolAction } from '../types';

export const approvalResumeSymbol: unique symbol = Symbol('armorer.approvalResume');
export const approvalConsumeSymbol: unique symbol = Symbol('armorer.approvalConsume');
export const policyAuthorizationOnlySymbol: unique symbol = Symbol(
  'armorer.policyAuthorizationOnly',
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
