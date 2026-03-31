import { Conversation } from 'conversationalist';

import type { GenerateContext } from '../types';
import type { RetryMutator } from './types';

interface ValidationIssue {
  path?: ReadonlyArray<string | number>;
  message?: string;
  code?: string;
}

function isValidationError(error: unknown): error is Error & { issues?: ValidationIssue[] } {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ZodError') return true;

  return 'issues' in error && Array.isArray((error as { issues: unknown }).issues);
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.length ? issue.path.join('.') : '(root)';
      return `- ${path}: ${issue.message ?? 'validation failed'}`;
    })
    .join('\n');
}

/**
 * Creates a retry mutator that injects schema validation errors into
 * the conversation as a user message.
 *
 * When the error has an `issues` property (Zod-like) or a `ZodError`
 * name, the mutator formats the validation failures and appends them
 * so the model can correct its output on the next attempt.
 */
export function createSchemaErrorMutator(): RetryMutator {
  return (context: GenerateContext, error: unknown, _attempt: number) => {
    if (!isValidationError(error)) return;

    const issues = (error as { issues?: ValidationIssue[] }).issues;
    const issueDetails = issues?.length ? `\n\nValidation issues:\n${formatIssues(issues)}` : '';

    const message = `Your previous response failed schema validation: ${error.message}${issueDetails}\n\nPlease correct your response to match the required schema.`;

    // Create a new conversation with the error feedback appended
    const snapshot = context.conversation.getSnapshot();
    const newConversation = new Conversation(snapshot);
    newConversation.appendUserMessage(message);

    return {
      ...context,
      conversation: newConversation,
    };
  };
}
