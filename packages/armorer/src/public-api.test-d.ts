import {
  EXTERNAL_PROJECTION_VERSION,
  type AsyncToolMetadataInput,
  type CoreToolContext,
  type ExternalExecutionProjection,
  type RegistryResolutionResult,
  type StartedToolExecution,
  type SyncToolMetadataInput,
  type ToolMetadataInput,
  type ToolRegistryLike,
  type ToolResultCacheEntry,
} from './index';

const projection: ExternalExecutionProjection = {
  version: EXTERNAL_PROJECTION_VERSION,
  audience: 'public',
  data: {},
};

void projection;

const registry: ToolRegistryLike = { tools: () => [] };
const context: CoreToolContext = { runId: 'public-run' };
const resolution: RegistryResolutionResult = { resolved: null, tier: 'exact' };
const execution: StartedToolExecution = {
  status: 'started',
  toolName: 'public-tool',
  startedAt: 0,
  ttl: 100,
};
const entry: ToolResultCacheEntry = execution;
const synchronousMetadata: SyncToolMetadataInput<{ label: string }> = () => ({ label: 'sync' });
const asynchronousMetadata: AsyncToolMetadataInput<{ label: string }> = async () => ({
  label: 'async',
});
const metadata: ToolMetadataInput<{ label: string }>[] = [
  synchronousMetadata,
  asynchronousMetadata,
];

void [registry, context, resolution, entry, metadata];
