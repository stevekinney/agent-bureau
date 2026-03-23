const TEMPLATE_VARIABLE_REGEX = /\{\{(\s*[\w.]+\s*)\}\}/g;

export type MissingVariableStrategy = 'throw' | 'preserve' | 'empty';

export interface TemplateOptions {
  missingVariableStrategy?: MissingVariableStrategy;
}

export interface InstructionTemplate {
  readonly source: string;
  render(variables: Record<string, string>): string;
  variables(): ReadonlySet<string>;
}

export function extractTemplateVariables(source: string): ReadonlySet<string> {
  const variables = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(TEMPLATE_VARIABLE_REGEX.source, 'g');
  while ((match = regex.exec(source)) !== null) {
    variables.add(match[1]!.trim());
  }
  return variables;
}

export function renderTemplate(
  source: string,
  variables: Record<string, string>,
  options?: TemplateOptions,
): string {
  const strategy = options?.missingVariableStrategy ?? 'throw';

  return source.replace(TEMPLATE_VARIABLE_REGEX, (original, rawKey: string) => {
    const key = rawKey.trim();
    if (key in variables) {
      return variables[key]!;
    }

    switch (strategy) {
      case 'throw':
        throw new Error(`Missing template variable: "${key}"`);
      case 'preserve':
        return original;
      case 'empty':
        return '';
    }
  });
}

export function createInstructionTemplate(
  source: string,
  options?: TemplateOptions,
): InstructionTemplate {
  const vars = extractTemplateVariables(source);

  return {
    source,
    render(variables: Record<string, string>): string {
      return renderTemplate(source, variables, options);
    },
    variables(): ReadonlySet<string> {
      return vars;
    },
  };
}
