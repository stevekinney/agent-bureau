import type { JSONValue } from './types';

export interface TextContent {
  type: 'text';
  text: string;
  /**
   * Citation references Anthropic attaches to cited text (e.g. from web search).
   * Preserved opaquely so they round-trip for display and multi-turn replay.
   */
  citations?: JSONValue;
}

export interface ImageContent {
  type: 'image';
  url: string;
  mimeType?: string;
  text?: string;
}

export type DocumentSource =
  | {
      kind: 'base64';
      data: string;
    }
  | {
      kind: 'reference';
      uri: string;
    };

export interface DocumentContent {
  type: 'document';
  name: string;
  mimeType: string;
  source: DocumentSource;
}

export function renderDocumentReferenceText(document: DocumentContent): string {
  if (document.source.kind === 'reference') {
    return `[Document: ${document.name} (${document.mimeType}) at ${document.source.uri}]`;
  }

  return `[Document: ${document.name} (${document.mimeType}); base64 data omitted]`;
}

/**
 * Extended thinking content block.
 * Represents the model's internal reasoning. The signature must be preserved
 * byte-for-byte for subsequent conversation turns.
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/**
 * Redacted extended thinking content block.
 * The plaintext reasoning is withheld; Anthropic returns its encrypted payload in
 * a `data` field (NOT a `signature`). The `data` must be preserved byte-for-byte
 * and replayed unchanged on subsequent conversation turns.
 */
export interface RedactedThinkingContent {
  type: 'redacted_thinking';
  data: string;
}

/**
 * Server-side tool use content block (e.g. Anthropic built-in tools such as web_search).
 * Input is the JSON the model produced for the built-in tool.
 *
 * Note: there is intentionally NO client-tool-use content block. A client tool
 * call is represented as a `tool-call` ROLE message (so a later `tool-result`
 * can pair to it), not as assistant content — putting a client tool call in
 * content would create an orphaned tool result that integrity rejects.
 */
export interface ServerToolUseContent {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: JSONValue;
}

/**
 * Web search tool result content block returned by Anthropic's built-in web_search tool.
 */
export interface WebSearchToolResultContent {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: JSONValue;
}

/**
 * Result block types for Anthropic's built-in server tools (code execution and
 * web fetch). Enumerated explicitly (rather than an open string) so they
 * discriminate cleanly; add a literal here when Anthropic ships a new
 * server-tool result block.
 */
export type ServerToolResultType =
  | 'code_execution_tool_result'
  | 'bash_code_execution_tool_result'
  | 'text_editor_code_execution_tool_result'
  | 'web_fetch_tool_result';

/**
 * Result block returned by an Anthropic built-in server tool (code execution,
 * web fetch). Preserves stdout, exit codes, file ids, fetched content, and
 * errors so they round-trip in the conversation history instead of being dropped.
 */
export interface ServerToolResultContent {
  type: ServerToolResultType;
  tool_use_id: string;
  content: JSONValue;
}

/**
 * Container upload content block. Anthropic represents a file uploaded into a
 * code-execution container as a `container_upload` block referencing the
 * uploaded file by id; preserved so the reference survives the round-trip.
 */
export interface ContainerUploadContent {
  type: 'container_upload';
  file_id: string;
}

export type MultiModalContent =
  | TextContent
  | ImageContent
  | DocumentContent
  | ThinkingContent
  | RedactedThinkingContent
  | ServerToolUseContent
  | WebSearchToolResultContent
  | ServerToolResultContent
  | ContainerUploadContent;

/**
 * Creates a shallow copy of a MultiModalContent item.
 */
export function copyMultiModalContent(item: MultiModalContent): MultiModalContent {
  if (item.type === 'text') {
    return {
      type: 'text',
      text: item.text,
      ...(item.citations !== undefined ? { citations: structuredClone(item.citations) } : {}),
    };
  }
  if (item.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: item.thinking,
      signature: item.signature,
    };
  }
  if (item.type === 'redacted_thinking') {
    return {
      type: 'redacted_thinking',
      data: item.data,
    };
  }
  if (item.type === 'document') {
    return {
      type: 'document',
      name: item.name,
      mimeType: item.mimeType,
      source: { ...item.source },
    };
  }
  if (item.type === 'server_tool_use') {
    return {
      type: 'server_tool_use',
      // Deep-copy the JSON payload: copyContent feeds messageToJSON and clone
      // paths that must return independent values, so a shared object/array
      // reference would let a mutation of the copy leak into the original.
      id: item.id,
      name: item.name,
      input: structuredClone(item.input),
    };
  }
  if (item.type === 'web_search_tool_result') {
    return {
      type: 'web_search_tool_result',
      tool_use_id: item.tool_use_id,
      content: structuredClone(item.content),
    };
  }
  if (
    item.type === 'code_execution_tool_result' ||
    item.type === 'bash_code_execution_tool_result' ||
    item.type === 'text_editor_code_execution_tool_result' ||
    item.type === 'web_fetch_tool_result'
  ) {
    return {
      type: item.type,
      tool_use_id: item.tool_use_id,
      content: structuredClone(item.content),
    };
  }
  if (item.type === 'container_upload') {
    return { type: 'container_upload', file_id: item.file_id };
  }
  // All non-image variants are handled above. TypeScript cannot fully narrow
  // `item` to ImageContent here because ServerToolResultContent's `type`
  // is itself a union alias, so we assert the exhausted remainder.
  const image = item as ImageContent;
  return {
    type: 'image',
    url: image.url,
    ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
    ...(image.text !== undefined ? { text: image.text } : {}),
  };
}

/**
 * Copies content, ensuring a mutable array is returned for multi-modal content.
 */
export function copyContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | MultiModalContent[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map(copyMultiModalContent);
}

// ── AB-70 portable content and modality vocabulary ──────────────────────
//
// Transcribed verbatim from AB-70's "Portable content and modality
// vocabulary" section (ratified 2026-09-01), additive only. Nothing above
// this marker is renamed, reshaped, or removed by this addition; AB-72 owns
// the eventual replacement of `MultiModalContent`/`ImageContent`/
// `DocumentContent`/`DocumentSource`. These six type-only names exist so
// AB-64's `BackendDescriptor` (and later AB-72/AB-75) can cite one shared
// vocabulary instead of inventing a parallel one. See
// `multi-modal-vocabulary.test-d.ts` for the compile-time shape proof.

/** The six portable content modalities a backend or provider can carry. */
export type Modality = 'text' | 'image' | 'audio' | 'video' | 'document' | 'file';

// A MIME "family" is the type before the slash, plus the handful of container
// formats that need their own bucket because they carry mixed content.
export type MimeFamily =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document' // application/pdf and other paginated/structured document containers
  | 'application' // generic binary / octet-stream and non-document application/* types
  | 'font'
  | 'model'; // 3D/model/* MIME types, carried as generic `file` parts

// The nine ingress source forms, mapped onto ContentSource's discriminant.
export type ContentSource =
  | { kind: 'inline'; data: string; encoding: 'base64' | 'utf8' }
  | { kind: 'data-url'; url: string }
  | { kind: 'remote-url'; url: string } // deny-by-default hardened fetch is deployment configuration
  | { kind: 'local-file'; path: string } // host-process only; never crosses a network boundary
  | { kind: 'upload'; uploadId: string } // prior to becoming a ManagedAsset
  | { kind: 'provider-file'; provider: string; providerFileId: string }
  | { kind: 'mcp-resource'; serverId: string; uri: string }
  | { kind: 'a2a-reference'; agentCardUrl: string; artifactId: string }
  | { kind: 'managed-asset'; assetId: string; revision?: number };

export type MediaLimitScope = 'per-part' | 'aggregate';

export interface MediaLimits {
  scope: MediaLimitScope;
  modality: Modality;
  maxBytes?: number;
  maxDurationSeconds?: number; // audio/video
  maxPixels?: number; // image/video, guards decompression/pixel-bomb inputs
  maxPageCount?: number; // document
}

/**
 * Capability discovery: each provider adapter and Gateway-advertised
 * protocol exposes a `ModalityMatrix`, consumed by AB-64's backend
 * descriptor (`BackendDescriptor.modalities`).
 */
export type ModalityMatrix = Record<
  Modality,
  { input: boolean; output: boolean; sourceForms: readonly ContentSource['kind'][] }
>;
