import type { MessageRole } from '../types';

/**
 * Maps message roles to human-readable display labels.
 *
 * @example
 * ```ts
 * ROLE_LABELS['tool-call']; // 'Tool Call'
 * ROLE_LABELS.assistant;   // 'Assistant'
 * ```
 */
export const ROLE_LABELS: Record<MessageRole, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  'tool-call': 'Tool Call',
  'tool-result': 'Tool Result',
  snapshot: 'Snapshot',
};

/**
 * Maps display labels back to message roles.
 *
 * @example
 * ```ts
 * LABEL_TO_ROLE['Tool Call']; // 'tool-call'
 * LABEL_TO_ROLE.User;        // 'user'
 * ```
 */
export const LABEL_TO_ROLE: Record<string, MessageRole> = {
  User: 'user',
  Assistant: 'assistant',
  System: 'system',
  Developer: 'developer',
  'Tool Use': 'tool-call',
  'Tool Call': 'tool-call',
  'Tool Result': 'tool-result',
  Snapshot: 'snapshot',
};

/**
 * Gets the human-readable display label for a message role.
 *
 * @param role - The message role
 * @returns The display label for the role
 *
 * @example
 * ```ts
 * getRoleLabel('assistant');  // 'Assistant'
 * getRoleLabel('tool-call');  // 'Tool Call'
 * ```
 */
export function getRoleLabel(role: MessageRole): string {
  return ROLE_LABELS[role];
}

/**
 * Gets the message role from a display label.
 *
 * @param label - The display label
 * @returns The message role, or undefined if the label is not recognized
 *
 * @example
 * ```ts
 * getRoleFromLabel('Assistant');  // 'assistant'
 * getRoleFromLabel('Tool Call');  // 'tool-call'
 * getRoleFromLabel('Unknown');    // undefined
 * ```
 */
export function getRoleFromLabel(label: string): MessageRole | undefined {
  return Object.hasOwn(LABEL_TO_ROLE, label) ? LABEL_TO_ROLE[label] : undefined;
}
