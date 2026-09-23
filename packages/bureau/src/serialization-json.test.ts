import { describe, expect, it } from 'bun:test';

import { serializeActionDetail } from './serialization';

describe('JSON serialization boundaries', () => {
  it('preserves enumerable own special keys without changing the output prototype', () => {
    const input: unknown = JSON.parse(
      '{"__proto__":{"marker":"kept"},"constructor":"kept","prototype":"kept-too","normal":1}',
    );
    const output = serializeActionDetail('other', input);
    if (output === null || typeof output !== 'object') throw new Error('Expected an object');

    expect(Object.hasOwn(output, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(JSON.stringify(output)).toBe(JSON.stringify(input));
  });

  it('reads toJSON at the original call boundary and preserves its receiver', () => {
    const operations: string[] = [];
    const value = {
      message: 'receiver value',
      get toJSON() {
        operations.push('get toJSON');
        return function (this: { message: string }) {
          operations.push('call toJSON');
          return { message: this.message };
        };
      },
      get excluded() {
        throw new Error('toJSON replaces source property traversal');
      },
    };

    expect(serializeActionDetail('other', value)).toEqual({ message: 'receiver value' });
    expect(operations).toEqual(['get toJSON', 'get toJSON', 'call toJSON']);
  });
});
