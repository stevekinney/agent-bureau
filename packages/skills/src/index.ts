// ── Providers ─────────────────────────────────────────────────────────
export { createStaticSkillProvider } from './create-static-skill-provider';
export { createStorageSkillProvider } from './create-storage-skill-provider';

// ── Parser ────────────────────────────────────────────────────────────
export {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  SkillParseError,
} from './parse-skill-markdown';

// ── Ingestion ─────────────────────────────────────────────────────────
export { fetchFromRegistry } from './ingestion/fetch-from-registry';
export { scanDirectory, watchDirectory } from './ingestion/scan-directory';

// ── Memory ────────────────────────────────────────────────────────────
export { createSkillMemory } from './create-skill-memory';
export { createSkillMemoryHooks } from './create-skill-memory-hooks';

// ── Session ──────────────────────────────────────────────────────────
export { createSkillSession } from './skill-session';

// ── Catalog Hook ─────────────────────────────────────────────────────
export { createSkillCatalogHook } from './create-skill-catalog-hook';

// ── Tools ────────────────────────────────────────────────────────────
export {
  createActivateSkillTool,
  createDeactivateSkillTool,
  createListSkillsTool,
  createLoadSkillResourceTool,
  createSkillToolbox,
  isSkillContent,
} from './create-skill-tools';

// ── Proposals ────────────────────────────────────────────────────────
export {
  createAcceptProposalTool,
  createListProposalsTool,
  createProposalToolbox,
  createRejectProposalTool,
  createViewProposalTool,
} from './self-improvement/create-proposal-tools';
export {
  acceptProposal,
  clearProposals,
  getProposal,
  isRejectedPattern,
  listProposals,
  rejectProposal,
  saveProposal,
} from './self-improvement/proposals';

// ── Types ─────────────────────────────────────────────────────────────
export type { CreateSkillCatalogHookOptions } from './create-skill-catalog-hook';
export type {
  ConversationLike,
  MemoryLike,
  StepContextLike,
  StepResultLike,
} from './create-skill-memory';
export type { CreateSkillMemoryHooksOptions } from './create-skill-memory-hooks';
export type { CreateSkillToolsOptions } from './create-skill-tools';
export type { FetchFromRegistryOptions, FetchResult } from './ingestion/fetch-from-registry';
export type {
  ScanDirectoryOptions,
  ScanResult,
  WatchDirectoryOptions,
} from './ingestion/scan-directory';
export type { CreateProposalToolboxOptions } from './self-improvement/create-proposal-tools';
export type {
  AcceptProposalOptions,
  IdentityProviderLike,
  ListProposalsOptions,
} from './self-improvement/proposals';
export type { SkillSession } from './skill-session';
export type {
  EnvironmentCapabilities,
  PatternAnalysis,
  PatternCluster,
  Proposal,
  SkillCatalogEntry,
  SkillContent,
  SkillMetadata,
  SkillProvider,
  SkillResource,
  StorageAdapter,
  SweepState,
  ToolPolicy,
} from './types';
