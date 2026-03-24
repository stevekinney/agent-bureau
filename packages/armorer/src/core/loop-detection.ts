import { createHash } from 'node:crypto';

export interface LoopDetectionOptions {
  /** Number of consecutive alternating calls to consider a ping-pong loop. Default: 10 */
  pingPongThreshold?: number;
  /** Number of identical consecutive calls to consider a repetition loop. Default: 10 */
  repetitionThreshold?: number;
  /** Maximum number of calls to keep in the detection window. Default: 100 */
  maxWindowSize?: number;
  /** Custom hash function for tool calls. Default: SHA256 of tool name + arguments. */
  hashFunction?: (toolName: string, args: unknown) => string;

  /**
   * Threshold at which a 'warning' level is emitted (for level-based detection).
   * When set, `level` and `detector` fields are populated on the result.
   */
  warningThreshold?: number;
  /**
   * Threshold at which a 'blocked' level is emitted (for level-based detection).
   * When set, `level` and `detector` fields are populated on the result.
   */
  blockThreshold?: number;
}

export interface LoopDetectionResult {
  /** Whether a loop was detected */
  detected: boolean;
  /** Description of the detected loop, empty string if none detected */
  message: string;
  /** Count of how many calls triggered the loop detection */
  count: number;
  /** Severity level of the loop detection (only present when warningThreshold/blockThreshold are set) */
  level?: 'warning' | 'blocked';
  /** Which detector pattern matched (only present when warningThreshold/blockThreshold are set) */
  detector?: 'simple-repeat' | 'ping-pong';
}

export interface LoopStatistics {
  /** Total number of calls tracked */
  callCount: number;
  /** Map of hash -> count for each unique call */
  hashCounts: Record<string, number>;
}

interface InternalLoopDetectorState {
  callWindow: string[];
  hashCounts: Map<string, number>;
  totalCalls: number;
}

/**
 * Detects execution loops in tool calls:
 * - Ping-pong loops: alternating between two different calls (A->B->A->B)
 * - Repetition loops: same call repeated consecutively
 *
 * Supports two modes:
 * 1. Classic mode: uses `pingPongThreshold` and `repetitionThreshold`
 * 2. Level mode: uses `warningThreshold` and `blockThreshold` to report `level` and `detector`
 *
 * Created per toolbox instance, shared across all execute() calls.
 */
export class LoopDetector {
  private readonly pingPongThreshold: number;
  private readonly repetitionThreshold: number;
  private readonly maxWindowSize: number;
  private readonly hashFunction: (toolName: string, args: unknown) => string;
  private readonly state: InternalLoopDetectorState;
  private readonly warningThreshold: number | undefined;
  private readonly blockThreshold: number | undefined;
  private readonly levelMode: boolean;

  constructor(options: LoopDetectionOptions = {}) {
    this.warningThreshold = options.warningThreshold;
    this.blockThreshold = options.blockThreshold;
    this.levelMode = options.warningThreshold !== undefined || options.blockThreshold !== undefined;

    // In level mode, derive classic thresholds from warning/block thresholds
    if (this.levelMode) {
      this.repetitionThreshold = options.warningThreshold ?? 10;
      this.pingPongThreshold = options.warningThreshold ?? 10;
    } else {
      this.pingPongThreshold = options.pingPongThreshold ?? 10;
      this.repetitionThreshold = options.repetitionThreshold ?? 10;
    }

    this.maxWindowSize = options.maxWindowSize ?? 100;
    this.hashFunction = options.hashFunction ?? this.defaultHashFunction;
    this.state = {
      callWindow: [],
      hashCounts: new Map(),
      totalCalls: 0,
    };
  }

  /**
   * Default hash function: SHA256 of tool name + stringified arguments.
   * Omits undefined keys (like JSON.stringify).
   */
  private defaultHashFunction = (toolName: string, args: unknown): string => {
    const stringified = stableStringify(args);
    const combined = `${toolName}:${stringified}`;
    return createHash('sha256').update(combined).digest('hex');
  };

  /**
   * Record a tool call.
   * Called by the toolbox on every execute() call.
   */
  public recordCall(toolName: string, args: unknown): void {
    const hash = this.hashFunction(toolName, args);

    // Record in window
    this.state.callWindow.push(hash);
    this.state.totalCalls += 1;

    // Update hash counts
    const count = this.state.hashCounts.get(hash) ?? 0;
    this.state.hashCounts.set(hash, count + 1);

    // Trim window if needed (FIFO: drop from front)
    if (this.state.callWindow.length > this.maxWindowSize) {
      const removed = this.state.callWindow.shift()!;
      // Also decrement the hash count
      const removedCount = this.state.hashCounts.get(removed) ?? 1;
      if (removedCount <= 1) {
        this.state.hashCounts.delete(removed);
      } else {
        this.state.hashCounts.set(removed, removedCount - 1);
      }
    }
  }

  /**
   * Detect if a loop is currently happening.
   */
  public detectLoop(): LoopDetectionResult {
    const window = this.state.callWindow;

    if (window.length === 0) {
      return { detected: false, message: '', count: 0 };
    }

    if (this.levelMode) {
      return this.detectWithLevels(window);
    }

    // Classic mode: check ping-pong first, then repetition
    const pingPongResult = this.detectPingPong(window);
    if (pingPongResult) {
      return pingPongResult;
    }

    const repetitionResult = this.detectRepetition(window);
    if (repetitionResult) {
      return repetitionResult;
    }

    return { detected: false, message: '', count: 0 };
  }

  /**
   * Level-based detection: uses warningThreshold/blockThreshold to report
   * `level` ('warning' | 'blocked') and `detector` ('simple-repeat' | 'ping-pong').
   */
  private detectWithLevels(window: string[]): LoopDetectionResult {
    const warningThreshold = this.warningThreshold ?? 10;
    const blockThreshold = this.blockThreshold ?? 20;

    // Check simple repetition: count occurrences of each hash
    for (const [, count] of this.state.hashCounts) {
      if (count >= blockThreshold) {
        return {
          detected: true,
          level: 'blocked',
          detector: 'simple-repeat',
          count,
          message: `Tool call loop detected: repeated ${count} times with same arguments (blocked at threshold ${blockThreshold})`,
        };
      }
      if (count >= warningThreshold) {
        // Check ping-pong first at block level before returning simple-repeat warning
        const pingPong = this.detectPingPongWithLevels(window, warningThreshold, blockThreshold);
        if (pingPong) return pingPong;

        return {
          detected: true,
          level: 'warning',
          detector: 'simple-repeat',
          count,
          message: `Tool call loop warning: repeated ${count} times with same arguments`,
        };
      }
    }

    // Check ping-pong
    const pingPong = this.detectPingPongWithLevels(window, warningThreshold, blockThreshold);
    if (pingPong) return pingPong;

    return { detected: false, message: '', count: 0 };
  }

  /**
   * Detect ping-pong pattern with level semantics.
   */
  private detectPingPongWithLevels(
    window: string[],
    warningThreshold: number,
    blockThreshold: number,
  ): LoopDetectionResult | null {
    if (window.length < 4) return null;

    // Check alternating from the end of the window
    const hashA = window[window.length - 1]!;
    const hashB = window[window.length - 2]!;
    if (hashA === hashB) return null;

    let alternatingCount = 2;
    for (let i = window.length - 3; i >= 0; i--) {
      const expected = (window.length - 1 - i) % 2 === 0 ? hashA : hashB;
      if (window[i] === expected) {
        alternatingCount++;
      } else {
        break;
      }
    }

    if (alternatingCount >= blockThreshold) {
      return {
        detected: true,
        level: 'blocked',
        detector: 'ping-pong',
        count: alternatingCount,
        message: `Ping-pong loop detected: alternating between two tool calls ${alternatingCount} times (blocked at threshold ${blockThreshold})`,
      };
    }
    if (alternatingCount >= warningThreshold) {
      return {
        detected: true,
        level: 'warning',
        detector: 'ping-pong',
        count: alternatingCount,
        message: `Ping-pong loop warning: alternating between two tool calls ${alternatingCount} times`,
      };
    }

    return null;
  }

  /**
   * Detect alternating patterns like A,B,A,B,...
   * Counts consecutive "different from previous" occurrences.
   * For threshold N, needs at least N+1 calls with the first N-1 being different from their neighbors.
   */
  private detectPingPong(window: string[]): LoopDetectionResult | null {
    if (window.length < this.pingPongThreshold + 1) {
      return null;
    }

    // Count how many calls are different from their immediate predecessor
    // This counts the alternations in the pattern
    let differentCount = 0;
    for (let i = 1; i < window.length; i++) {
      if (window[i] !== window[i - 1]) {
        differentCount += 1;
      }
    }

    // Detect ping-pong if we have enough alternations: need 2*(threshold-1) differences
    const requiredDifferences = 2 * (this.pingPongThreshold - 1);
    if (differentCount >= requiredDifferences && requiredDifferences > 0) {
      return {
        detected: true,
        message: `Detected ping-pong loop: alternating between 2 calls with ${differentCount} alternations`,
        count: this.pingPongThreshold,
      };
    }

    return null;
  }

  /**
   * Detect repeated identical calls.
   */
  private detectRepetition(window: string[]): LoopDetectionResult | null {
    if (window.length < this.repetitionThreshold) {
      return null;
    }

    // Look at the last N items
    const recentWindow = window.slice(-this.repetitionThreshold);

    // Check if all items are the same
    const first = recentWindow[0];
    const allSame = recentWindow.every((hash) => hash === first);

    if (allSame) {
      return {
        detected: true,
        message: `Detected repeated loop: same call executed ${this.repetitionThreshold} times consecutively`,
        count: this.repetitionThreshold,
      };
    }

    return null;
  }

  /**
   * Get statistics about loop detection state.
   */
  public getLoopStatistics(): LoopStatistics {
    const hashCounts: Record<string, number> = {};
    this.state.hashCounts.forEach((count, hash) => {
      hashCounts[hash] = count;
    });

    return {
      callCount: this.state.totalCalls,
      hashCounts,
    };
  }
}

/**
 * Stable stringify: produces consistent JSON-like output for objects.
 * Recursively sorts object keys so that key order does not affect the result.
 * Similar to JSON.stringify but omits undefined values (same behavior as JSON.stringify).
 * Does NOT preserve function values, BigInt, circular refs, or symbols.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    sorted
      .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
