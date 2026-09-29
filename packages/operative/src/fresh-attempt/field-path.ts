/** Formats a path such as `['knownFailures', 0, 'summary']` as `knownFailures[0].summary`. */
export function formatFieldPath(segments: readonly PropertyKey[]): string {
  let path = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      path += `[${segment}]`;
    } else {
      path += path === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return path;
}

/** Reads the value at `segments` inside `root`, or `undefined` when any step is absent. */
export function valueAtFieldPath(root: unknown, segments: readonly PropertyKey[]): unknown {
  let current = root;
  for (const segment of segments) {
    current =
      typeof current === 'object' && current !== null
        ? (current as Record<PropertyKey, unknown>)[segment]
        : undefined;
  }
  return current;
}
