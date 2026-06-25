import type { GenerateContext } from '../../types.ts';
import type { ComplexitySignals, ModelRoute, RoutingDecision, RoutingStrategy } from '../types.ts';

/**
 * Options for the complexity-based routing strategy.
 */
export type ComplexityStrategyOptions = {
  /** Route name for simple tasks. */
  simple: string;
  /** Route name for complex tasks. */
  complex: string;
  /** Route name for frontier-level tasks. Defaults to `complex` when omitted. */
  frontier?: string;
  /** Custom scorer that overrides the default heuristic. */
  scorer?: (signals: ComplexitySignals) => 'simple' | 'complex' | 'frontier';
};

/** Patterns that indicate code content in a message. */
const CODE_PATTERNS = [
  /`[^`]+`/, // inline code
  /```/, // code fences
  /function\s+\w+\s*\(/, // function declarations
  /=>\s*[{(]/, // arrow functions
  /\bconst\s+\w+\s*=/, // const declarations
  /\blet\s+\w+\s*=/, // let declarations
  /\bvar\s+\w+\s*=/, // var declarations
  /\bclass\s+\w+/, // class declarations
  /\bimport\s+/, // import statements
  /\bexport\s+/, // export statements
];

/**
 * Extracts complexity signals from a GenerateContext for use by scoring heuristics.
 */
export function extractComplexitySignals(context: GenerateContext): ComplexitySignals {
  const history = context.conversation.current;
  const ids: readonly string[] = history.ids ?? [];
  const messages: Readonly<Record<string, { role: string; content: unknown }>> =
    history.messages ?? {};

  const messageCount = ids.length;
  const toolCount = context.toolbox.tools().length;
  const conversationDepth = context.step;

  // Get last message content
  let lastMessageLength = 0;
  let hasCodeContent = false;
  let lastMessageContent = '';

  if (ids.length > 0) {
    const lastId = ids[ids.length - 1]!;
    const lastMessage = messages[lastId];
    if (lastMessage && typeof lastMessage.content === 'string') {
      lastMessageContent = lastMessage.content;
      lastMessageLength = lastMessageContent.length;
    }
  }

  if (lastMessageContent) {
    hasCodeContent = CODE_PATTERNS.some((pattern) => pattern.test(lastMessageContent));
  }

  // Count pending tool results: tool-result messages at the end without a subsequent assistant message
  let pendingToolResults = 0;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    const message = messages[id];
    if (!message) break;

    if (message.role === 'tool-result') {
      pendingToolResults++;
    } else if (message.role === 'assistant') {
      break;
    } else {
      // Other roles (user, system, etc.) — stop counting
      break;
    }
  }

  return {
    messageCount,
    toolCount,
    lastMessageLength,
    hasCodeContent,
    conversationDepth,
    pendingToolResults,
  };
}

/**
 * Default scoring heuristic for complexity classification.
 *
 * - Simple: toolCount < 3 AND lastMessageLength < 500 AND !hasCodeContent AND conversationDepth < 5
 * - Frontier: toolCount > 10 OR lastMessageLength > 2000 OR conversationDepth > 20
 * - Complex: everything else
 */
function defaultScorer(signals: ComplexitySignals): 'simple' | 'complex' | 'frontier' {
  // Check frontier first (most demanding)
  if (
    signals.toolCount > 10 ||
    signals.lastMessageLength > 2000 ||
    signals.conversationDepth > 20
  ) {
    return 'frontier';
  }

  // Check simple (least demanding)
  if (
    signals.toolCount < 3 &&
    signals.lastMessageLength < 500 &&
    !signals.hasCodeContent &&
    signals.conversationDepth < 5
  ) {
    return 'simple';
  }

  return 'complex';
}

/**
 * Creates a routing strategy that classifies tasks by complexity and routes
 * them to appropriately capable (and priced) models.
 *
 * Simple tasks go to cheap/fast models, complex tasks to more capable ones,
 * and frontier tasks to the most powerful available model.
 */
export function createComplexityStrategy(options: ComplexityStrategyOptions): RoutingStrategy {
  const { simple, complex, frontier, scorer } = options;
  const resolvedFrontier = frontier ?? complex;
  const score = scorer ?? defaultScorer;

  return (context: GenerateContext, _routes: readonly ModelRoute[]): RoutingDecision => {
    const signals = extractComplexitySignals(context);
    const tier = score(signals);

    const routeMap: Record<string, string> = {
      simple,
      complex,
      frontier: resolvedFrontier,
    };

    return {
      route: routeMap[tier]!,
      reason: `Complexity classified as ${tier}`,
    };
  };
}
