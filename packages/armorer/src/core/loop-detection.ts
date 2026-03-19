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
}

export interface LoopDetectionResult {
  /** Whether a loop was detected */
  detected: boolean;
  /** Description of the detected loop, empty string if none detected */
  message: string;
  /** Count of how many calls triggered the loop detection */
  count: number;
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
 * - Ping-pong loops: alternating between two different calls (A→B→A→B)
 * - Repetition loops: same call repeated consecutively
 *
 * Created per toolbox instance, shared across all execute() calls.
 */
export class LoopDetector {
  private readonly pingPongThreshold: number;
  private readonly repetitionThreshold: number;
  private readonly maxWindowSize: number;
  private readonly hashFunction: (toolName: string, args: unknown) => string;
  private readonly state: InternalLoopDetectorState;

  constructor(options: LoopDetectionOptions = {}) {
    this.pingPongThreshold = options.pingPongThreshold ?? 10;
    this.repetitionThreshold = options.repetitionThreshold ?? 10;
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

    // Check for ping-pong loop: alternating pattern (A,B,A,B,...)
    const pingPongResult = this.detectPingPong(window);
    if (pingPongResult) {
      return pingPongResult;
    }

    // Check for repetition loop: same hash repeated
    const repetitionResult = this.detectRepetition(window);
    if (repetitionResult) {
      return repetitionResult;
    }

    return { detected: false, message: '', count: 0 };
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
 * Similar to JSON.stringify but omits undefined values (same behavior as JSON.stringify).
 * Does NOT preserve function values, BigInt, circular refs, or symbols.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}
