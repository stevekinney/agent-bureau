export function scheduleRetry(callback: () => void): void {
  setTimeout(callback, 50);
}
