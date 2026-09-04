/**
 * Fixture for `scripts/check-mutation.test.ts` (AB-284). Deliberately small
 * — a leading no-`else` guard clause, one boundary condition, one literal
 * return per branch, and one side-effecting statement per branch — so a
 * single symbol exercises every mutation operator `scripts/check-mutation.ts`
 * implements: negate-boolean-condition (both `if`s), swap-comparison-operator
 * (`>=`), replace-returned-literal-with-default (`'unknown'`/`'high'`/`'low'`),
 * remove-statement (the `record(...)` calls), and remove-statement's
 * guard-clause form (the leading `if (Number.isNaN(value)) return 'unknown';`).
 */
export function classify(value: number, record: (label: string) => void): string {
  if (Number.isNaN(value)) return 'unknown';
  if (value >= 10) {
    record('high');
    return 'high';
  }
  record('low');
  return 'low';
}
