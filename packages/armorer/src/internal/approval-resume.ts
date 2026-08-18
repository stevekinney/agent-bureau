import type { PolicyPauseTier, SatisfiedPolicyPause, ToolAction } from '../types';

export const approvalResumeSymbol: unique symbol = Symbol('armorer.approvalResume');
export const policyPauseDecisionsSymbol: unique symbol = Symbol('armorer.policyPauseDecisions');
export const policyPauseTierSymbol: unique symbol = Symbol('armorer.policyPauseTier');

export type ApprovalResumeState = {
  approvedAction: ToolAction;
  approvedPolicyPauseTier?: PolicyPauseTier;
  proposedArguments: unknown;
  reason?: string;
  satisfiedPauses: readonly SatisfiedPolicyPause[];
};
