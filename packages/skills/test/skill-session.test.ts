import { describe, expect, it } from 'bun:test';

import { createSkillSession } from '../src/skill-session';

describe('createSkillSession', () => {
  it('has no active skills when newly created', () => {
    const session = createSkillSession();
    expect(session.getActiveSkills()).toEqual([]);
  });

  it('adds a skill to the active set on activate', () => {
    const session = createSkillSession();
    session.activate('code-review');
    expect(session.getActiveSkills()).toEqual(['code-review']);
  });

  it('returns true for active skills and false for inactive ones', () => {
    const session = createSkillSession();
    session.activate('code-review');

    expect(session.isActive('code-review')).toBe(true);
    expect(session.isActive('deploy')).toBe(false);
  });

  it('removes a skill from the active set on deactivate', () => {
    const session = createSkillSession();
    session.activate('code-review');
    session.activate('deploy');

    session.deactivate('code-review');

    expect(session.isActive('code-review')).toBe(false);
    expect(session.isActive('deploy')).toBe(true);
    expect(session.getActiveSkills()).toEqual(['deploy']);
  });

  it('treats deactivating a non-active skill as a no-op', () => {
    const session = createSkillSession();
    session.activate('code-review');

    // Should not throw
    session.deactivate('nonexistent');

    expect(session.getActiveSkills()).toEqual(['code-review']);
  });

  it('returns undefined for getActiveToolPolicy when no active skills have policies', () => {
    const session = createSkillSession();
    expect(session.getActiveToolPolicy()).toBeUndefined();

    session.activate('code-review');
    expect(session.getActiveToolPolicy()).toBeUndefined();
  });

  it('returns the policy of a single active skill with a tool policy', () => {
    const session = createSkillSession();
    session.activate('code-review', {
      allowList: ['read_file', 'grep'],
      denyList: ['delete_file'],
    });

    expect(session.getActiveToolPolicy()).toEqual({
      allowList: ['read_file', 'grep'],
      denyList: ['delete_file'],
    });
  });

  it('merges multiple active skill policies: intersection of allow lists, union of deny lists', () => {
    const session = createSkillSession();

    session.activate('code-review', {
      allowList: ['read_file', 'grep', 'write_file'],
      denyList: ['delete_file'],
    });

    session.activate('deploy', {
      allowList: ['read_file', 'write_file', 'exec'],
      denyList: ['drop_database'],
    });

    const merged = session.getActiveToolPolicy();

    // Intersection of allow lists: only tools in both
    expect(merged?.allowList?.sort()).toEqual(['read_file', 'write_file']);
    // Union of deny lists: all denied tools
    expect(merged?.denyList?.sort()).toEqual(['delete_file', 'drop_database']);
  });

  it('returns all active skill names from getActiveSkills', () => {
    const session = createSkillSession();
    session.activate('code-review');
    session.activate('deploy');
    session.activate('testing');

    expect(session.getActiveSkills().sort()).toEqual(['code-review', 'deploy', 'testing']);
  });

  it('handles mixed policies where only some skills have allow lists', () => {
    const session = createSkillSession();

    // This skill has an allow list
    session.activate('code-review', {
      allowList: ['read_file', 'grep'],
    });

    // This skill has no policy at all
    session.activate('deploy');

    // Only one skill has a policy, so its policy is the result
    const merged = session.getActiveToolPolicy();
    expect(merged?.allowList?.sort()).toEqual(['grep', 'read_file']);
  });

  it('handles policies with only deny lists', () => {
    const session = createSkillSession();

    session.activate('code-review', {
      denyList: ['delete_file'],
    });

    session.activate('deploy', {
      denyList: ['drop_database'],
    });

    const merged = session.getActiveToolPolicy();
    expect(merged?.allowList).toBeUndefined();
    expect(merged?.denyList?.sort()).toEqual(['delete_file', 'drop_database']);
  });
});
