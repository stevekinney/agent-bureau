// ── Providers ─────────────────────────────────────────────────────────
export { createStaticSkillProvider } from './create-static-skill-provider';
export { createStorageSkillProvider } from './create-storage-skill-provider';

// ── Parser ────────────────────────────────────────────────────────────
export {
  isValidSkillName,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  SKILL_NAME_PATTERN,
  SkillParseError,
} from './parse-skill-markdown';

// ── Ingestion ─────────────────────────────────────────────────────────
export { fetchFromRegistry } from './ingestion/fetch-from-registry';
export { scanDirectory } from './ingestion/scan-directory';

// ── Memory ────────────────────────────────────────────────────────────
export { createSkillMemory, createSkillMemoryHooks } from './skill-memory';

// ── Session ──────────────────────────────────────────────────────────
export { createSkillSession } from './skill-session';

// ── Catalog Hook ─────────────────────────────────────────────────────
export { createSkillCatalogHook, escapeXml } from './create-skill-catalog-hook';

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
export type { CreateSkillToolsOptions } from './create-skill-tools';
export type { FetchFromRegistryOptions, FetchResult } from './ingestion/fetch-from-registry';
export type { ScanDirectoryOptions, ScanResult } from './ingestion/scan-directory';
export type { CreateProposalToolboxOptions } from './self-improvement/create-proposal-tools';
export type {
  AcceptProposalOptions,
  IdentityProviderLike,
  ListProposalsOptions,
} from './self-improvement/proposals';
export type {
  ConversationLike,
  CreateSkillMemoryHooksOptions,
  MemoryLike,
  StepContextLike,
  StepResultLike,
} from './skill-memory';
export type { SkillSession } from './skill-session';
export type {
  KeyValueStore,
  Proposal,
  SkillCatalogEntry,
  SkillContent,
  SkillMetadata,
  SkillProvider,
  SkillResource,
  ToolPolicy,
} from './types';
