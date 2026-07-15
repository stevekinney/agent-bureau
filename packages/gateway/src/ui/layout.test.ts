import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

const layoutSource = readFileSync(new URL('./layout.svelte', import.meta.url), 'utf8');
const layoutStyles = readFileSync(new URL('./styles/layout.css', import.meta.url), 'utf8');

describe('Gateway layout responsive contract', () => {
  it('uses Cinder and Svelte responsive primitives instead of owning the Sidebar breakpoint', () => {
    expect(layoutSource).toMatch(/import\s*{\s*MediaQuery\s*}\s*from\s*'svelte\/reactivity'/);
    expect(layoutSource).toMatch(/new MediaQuery\(SIDEBAR_MOBILE_MEDIA_QUERY,\s*false\)/);
    expect(layoutSource).toMatch(/class:layout--mobile\s*=\s*{mobileSidebar\.current}/);
    expect(layoutSource).toMatch(/@media\s+\${SIDEBAR_MOBILE_MEDIA_QUERY}/);
    expect(layoutStyles).toMatch(/\.layout--mobile\b/);

    expect(layoutSource).not.toContain('matchMedia');
    expect(layoutSource).not.toContain('sidebarBreakpointQuery');
    expect(layoutSource).not.toContain('47.99rem');
    expect(layoutStyles).not.toContain('47.99rem');
  });

  it('keeps the app-owned trigger associated with the Sidebar drawer', () => {
    expect(layoutSource).toContain('id="agent-bureau-sidebar"');
    expect(layoutSource).toContain('aria-controls="agent-bureau-sidebar"');
    expect(layoutSource).toContain('aria-expanded={!sidebarCollapsed}');
  });
});
