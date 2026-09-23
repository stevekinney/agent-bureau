import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a skill came from.
 *
 * The kind is not decoration: it is what a trust policy decides on. A `project` skill lives in
 * whatever workspace happens to be open, so it is the least trustworthy of the four and is
 * unavailable until something admits the workspace; a `built-in` skill ships with the host and is
 * trusted by construction.
 */
export type SkillSourceKind = 'project' | 'user' | 'built-in' | 'remote' | 'storage';

/**
 * How completely a source can supply a skill.
 *
 * A registry that serves only `SKILL.md` cannot claim to deliver a bundle: the skill's
 * `references/` and `assets/` simply are not there, and a catalog entry that implied otherwise
 * would promise resources no `load_skill_resource` call can ever return.
 */
export type SkillBundleSupport = 'complete' | 'manifest-only';

/** A configured place skills are discovered from. */
export interface SkillSource {
  /**
   * Stable identity for this source, unique within a catalog.
   *
   * Distinct from {@link SkillSource.location} so a source can be renamed or moved without
   * changing what a recorded activation points at.
   */
  readonly id: string;
  readonly kind: SkillSourceKind;
  /**
   * Canonical location: an absolute filesystem path, or an origin for a remote source.
   *
   * Never a credential-bearing URL. A catalog entry exposes this verbatim, so a token embedded
   * here would leak into every inspection of the catalog.
   */
  readonly location: string;
  /**
   * Lower numbers win a name collision. Assigned explicitly rather than inferred from array order
   * so a caller reordering its configuration cannot silently change which skill shadows which.
   */
  readonly precedence: number;
  /** What this source can actually deliver. Defaults to `complete` for filesystem sources. */
  readonly bundleSupport?: SkillBundleSupport;
}

/** Default precedence by kind: a project skill shadows a user skill, which shadows a built-in. */
export const DEFAULT_SOURCE_PRECEDENCE: Readonly<Record<SkillSourceKind, number>> = Object.freeze({
  project: 10,
  user: 20,
  storage: 25,
  remote: 30,
  'built-in': 40,
});

/** The specification's own project-relative discovery root. */
export const AGENTS_SKILLS_DIRECTORY = join('.agents', 'skills');

/**
 * A compatibility root some hosts already use.
 *
 * Named and configured independently rather than scanned by default: a workspace that has one is
 * not thereby asking this runtime to load it, and silently picking up another client's skills is
 * exactly the kind of implicit trust this issue exists to remove.
 */
export const CLAUDE_SKILLS_DIRECTORY = join('.claude', 'skills');

/** Options for {@link defaultSkillSources}. */
export interface DefaultSkillSourcesOptions {
  /** The workspace root. Omit to skip project discovery entirely. */
  readonly projectRoot?: string;
  /** The user's home directory. Defaults to the process's own. */
  readonly homeDirectory?: string;
  /** Also scan the `.claude/skills` compatibility root. Default `false`. */
  readonly includeCompatibilityRoots?: boolean;
  /** Directories shipped with the host, trusted by construction. */
  readonly builtInRoots?: readonly string[];
}

/**
 * Builds the documented default source list.
 *
 * A caller that wants something else passes its own sources; this is a convenience over the
 * conventions, never a hidden policy. Nothing here decides trust — a project root appears in the
 * list whether or not it is admitted, because the catalog reports an untrusted source rather than
 * pretending it does not exist.
 */
export function defaultSkillSources(options?: DefaultSkillSourcesOptions): SkillSource[] {
  const sources: SkillSource[] = [];
  const home = options?.homeDirectory ?? homedir();

  if (options?.projectRoot !== undefined) {
    sources.push({
      id: 'project',
      kind: 'project',
      location: join(options.projectRoot, AGENTS_SKILLS_DIRECTORY),
      precedence: DEFAULT_SOURCE_PRECEDENCE.project,
    });

    if (options.includeCompatibilityRoots === true) {
      sources.push({
        id: 'project-compatibility',
        kind: 'project',
        location: join(options.projectRoot, CLAUDE_SKILLS_DIRECTORY),
        precedence: DEFAULT_SOURCE_PRECEDENCE.project + 1,
      });
    }
  }

  sources.push({
    id: 'user',
    kind: 'user',
    location: join(home, AGENTS_SKILLS_DIRECTORY),
    precedence: DEFAULT_SOURCE_PRECEDENCE.user,
  });

  if (options?.includeCompatibilityRoots === true) {
    sources.push({
      id: 'user-compatibility',
      kind: 'user',
      location: join(home, CLAUDE_SKILLS_DIRECTORY),
      precedence: DEFAULT_SOURCE_PRECEDENCE.user + 1,
    });
  }

  for (const [index, root] of (options?.builtInRoots ?? []).entries()) {
    sources.push({
      id: `built-in-${index}`,
      kind: 'built-in',
      location: root,
      precedence: DEFAULT_SOURCE_PRECEDENCE['built-in'] + index,
    });
  }

  return sources;
}

/** Whether a source is admitted, and if not, why. */
export type SkillTrustState = 'trusted' | 'untrusted' | 'revoked';

/** A trust decision about one source, carrying the reason it was made. */
export interface SkillTrustDecision {
  readonly state: SkillTrustState;
  /** Human-readable justification, safe to surface in a catalog. */
  readonly reason: string;
}

/**
 * Decides which sources may contribute skills.
 *
 * Deliberately synchronous and total: every source gets a decision, and a policy that throws is a
 * policy bug rather than an untrusted source. `undefined` from {@link SkillTrustPolicy.decide}
 * means "no opinion", which {@link resolveTrust} resolves against the default for the kind.
 */
export interface SkillTrustPolicy {
  decide(source: SkillSource): SkillTrustDecision | undefined;
}

/**
 * The default when a policy has no opinion.
 *
 * A `project` source is untrusted, which is the whole point: opening a repository must not be the
 * same act as granting its `.agents/skills` directory the ability to put instructions in front of
 * a model. `user` and `built-in` reflect a deliberate installation by the operator or the host.
 * A `remote` source is untrusted until an integrity policy admits it.
 */
export function defaultTrustForKind(kind: SkillSourceKind): SkillTrustDecision {
  switch (kind) {
    case 'built-in':
      return { state: 'trusted', reason: 'Built-in sources ship with the host.' };
    case 'user':
      return {
        state: 'trusted',
        reason: 'User sources are installed deliberately by the operator.',
      };
    case 'project':
      return {
        state: 'untrusted',
        reason:
          'Project sources are untrusted until the host or trust policy admits this workspace.',
      };
    case 'remote':
      return {
        state: 'untrusted',
        reason: 'Remote sources are untrusted until an integrity policy admits them.',
      };
    case 'storage':
      // The operator's own durable store, written by this runtime — the self-improvement flow puts
      // accepted proposals here. It is as deliberate as a user installation, and treating it as
      // untrusted would make an accepted proposal unusable by the run that accepted it.
      return {
        state: 'trusted',
        reason: 'Storage sources hold skills this runtime itself admitted and persisted.',
      };
  }
}

/** Applies a policy to a source, falling back to the default for its kind. */
export function resolveTrust(
  source: SkillSource,
  policy: SkillTrustPolicy | undefined,
): SkillTrustDecision {
  return policy?.decide(source) ?? defaultTrustForKind(source.kind);
}

/**
 * A policy that admits exactly the named source identifiers and nothing else.
 *
 * The common host case: an operator has been asked once whether to trust this workspace's skills
 * and said yes.
 */
export function admitSources(admitted: Iterable<string>): SkillTrustPolicy {
  const allowed = new Set(admitted);
  return {
    decide(source: SkillSource): SkillTrustDecision | undefined {
      if (allowed.has(source.id)) {
        return { state: 'trusted', reason: `Source '${source.id}' was explicitly admitted.` };
      }
      return undefined;
    },
  };
}
