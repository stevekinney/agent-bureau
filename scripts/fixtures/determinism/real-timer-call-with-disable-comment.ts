export function scheduleRetry(callback: () => void): void {
  // eslint-disable-next-line determinism/no-real-runtime-call -- this must NOT suppress the report
  setTimeout(callback, 50);
}
