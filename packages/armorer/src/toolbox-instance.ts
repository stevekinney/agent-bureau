import type { Toolbox } from './toolbox-interface';

export function isToolbox(value: unknown): value is Toolbox<any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'tools') === 'function' &&
    typeof Reflect.get(value, 'getTool') === 'function' &&
    typeof Reflect.get(value, 'execute') === 'function' &&
    typeof Reflect.get(value, 'toJSON') === 'function'
  );
}
