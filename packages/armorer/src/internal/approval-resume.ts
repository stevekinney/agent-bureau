import type { SatisfiedPolicyPause, ToolAction } from '../types';

export const approvalResumeSymbol: unique symbol = Symbol('armorer.approvalResume');
export const policyPauseDecisionsSymbol: unique symbol = Symbol('armorer.policyPauseDecisions');

export type ApprovalResumeState = {
  approvedAction: ToolAction;
  proposedArguments: unknown;
  reason?: string;
  satisfiedPauses: readonly SatisfiedPolicyPause[];
};
