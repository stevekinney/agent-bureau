import type { ToolAction } from '../types';

export const approvalResumeSymbol: unique symbol = Symbol('armorer.approvalResume');

export type ApprovalResumeState = {
  approvedAction: ToolAction;
  proposedArguments: unknown;
};
