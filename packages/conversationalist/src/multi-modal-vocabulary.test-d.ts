import type {
  ContentSource,
  MediaLimits,
  MediaLimitScope,
  MimeFamily,
  Modality,
  ModalityMatrix,
} from './multi-modal';

// Modality: exactly the six named modalities, nothing else.
const allowedModality: Modality = 'text';
void allowedModality;
// @ts-expect-error Modality has no 'code' member.
const invalidModality: Modality = 'code';
void invalidModality;

const modalities: readonly Modality[] = ['text', 'image', 'audio', 'video', 'document', 'file'];
void modalities;

// MimeFamily: eight buckets, including the two container catch-alls.
const allowedMimeFamily: MimeFamily = 'application';
void allowedMimeFamily;
// @ts-expect-error MimeFamily has no 'binary' member.
const invalidMimeFamily: MimeFamily = 'binary';
void invalidMimeFamily;

const mimeFamilies: readonly MimeFamily[] = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'application',
  'font',
  'model',
];
void mimeFamilies;

// MediaLimitScope: per-part or aggregate, nothing else.
const allowedScope: MediaLimitScope = 'per-part';
void allowedScope;
// @ts-expect-error MediaLimitScope has no 'global' member.
const invalidScope: MediaLimitScope = 'global';
void invalidScope;

// MediaLimits: scope and modality required; every numeric field optional.
const minimalLimits: MediaLimits = { scope: 'aggregate', modality: 'image' };
void minimalLimits;
const fullLimits: MediaLimits = {
  scope: 'per-part',
  modality: 'video',
  maxBytes: 1_000_000,
  maxDurationSeconds: 60,
  maxPixels: 1_000_000,
  maxPageCount: 10,
};
void fullLimits;
// @ts-expect-error MediaLimits requires a scope.
const missingScope: MediaLimits = { modality: 'image' };
void missingScope;

// ContentSource: exactly nine discriminants.
const inlineSource: ContentSource = { kind: 'inline', data: 'aGVsbG8=', encoding: 'base64' };
const dataUrlSource: ContentSource = { kind: 'data-url', url: 'data:text/plain;base64,aGk=' };
const remoteUrlSource: ContentSource = { kind: 'remote-url', url: 'https://example.com/a.png' };
const localFileSource: ContentSource = { kind: 'local-file', path: '/tmp/a.png' };
const uploadSource: ContentSource = { kind: 'upload', uploadId: 'upload-1' };
const providerFileSource: ContentSource = {
  kind: 'provider-file',
  provider: 'anthropic',
  providerFileId: 'file-1',
};
const mcpResourceSource: ContentSource = {
  kind: 'mcp-resource',
  serverId: 'server-1',
  uri: 'mcp://server-1/resource',
};
const a2aReferenceSource: ContentSource = {
  kind: 'a2a-reference',
  agentCardUrl: 'https://example.com/agent-card',
  artifactId: 'artifact-1',
};
const managedAssetSource: ContentSource = { kind: 'managed-asset', assetId: 'asset-1' };
void inlineSource;
void dataUrlSource;
void remoteUrlSource;
void localFileSource;
void uploadSource;
void providerFileSource;
void mcpResourceSource;
void a2aReferenceSource;
void managedAssetSource;

// @ts-expect-error ContentSource has no 'inline-file' discriminant.
const invalidSource: ContentSource = { kind: 'inline-file' };
void invalidSource;

// ModalityMatrix: one entry per Modality, each with input/output booleans and
// a readonly list of ContentSource kinds it accepts as a source form.
const matrix: ModalityMatrix = {
  text: { input: true, output: true, sourceForms: ['inline'] },
  image: { input: true, output: false, sourceForms: ['inline', 'remote-url'] },
  audio: { input: false, output: false, sourceForms: [] },
  video: { input: false, output: false, sourceForms: [] },
  document: { input: true, output: false, sourceForms: ['inline'] },
  file: { input: false, output: false, sourceForms: [] },
};
void matrix;

// @ts-expect-error ModalityMatrix must cover every Modality key.
const incompleteMatrix: ModalityMatrix = {
  text: { input: true, output: true, sourceForms: ['inline'] },
};
void incompleteMatrix;

const invalidMatrixSourceForm: ModalityMatrix = {
  // @ts-expect-error ModalityMatrix's sourceForms must be ContentSource['kind'] values.
  text: { input: true, output: true, sourceForms: ['not-a-source-kind'] },
  image: { input: false, output: false, sourceForms: [] },
  audio: { input: false, output: false, sourceForms: [] },
  video: { input: false, output: false, sourceForms: [] },
  document: { input: false, output: false, sourceForms: [] },
  file: { input: false, output: false, sourceForms: [] },
};
void invalidMatrixSourceForm;
