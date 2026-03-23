import { renderTemplate, type TemplateOptions } from './template';

export interface InstructionSection {
  name: string;
  content: string;
  priority?: number;
}

export interface InstructionComposerRenderOptions {
  variables?: Record<string, string>;
  separator?: string;
  templateOptions?: TemplateOptions;
}

export interface InstructionComposer {
  section(section: InstructionSection): InstructionComposer;
  removeSection(name: string): InstructionComposer;
  sectionNames(): readonly string[];
  hasSection(name: string): boolean;
  sections(): readonly InstructionSection[];
  render(options?: InstructionComposerRenderOptions): string;
}

export function createInstructionComposer(
  ...initialSections: InstructionSection[]
): InstructionComposer {
  return buildComposer(deduplicateSections(initialSections));
}

function deduplicateSections(sections: readonly InstructionSection[]): InstructionSection[] {
  const map = new Map<string, InstructionSection>();
  for (const section of sections) {
    map.set(section.name, section);
  }
  return [...map.values()];
}

function buildComposer(currentSections: InstructionSection[]): InstructionComposer {
  return {
    section(section: InstructionSection): InstructionComposer {
      const existing = currentSections.filter((s) => s.name !== section.name);
      return buildComposer([...existing, section]);
    },

    removeSection(name: string): InstructionComposer {
      return buildComposer(currentSections.filter((s) => s.name !== name));
    },

    sectionNames(): readonly string[] {
      return sortedSections(currentSections).map((s) => s.name);
    },

    hasSection(name: string): boolean {
      return currentSections.some((s) => s.name === name);
    },

    sections(): readonly InstructionSection[] {
      return [...currentSections];
    },

    render(options?: InstructionComposerRenderOptions): string {
      const separator = options?.separator ?? '\n\n';
      const variables = options?.variables;
      const templateOptions = options?.templateOptions;

      const sorted = sortedSections(currentSections);

      const rendered = sorted.map((section) => {
        if (variables) {
          return renderTemplate(section.content, variables, templateOptions);
        }
        return section.content;
      });

      return rendered.join(separator);
    },
  };
}

function sortedSections(sections: readonly InstructionSection[]): InstructionSection[] {
  return [...sections].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}
