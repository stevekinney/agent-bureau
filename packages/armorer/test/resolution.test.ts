import { describe, expect, it } from 'bun:test';
import {
  buildNameCandidates,
  normalizeName,
  resolveCaseInsensitive,
  resolveFuzzyToolName,
} from '../src/resolution/index';

describe('resolution', () => {
  describe('normalizeName', () => {
    it('lowercases and replaces separators', () => {
      expect(normalizeName('Foo.Bar')).toBe('foo-bar');
      expect(normalizeName('foo/bar')).toBe('foo-bar');
      expect(normalizeName('foo_bar')).toBe('foo-bar');
    });
    it('is idempotent', () => {
      expect(normalizeName(normalizeName('Foo.Bar'))).toBe('foo-bar');
    });
    it('trims whitespace', () => {
      expect(normalizeName('  hello  ')).toBe('hello');
    });
  });

  describe('resolveCaseInsensitive', () => {
    it('finds single case-insensitive match', () => {
      expect(resolveCaseInsensitive('READ_FILE', ['read-file', 'write-file'])).toBe(null);
      expect(resolveCaseInsensitive('Read-File', ['read-file', 'write-file'])).toBe('read-file');
    });
    it('returns null for ambiguous', () => {
      expect(resolveCaseInsensitive('tool', ['Tool', 'TOOL'])).toBe(null);
    });
    it('returns null for no match', () => {
      expect(resolveCaseInsensitive('missing', ['read', 'write'])).toBe(null);
    });
  });

  describe('buildNameCandidates', () => {
    it('returns normalized and suffix', () => {
      const candidates = buildNameCandidates('namespace.tool-name');
      expect(candidates).toContain('namespace-tool-name');
    });
    it('handles simple names', () => {
      const candidates = buildNameCandidates('simple');
      expect(candidates).toContain('simple');
    });
  });

  describe('resolveFuzzyToolName', () => {
    const toolNames = ['read-file', 'write-file', 'list-dir'];

    it('returns exact match with tier exact', () => {
      const result = resolveFuzzyToolName('read-file', toolNames);
      expect(result).toEqual({ resolved: 'read-file', tier: 'exact' });
    });

    it('resolves case-insensitive', () => {
      const result = resolveFuzzyToolName('Read-File', toolNames);
      expect(result).toEqual({ resolved: 'read-file', tier: 'case-insensitive' });
    });

    it('returns ambiguous for multiple case-insensitive matches', () => {
      const result = resolveFuzzyToolName('tool', ['Tool', 'TOOL', 'other']);
      expect(result.resolved).toBeNull();
      expect((result as any).ambiguous).toContain('Tool');
      expect((result as any).ambiguous).toContain('TOOL');
    });

    it('resolves via normalized matching with dots', () => {
      const result = resolveFuzzyToolName('read.file', ['read-file', 'write-file']);
      expect(result).toEqual({ resolved: 'read-file', tier: 'normalized' });
    });

    it('resolves via normalized matching with slashes', () => {
      const result = resolveFuzzyToolName('read/file', ['read-file', 'write-file']);
      expect(result).toEqual({ resolved: 'read-file', tier: 'normalized' });
    });

    it('resolves via normalized matching with underscores', () => {
      const result = resolveFuzzyToolName('read_file', ['read-file', 'write-file']);
      expect(result).toEqual({ resolved: 'read-file', tier: 'normalized' });
    });

    it('resolves via suffix matching', () => {
      const result = resolveFuzzyToolName('prefix.list-dir', [
        'read-file',
        'write-file',
        'list-dir',
      ]);
      expect(result).toEqual({ resolved: 'list-dir', tier: 'suffix' });
    });

    it('returns ambiguous for multiple suffix matches', () => {
      const result = resolveFuzzyToolName('ns.tool', ['a-tool', 'b-tool']);
      expect(result.resolved).toBeNull();
      expect((result as any).ambiguous).toBeDefined();
    });

    it('returns null for no match', () => {
      expect(resolveFuzzyToolName('missing', toolNames)).toEqual({ resolved: null });
    });

    it('returns null for empty name', () => {
      expect(resolveFuzzyToolName('', toolNames)).toEqual({ resolved: null });
    });

    it('returns ambiguous for multiple normalized matches', () => {
      const result = resolveFuzzyToolName('foo.bar', ['foo-bar', 'foo_bar']);
      expect(result.resolved).toBeNull();
      expect((result as any).ambiguous).toContain('foo-bar');
      expect((result as any).ambiguous).toContain('foo_bar');
    });

    it('handles suffix segment that is empty after split', () => {
      // Trailing separator produces empty last segment
      const result = resolveFuzzyToolName('ns.tool.', ['other']);
      expect(result).toEqual({ resolved: null });
    });

    it('falls through suffix matching when no suffix matches', () => {
      // Multi-segment name where suffix doesn't match any tool's last segment
      const result = resolveFuzzyToolName('prefix.unique', ['alpha-beta', 'gamma-delta']);
      expect(result).toEqual({ resolved: null });
    });
  });
});
