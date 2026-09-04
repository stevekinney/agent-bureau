import { describe, expect, it } from 'bun:test';

import { extractRootMarkup, stripHydrationMarkers } from './test-utilities';

describe('extractRootMarkup', () => {
  it('extracts markup between the root mount and the hydration data script', () => {
    const html =
      '<html><body><div id="root">Hello <b>world</b></div>\n<script>window.__INITIAL_DATA__ = {};</script></body></html>';
    expect(extractRootMarkup(html)).toBe('Hello <b>world</b>');
  });

  it('throws when the #root mount is not found in the SSR output', () => {
    expect(() => extractRootMarkup('<html><body>no root here</body></html>')).toThrow(
      '#root mount not found in SSR output',
    );
  });
});

describe('stripHydrationMarkers', () => {
  it('strips Svelte SSR hydration anchor comments', () => {
    expect(stripHydrationMarkers('<!--[-->Hello<!--]-->')).toBe('Hello');
  });

  it('leaves markup with no hydration markers unchanged', () => {
    expect(stripHydrationMarkers('Hello world')).toBe('Hello world');
  });
});
