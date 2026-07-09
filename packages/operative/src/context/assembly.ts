/**
 * Context assembly for building the message window sent to the model.
 *
 * The assembler applies budget ratios to decide how many tokens each slice
 * (system, history, retrieved) may consume, then trims messages to fit.
 */

import type { Message } from 'conversationalist';

import { getPendingToolCallIds } from './pending-tool-calls';
import type { AssemblyOptions, AssemblyResult, BudgetReport, ContextAssembler } from './types';

/** Default token estimator: roughly 4 characters per token. */
const defaultEstimator = (text: string): number => Math.ceil(text.length / 4);

/**
 * Estimates the token count for a single message using the provided estimator.
 */
function estimateMessageTokens(message: Message, estimator: (text: string) => number): number {
  const content = typeof message.content === 'string' ? message.content : '';
  let tokens = estimator(content);

  if (message.toolCall) {
    tokens += estimator(
      JSON.stringify({ name: message.toolCall.name, arguments: message.toolCall.arguments }),
    );
  }
  if (message.toolResult) {
    const resultContent =
      typeof message.toolResult.content === 'string'
        ? message.toolResult.content
        : JSON.stringify(message.toolResult.content);
    tokens += estimator(resultContent);
  }

  return tokens;
}

/**
 * Creates a context assembler that partitions the conversation into budget
 * slices (system, history, retrieved) and returns the assembled messages
 * with an accurate budget report.
 *
 * Guarantees:
 * - System messages are always included (up to the system budget).
 * - The most recent N non-system messages are always included.
 * - Messages with pending tool results are always included.
 * - Hidden messages are excluded.
 * - A budget report is returned with per-slice token counts.
 */
export function createContextAssembler(): ContextAssembler {
  return (options: AssemblyOptions): AssemblyResult => {
    const {
      conversation,
      budget,
      recentMessageCount = 4,
      systemBudgetRatio = 0.25,
      historyBudgetRatio = 0.6,
      retrievedBudgetRatio = 0.15,
      retrievedMessages = [],
      tokenEstimator = budget.estimate?.bind(budget) ?? defaultEstimator,
      stablePrefix = false,
      pinnedMessages = [],
    } = options;

    const allMessages = conversation.getMessages();

    // Filter out hidden messages
    const visibleMessages = allMessages.filter((m) => !m.hidden);

    if (
      visibleMessages.length === 0 &&
      retrievedMessages.length === 0 &&
      pinnedMessages.length === 0
    ) {
      return {
        messages: [],
        budgetReport: {
          systemTokens: 0,
          historyTokens: 0,
          retrievedTokens: 0,
          totalTokens: 0,
          remainingTokens: budget.maxTokens,
        },
      };
    }

    // Calculate per-slice budgets. Clamp the total ratio to 1.0 to prevent
    // over-allocation when user-supplied ratios exceed the available budget.
    const totalRatio = systemBudgetRatio + historyBudgetRatio + retrievedBudgetRatio;
    const scale = totalRatio > 1 ? 1 / totalRatio : 1;
    const allocatable = budget.allocate();
    const systemBudget = Math.floor(allocatable * systemBudgetRatio * scale);
    const historyBudget = Math.floor(allocatable * historyBudgetRatio * scale);
    const retrievedBudget = Math.floor(allocatable * retrievedBudgetRatio * scale);

    // Partition messages
    const systemMessages = visibleMessages.filter((m) => m.role === 'system');
    const nonSystem = visibleMessages.filter((m) => m.role !== 'system');

    // Identify messages that MUST be included
    const pendingCallIds = getPendingToolCallIds(visibleMessages);
    const mustIncludeIds = new Set<string>();

    // Pending tool calls are mandatory
    for (const message of visibleMessages) {
      if (
        message.role === 'tool-call' &&
        message.toolCall &&
        pendingCallIds.has(message.toolCall.id)
      ) {
        mustIncludeIds.add(message.id);
      }
    }

    // Recent messages are mandatory
    const recentMessages = nonSystem.slice(-recentMessageCount);
    for (const m of recentMessages) {
      mustIncludeIds.add(m.id);
    }

    // Assemble system messages. In stable-prefix mode the system prompt is
    // never budget-truncated — a stable prefix that could silently drop its
    // own instructions on a token squeeze is not actually stable, it's
    // unreliable. Default mode keeps the original budget-capped behavior.
    const assembledSystem: Message[] = [];
    let systemTokens = 0;
    for (const msg of systemMessages) {
      const tokens = estimateMessageTokens(msg, tokenEstimator);
      if (stablePrefix || systemTokens + tokens <= systemBudget || assembledSystem.length === 0) {
        assembledSystem.push(msg);
        systemTokens += tokens;
      }
    }

    // In stable-prefix mode, pinned messages are always included in full,
    // verbatim and in order, immediately after system messages. Their tokens
    // are folded into the system budget slice of the report.
    const assembledPinned: Message[] = [];
    if (stablePrefix) {
      for (const msg of pinnedMessages) {
        if (msg.hidden) continue;
        assembledPinned.push(msg);
        systemTokens += estimateMessageTokens(msg, tokenEstimator);
      }
    }

    // The stable prefix is system messages + pinned messages, in that order.
    // Everything else (retrieved, history) is assembled and appended after
    // it, unaffected by stable-prefix mode. Mark the LAST message of the
    // stable prefix with `cacheBoundary: true` — a shallow copy, so the
    // underlying conversation is never mutated — so a provider adapter can
    // lower it to a native prompt-cache checkpoint (e.g. Anthropic's
    // `cache_control`). Only meaningful when the prefix is non-empty.
    const stableFront: Message[] = [...assembledSystem, ...assembledPinned];
    if (stablePrefix && stableFront.length > 0) {
      const lastIndex = stableFront.length - 1;
      const boundaryMessage = stableFront[lastIndex];
      if (boundaryMessage) {
        stableFront[lastIndex] = { ...boundaryMessage, cacheBoundary: true };
      }
    }

    // Assemble history messages within budget
    // Start with mandatory messages, then fill with older history
    const assembledHistory: Message[] = [];
    const includedIds = new Set<string>(assembledSystem.map((m) => m.id));
    let historyTokens = 0;

    // First, include all mandatory non-system messages
    for (const msg of nonSystem) {
      if (mustIncludeIds.has(msg.id)) {
        assembledHistory.push(msg);
        includedIds.add(msg.id);
        historyTokens += estimateMessageTokens(msg, tokenEstimator);
      }
    }

    // Then fill with remaining history from oldest to newest (up to budget)
    for (const msg of nonSystem) {
      if (includedIds.has(msg.id)) continue;
      const tokens = estimateMessageTokens(msg, tokenEstimator);
      if (historyTokens + tokens <= historyBudget) {
        assembledHistory.push(msg);
        includedIds.add(msg.id);
        historyTokens += tokens;
      }
    }

    // Sort history by position to maintain conversation order
    assembledHistory.sort((a, b) => a.position - b.position);

    // Assemble retrieved messages within budget
    const assembledRetrieved: Message[] = [];
    let retrievedTokens = 0;
    for (const msg of retrievedMessages) {
      if (msg.hidden) continue;
      const tokens = estimateMessageTokens(msg, tokenEstimator);
      if (retrievedTokens + tokens <= retrievedBudget) {
        assembledRetrieved.push(msg);
        retrievedTokens += tokens;
      }
    }

    // Combine all assembled messages in order: stable prefix (system, then
    // pinned in stable-prefix mode) first, then retrieved (injected before
    // history), then history.
    const combined: Message[] = [...stableFront, ...assembledRetrieved, ...assembledHistory];

    const totalTokens = systemTokens + historyTokens + retrievedTokens;

    const budgetReport: BudgetReport = {
      systemTokens,
      historyTokens,
      retrievedTokens,
      totalTokens,
      remainingTokens: budget.maxTokens - totalTokens,
    };

    return { messages: combined, budgetReport };
  };
}
