import type { Tool } from './is-tool';

export async function isToolAvailable(
  tool: Tool,
  baseContext: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean | 'timeout' | 'cancelled'> {
  const availability = tool.configuration.availability ?? tool.availability;
  if (!availability) return true;
  try {
    if (!signal) return await availability(baseContext);
    if (signal.aborted) return 'cancelled';
    return await new Promise<boolean | 'timeout' | 'cancelled'>((resolve) => {
      let settled = false;
      const finish = (result: boolean | 'timeout' | 'cancelled') => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve(availability(baseContext)).then(
        (result) => finish(result),
        () => finish(false),
      );
    });
  } catch {
    return false;
  }
}
