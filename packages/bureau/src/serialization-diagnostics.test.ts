import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { resolveDiagnosticSink } from './serialization';
import type { BureauDiagnostic } from './types';

const restorations: Array<() => void> = [];
function spyOnConsole(level: 'error' | 'warn') {
  const spy = spyOn(console, level).mockImplementation(() => {});
  restorations.push(() => spy.mockRestore());
  return spy;
}
afterEach(() => {
  for (const restore of restorations.splice(0)) restore();
});

describe('resolveDiagnosticSink', () => {
  it('with no sink supplied, writes to console.error/console.warn — unchanged default behavior', () => {
    const errorSpy = spyOnConsole('error');
    const warnSpy = spyOnConsole('warn');
    const diagnose = resolveDiagnosticSink(undefined);

    diagnose({ level: 'error', scope: 'recovery', message: 'boom', cause: new Error('cause') });
    diagnose({ level: 'warn', scope: 'recovery', message: 'careful' });

    expect(errorSpy).toHaveBeenCalledWith('boom', expect.any(Error));
    expect(warnSpy).toHaveBeenCalledWith('careful');
  });

  it('with a sink supplied, routes diagnostics to it instead of the console', () => {
    const errorSpy = spyOnConsole('error');
    const warnSpy = spyOnConsole('warn');
    const received: BureauDiagnostic[] = [];
    const diagnose = resolveDiagnosticSink((diagnostic) => received.push(diagnostic));

    diagnose({ level: 'error', scope: 'webhook', message: 'delivery failed' });

    expect(received).toEqual([{ level: 'error', scope: 'webhook', message: 'delivery failed' }]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the console for a diagnostic whose sink throws, without crashing', () => {
    const errorSpy = spyOnConsole('error');
    const diagnose = resolveDiagnosticSink(() => {
      throw new Error('a misbehaving sink');
    });

    expect(() =>
      diagnose({ level: 'error', scope: 'dispose', message: 'teardown failed' }),
    ).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('teardown failed');
  });
});
