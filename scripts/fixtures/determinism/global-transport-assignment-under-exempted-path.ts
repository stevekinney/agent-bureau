export function installFetchFake(fake: typeof fetch): void {
  globalThis.fetch = fake;
}
