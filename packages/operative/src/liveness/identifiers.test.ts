import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { createDefaultRunIdentifierSeam, defaultRunIdentifierSeam } from './identifiers';

describe('createDefaultRunIdentifierSeam', () => {
  it('mints a distinct id on every call', () => {
    const seam = createDefaultRunIdentifierSeam();
    const first = seam.next();
    const second = seam.next();

    expect(first).not.toBe(second);
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(0);
  });

  it('mints ids independently per seam instance', () => {
    const seamA = createDefaultRunIdentifierSeam();
    const seamB = createDefaultRunIdentifierSeam();

    expect(seamA.next()).not.toBe(seamB.next());
  });

  it('a manual RuntimeServices controls minted ids (AB-325)', () => {
    const seed = 'identifiers-seam-test';
    const runtime = createManualRuntimeServices({ identifierSeed: seed });
    const expectedRuntime = createManualRuntimeServices({ identifierSeed: seed });

    const seam = createDefaultRunIdentifierSeam(runtime);

    expect(seam.next()).toBe(expectedRuntime.identifiers.next('run'));
    expect(seam.next()).toBe(expectedRuntime.identifiers.next('run'));
  });
});

describe('defaultRunIdentifierSeam', () => {
  it('is a shared process-wide instance that mints distinct ids', () => {
    const first = defaultRunIdentifierSeam.next();
    const second = defaultRunIdentifierSeam.next();

    expect(first).not.toBe(second);
  });
});
