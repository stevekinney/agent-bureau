import type { SkillSourceKind, SkillTrustState } from '../discovery/source';

/**
 * What a run recorded when it admitted one skill's instructions into context.
 *
 * Every field COR-752's Decision 5 names: the skill's identity, where it came from, the trust
 * decision that admitted it, the artifact it was read out of, the tools it asked for, and a digest
 * of the exact instructions. The instructions themselves are deliberately **not** here — this
 * record is designed to be persisted and correlated, and a provenance record that carries the
 * content it is proving would turn every audit trail into a copy of the skill.
 */
export interface SkillActivationRecord {
  readonly name: string;
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  readonly trust: SkillTrustState;
  /** The whole-bundle digest the catalog recorded when this skill was discovered. */
  readonly artifactDigest: string;
  /** SHA-256 of the exact instruction text admitted to context. */
  readonly instructionsDigest: string;
  /**
   * Tools the skill asked to be narrowed to.
   *
   * A request, never a grant: `allowed-tools` can only remove tools the run already has
   * (COR-752, Decision 2). Recording it as "requested" rather than "granted" keeps that
   * distinction legible in the audit trail itself.
   */
  readonly requestedTools: readonly string[];
  /** The catalog revision this activation was resolved against. */
  readonly catalogRevision: number;
  readonly activatedAt: string;
}

/** Why an activation was refused. */
export type SkillActivationRefusal =
  | 'unknown-skill'
  | 'not-in-catalog'
  | 'source-untrusted'
  | 'source-revoked'
  | 'incompatible'
  | 'shadowed'
  | 'artifact-unavailable'
  | 'artifact-changed'
  | 'not-delegated'
  | 'guardrail-blocked'
  | 'already-active';

/** The outcome of asking to activate one skill. */
export type SkillActivationOutcome =
  | { readonly activated: true; readonly record: SkillActivationRecord }
  | {
      readonly activated: false;
      readonly refusal: SkillActivationRefusal;
      readonly message: string;
    };

/** The outcome of asking to deactivate one skill. */
export type SkillDeactivationOutcome =
  | { readonly deactivated: true; readonly name: string }
  | { readonly deactivated: false; readonly reason: 'not-active'; readonly name: string };

/**
 * One active skill: its provenance record plus the instructions themselves.
 *
 * Kept together only in memory, and split apart on the way out — {@link SkillActivationRecord} is
 * what gets persisted and correlated, and the body is what reaches the model.
 */
export interface ActiveSkill {
  readonly record: SkillActivationRecord;
  /** The exact instruction text admitted to context. */
  readonly instructions: string;
}
