import type { z } from 'zod';

import type { ToolRepairHint, ToolValidationReport } from '../is-tool';
import { getDiagnosticsSchema } from './diagnostics';
import type { ErrorInput } from './result-handlers';

export function createDiagnostics(
  input: Pick<ErrorInput, 'diagnostics' | 'schema' | 'toolCall'>,
  error: z.ZodError,
): { report?: ToolValidationReport; repairHints?: ToolRepairHint[] } {
  const reportState = diagnosticsReport(input, error);
  const repairHints = reportState.repairHints ?? fallbackRepairHints(input, error);
  return {
    ...(reportState.report !== undefined ? { report: reportState.report } : {}),
    ...(repairHints !== undefined ? { repairHints } : {}),
  };
}

function diagnosticsReport(
  input: Pick<ErrorInput, 'diagnostics' | 'schema' | 'toolCall'>,
  error: z.ZodError,
): { report?: ToolValidationReport; repairHints?: ToolRepairHint[] } {
  if (!input.diagnostics?.safeParseWithReport) return {};
  try {
    const diagnosticsSchema = getDiagnosticsSchema(input.schema);
    const diagnosticsResult = input.diagnostics.safeParseWithReport(
      diagnosticsSchema,
      input.toolCall.arguments,
    );
    return {
      report: diagnosticsResult.report,
      ...(input.diagnostics.createRepairHints
        ? {
            repairHints: input.diagnostics.createRepairHints(
              diagnosticsResult.success ? error : diagnosticsResult.error,
              { rootLabel: 'arguments' },
            ),
          }
        : {}),
    };
  } catch {
    return {};
  }
}

function fallbackRepairHints(
  input: Pick<ErrorInput, 'diagnostics'>,
  error: z.ZodError,
): ToolRepairHint[] | undefined {
  if (!input.diagnostics?.createRepairHints) return undefined;
  try {
    return input.diagnostics.createRepairHints(error, { rootLabel: 'arguments' });
  } catch {
    return undefined;
  }
}
