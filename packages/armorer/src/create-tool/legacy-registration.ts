export function hasLegacyRegister(
  value: unknown,
): value is { register: (...entries: unknown[]) => unknown } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return typeof Reflect.get(value, 'register') === 'function';
}
