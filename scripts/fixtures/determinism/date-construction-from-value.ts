export function stampFrom(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
