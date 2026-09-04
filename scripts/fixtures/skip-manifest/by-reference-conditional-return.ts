/**
 * Fixture for scripts/check-skip-manifest.test.ts (AB-293).
 *
 * Deliberately named without a `.test.ts` suffix, matching the other fixtures in this directory:
 * it exists to be parsed as fixture source text by the gate's own test, not discovered by the
 * gate's real repository scan.
 *
 * The test callback is passed by reference (`it('case', bailsOutEarly)`) rather than declared
 * inline. `bailsOutEarly`'s body is a structural conditional early return — a `ReturnStatement`
 * inside an `IfStatement` that is the first statement of the body — with no `.skip` call to grep
 * for. Before AB-293, a by-reference callback was never followed to its declaration, so this
 * conditional early return was entirely invisible to the gate; must now be flagged.
 */
import { expect, it } from 'bun:test';

it('bails out early through a callback passed by reference', bailsOutEarly);

function bailsOutEarly() {
  if (Bun.env['SOME_CONDITION'] !== 'set') {
    return;
  }
  expect(true).toBe(true);
}
