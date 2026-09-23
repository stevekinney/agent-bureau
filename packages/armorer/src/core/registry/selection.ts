import { getSchemaKeys } from '../schema-utilities';
import type {
  QuerySelectionResult,
  ToolDefinition,
  ToolMatch,
  ToolQuery,
  ToolSearchOptions,
  ToolSummary,
} from './types';

export function applyPagination<T>(items: T[], limit?: number, offset?: number): T[] {
  const start = normalizeOffset(offset);
  const max = normalizeLimit(limit);
  if (max === undefined) {
    return items.slice(start);
  }
  return items.slice(start, start + max);
}

export function selectMatchResults(
  matches: ToolMatch[],
  options: ToolSearchOptions,
): ToolMatch<unknown>[] {
  const select = options.select;
  if (!select || select === 'tool') {
    return matches;
  }
  if (select === 'name') {
    return matches.map((match) => ({
      ...match,
      tool: match.tool.name,
    }));
  }
  if (select === 'configuration') {
    return matches;
  }
  if (select === 'summary') {
    const includeConfiguration = options.includeToolConfiguration;
    return matches.map((match) => ({
      ...match,
      tool: createToolSummary(match.tool, includeConfiguration, options.includeSchema),
    }));
  }
  return matches;
}

export function selectQueryResults(
  tools: ToolDefinition[],
  criteria: ToolQuery | undefined,
): QuerySelectionResult {
  const select = criteria?.select;
  if (!select || select === 'tool') {
    return tools;
  }
  if (select === 'name') {
    return tools.map((tool) => tool.name);
  }
  if (select === 'configuration') {
    return tools;
  }
  if (select === 'summary') {
    const includeConfiguration = criteria.includeToolConfiguration;
    return tools.map((tool) =>
      createToolSummary(tool, includeConfiguration, criteria.includeSchema),
    );
  }
  return tools;
}

export function createToolSummary(
  tool: ToolDefinition,
  includeConfiguration?: boolean,
  includeSchema?: boolean,
): ToolSummary {
  const summary: ToolSummary = {
    id: tool.id,
    identity: tool.identity,
    name: tool.name,
    description: tool.description,
    schemaKeys: getSchemaKeys(tool.input),
  };
  if (tool.tags) summary.tags = tool.tags;
  if (tool.metadata) summary.metadata = tool.metadata;
  if (tool.risk) summary.risk = tool.risk;
  if (tool.lifecycle) {
    summary.lifecycle = tool.lifecycle;
    if (tool.lifecycle.deprecated) summary.deprecated = true;
  }
  if (includeConfiguration) {
    summary.configuration = tool;
  }
  if (includeSchema) {
    summary.schema = tool.input;
  }
  return summary;
}

export function normalizeOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function normalizeLimit(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}
