// Public type surface.
export type { SkillAdmissionPolicy } from './admission';
export type {
  CreateSkillArtifactOptions,
  NormalizedArtifactPath,
  ResolvedSkillAdmissionLimits,
  SkillAdmissionCode,
  SkillAdmissionDiagnostic,
  SkillAdmissionLimits,
  SkillArtifact,
  SkillArtifactAdmission,
  SkillArtifactEntry,
  SkillArtifactInputFile,
} from './artifact';
export type {
  ActiveSkill,
  SkillActivationOutcome,
  SkillActivationRecord,
  SkillActivationRefusal,
  SkillDeactivationOutcome,
} from './client/activation';
export type {
  LoadedSkillResource,
  SkillArtifactLoad,
  SkillArtifactLoader,
} from './client/artifact-loader';
// Artifact load failures are a separate public result shape.
export type { SkillArtifactLoadFailure } from './client/artifact-loader';
export type {
  CreateSkillClientOptions,
  SkillClient,
  SkillDelegationGrant,
  SkillStanding,
  SkillStandingEntry,
} from './client/skill-client';
export type {
  PortableFrontmatterField,
  SkillConformanceCode,
  SkillConformanceDiagnostic,
  ValidatePortableFrontmatterOptions,
} from './conformance';
export type {
  SkillCatalogRecord,
  SkillCatalogRevision,
  SkillCompatibility,
  SkillDiscoveryOutcome,
  SkillSourceDiagnostic,
  SkillUnavailableReason,
} from './discovery/catalog';
export type {
  CreateSkillCatalogServiceOptions,
  SkillCatalogRefreshCleanup,
  SkillCatalogRefreshHandle,
  SkillCatalogRefreshOptions,
  SkillCatalogRefreshOutcome,
  SkillCatalogRefreshResult,
  SkillCatalogRefreshSnapshot,
  SkillCatalogRefreshStatus,
  SkillCatalogService,
} from './discovery/catalog-service';
export type { DiscoverSkillsOptions } from './discovery/discover';
export type {
  MaterializeRemoteSourceOptions,
  RemoteAdmissionCode,
  RemoteAdmissionDiagnostic,
  RemoteMaterialization,
  RemoteSignatureVerifier,
  RemoteSkillIntegrity,
  RemoteSkillSource,
} from './discovery/remote';
export type {
  DefaultSkillSourcesOptions,
  SkillBundleSupport,
  SkillSource,
  SkillSourceKind,
  SkillTrustDecision,
  SkillTrustPolicy,
  SkillTrustState,
} from './discovery/source';
export type {
  SkillAdmissionRule,
  SkillEventClassMap,
  SkillEventCorrelation,
  SkillEventMap,
  SkillEventType,
  SkillRejectionReason,
} from './events';
export type { ScannedSkillContent, SkillGuardrailOptions } from './guardrail';
export type { ReadSkillArtifactOptions } from './ingestion/read-skill-artifact';
export type {
  ParseSkillMarkdownOptions,
  SkillImportRepair,
  SkillImportRepairCode,
  SkillImportResult,
} from './parse-skill-markdown';
export type { CreateProposalToolboxOptions } from './self-improvement/create-proposal-tools';
export type {
  AcceptProposalOptions,
  IdentityProviderLike,
  ListProposalsOptions,
} from './self-improvement/proposals';
export type {
  MemorySink,
  PersonaSink,
  ReflectionSink,
  ReflectionSweepOptions,
  SkillSink,
  SoulSink,
} from './self-improvement/reflection-sweep';
export type {
  ConversationLike,
  CreateSkillMemoryHooksOptions,
  MemoryLike,
  StepContextLike,
  StepResultLike,
} from './skill-memory';
export type {
  Proposal,
  SkillCatalogEntry,
  SkillContent,
  SkillMetadata,
  SkillResource,
  SkillWriter,
  ToolPolicy,
} from './types';

// Public runtime surface.
export { refusedByAdmissionPolicy } from './admission';
export {
  createSkillArtifact,
  decodeArtifactText,
  findArtifactEntry,
  findArtifactManifest,
  normalizeArtifactPath,
  resolveAdmissionLimits,
  resolveMediaType,
} from './artifact';
// Admission limits and manifest filenames are public constants.
export {
  DEFAULT_SKILL_ADMISSION_LIMITS,
  SKILL_MANIFEST_FALLBACK_FILENAME,
  SKILL_MANIFEST_FILENAME,
} from './artifact';
export {
  createFilesystemArtifactLoader,
  createSkillArtifactLoader,
  createStaticArtifactLoader,
  createStorageArtifactLoader,
  readInstructions,
  readResource,
} from './client/artifact-loader';
export { createSkillClientToolbox, renderClientCatalog } from './client/client-toolbox';
export {
  isRenderedSkillContent,
  renderActiveSkillInstructions,
  renderSkillCatalog,
} from './client/render';
export { createSkillClient } from './client/skill-client';
export {
  isPortableSkillName,
  normalizeSkillName,
  parseAllowedTools,
  serializeAllowedTools,
  validatePortableFrontmatter,
} from './conformance';
// Specification limits and fields are public constants.
export {
  AGENT_SKILLS_SPECIFICATION_REPOSITORY,
  AGENT_SKILLS_SPECIFICATION_REVISION,
  MAXIMUM_COMPATIBILITY_LENGTH,
  MAXIMUM_DESCRIPTION_LENGTH,
  MAXIMUM_SKILL_NAME_LENGTH,
  PORTABLE_FRONTMATTER_FIELDS,
} from './conformance';
export { createStorageSkillProvider } from './create-storage-skill-provider';
export { availableRecords, findRecord, generalCatalogProjection } from './discovery/catalog';
export { createSkillCatalogService } from './discovery/catalog-service';
export { discoverSkills } from './discovery/discover';
export { materializeRemoteSource } from './discovery/remote';
export {
  admitSources,
  defaultSkillSources,
  defaultTrustForKind,
  resolveTrust,
} from './discovery/source';
// Well-known source directories and precedence are public constants.
export {
  AGENTS_SKILLS_DIRECTORY,
  CLAUDE_SKILLS_DIRECTORY,
  DEFAULT_SOURCE_PRECEDENCE,
} from './discovery/source';
export { readStoredSkillArtifacts } from './discovery/storage-source';
export {
  SkillActivatedEvent,
  SkillCancelledEvent,
  SkillCatalogRevisedEvent,
  SkillCompatibilityDecidedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRecoveredEvent,
  SkillReinjectedEvent,
  SkillRejectedEvent,
  SkillResourceLoadedEvent,
  SkillSourceAdmittedEvent,
} from './events';
export { scanSkillResource } from './guardrail';
export { readSkillArtifact } from './ingestion/read-skill-artifact';
export {
  importSkillMarkdown,
  isValidSkillName,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from './parse-skill-markdown';
// Parser errors are public constructors.
export { SkillConformanceError, SkillParseError } from './parse-skill-markdown';
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
export { reflectionSweep } from './self-improvement/reflection-sweep';
export { createSkillMemory, createSkillMemoryHooks } from './skill-memory';
export { createMockKeyValueStore, createMockSkillProvider } from './test/index';
export { escapeXml } from './xml';
