import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineTool } from '../src/core';
import {
  createRegistry,
  internalRegistryModuleTestUtilities,
} from '../src/core/registry/registry';

describe('registry module coverage', () => {
  it('covers prerelease comparisons that are not reachable through normal registry sorting', () => {
    const { comparePrerelease } = internalRegistryModuleTestUtilities;

    expect(comparePrerelease('1.alpha', '1.alpha')).toBe(0);
    expect(comparePrerelease('alpha', 'alpha')).toBe(0);
  });

  it('keeps by-name entries when unregistering one of multiple versions', () => {
    const registry = createRegistry();
    const first = defineTool({
      name: 'shared-name',
      version: '1.0.0',
      description: 'first',
      input: z.object({}),
    });
    const second = defineTool({
      name: 'shared-name',
      version: '2.0.0',
      description: 'second',
      input: z.object({}),
    });

    registry.register(first);
    registry.register(second);

    expect(registry.tools().map((tool) => tool.id)).toEqual([first.id, second.id]);
    expect(registry.unregister(first.id)).toBe(true);
    expect(registry.tools().map((tool) => tool.id)).toEqual([second.id]);
    expect(registry.resolve({ name: 'shared-name' })?.id).toBe(second.id);
  });

  it('normalizes non-canonical definitions when registering', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'canonical-tool',
      version: '1.0.0',
      description: 'canonical',
      input: z.object({}),
    });

    registry.register({
      ...tool,
      id: 'not-canonical',
      identity: {
        namespace: ' default ',
        name: ' canonical-tool ',
        version: ' 1.0.0 ',
      },
    } as any);

    expect(registry.get('default:canonical-tool@1.0.0')?.id).toBe(
      'default:canonical-tool@1.0.0',
    );
  });
});
