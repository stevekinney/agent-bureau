export interface LoopDetectionOptions {
  windowSize?: number;        // default 30
  warningThreshold?: number;  // default 10
  blockThreshold?: number;    // default 20
}

export interface LoopDetectionState {
  history: Array<{ toolName: string; argsHash: string; timestamp: number }>;
}

export type LoopDetectionResult =
  | { detected: false }
  | { detected: true; level: 'warning' | 'blocked'; detector: 'simple-repeat' | 'ping-pong'; count: number; message: string };

export function createLoopDetectionState(): LoopDetectionState {
  return { history: [] };
}

export function stableStringify(value: unknown): string {
  // Sort keys recursively for objects. Handle null, undefined, primitives.
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted.map(k => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

export function hashToolCall(toolName: string, args: unknown): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(toolName + ':' + stableStringify(args));
  return hasher.digest('hex') as string;
}

export function recordCall(
  state: LoopDetectionState,
  toolName: string,
  args: unknown,
  options?: LoopDetectionOptions,
): void {
  const windowSize = options?.windowSize ?? 30;
  const argsHash = hashToolCall(toolName, args);
  state.history.push({ toolName, argsHash, timestamp: Date.now() });
  // Trim to window size (FIFO - drop oldest)
  while (state.history.length > windowSize) {
    state.history.shift();
  }
}

export function detectLoop(
  state: LoopDetectionState,
  toolName: string,
  args: unknown,
  options?: LoopDetectionOptions,
): LoopDetectionResult {
  const warningThreshold = options?.warningThreshold ?? 10;
  const blockThreshold = options?.blockThreshold ?? 20;
  const hash = hashToolCall(toolName, args);

  if (state.history.length === 0) return { detected: false };

  // Simple repeat: count occurrences of this exact hash in history
  const count = state.history.filter(e => e.argsHash === hash).length;

  if (count >= blockThreshold) {
    return {
      detected: true,
      level: 'blocked',
      detector: 'simple-repeat',
      count,
      message: `Tool call loop detected: "${toolName}" called ${count} times with same arguments (blocked at threshold ${blockThreshold})`,
    };
  }
  if (count >= warningThreshold) {
    return {
      detected: true,
      level: 'warning',
      detector: 'simple-repeat',
      count,
      message: `Tool call loop warning: "${toolName}" called ${count} times with same arguments`,
    };
  }

  // Ping-pong: check if last N entries alternate between two distinct hashes
  if (state.history.length >= warningThreshold) {
    const recent = state.history.slice(-Math.max(warningThreshold, blockThreshold));
    if (recent.length >= 4) { // Need at least A,B,A,B
      const hashA = recent[recent.length - 1]!.argsHash;
      const hashB = recent[recent.length - 2]!.argsHash;
      if (hashA !== hashB) {
        // Count alternating from end
        let alternatingCount = 2;
        for (let i = recent.length - 3; i >= 0; i--) {
          const expected = (recent.length - 1 - i) % 2 === 0 ? hashA : hashB;
          if (recent[i]!.argsHash === expected) {
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
      }
    }
  }

  return { detected: false };
}

export function getLoopStatistics(state: LoopDetectionState): {
  totalCalls: number;
  uniquePatterns: number;
  mostFrequent: { hash: string; count: number } | null;
} {
  const counts = new Map<string, number>();
  for (const entry of state.history) {
    counts.set(entry.argsHash, (counts.get(entry.argsHash) ?? 0) + 1);
  }

  let mostFrequent: { hash: string; count: number } | null = null;
  for (const [hash, count] of counts) {
    if (!mostFrequent || count > mostFrequent.count) {
      mostFrequent = { hash, count };
    }
  }

  return {
    totalCalls: state.history.length,
    uniquePatterns: counts.size,
    mostFrequent,
  };
}
