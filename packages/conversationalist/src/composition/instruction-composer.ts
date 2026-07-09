import type { MessageInput } from '../types';
import { renderTemplate, type TemplateOptions } from './template';

export interface InstructionSection {
  name: string;
  content: string;
  priority?: number;
  /**
   * Marks this section as a prompt-cache boundary when rendered into a
   * conversation via {@link sectionsToMessageInputs}: everything up to and
   * including this section is a stable prefix a provider can cache. See
   * `MessageInput.cacheBoundary`.
   */
  cacheBoundary?: boolean;
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

/**
 * Options for {@link sectionsToMessageInputs}.
 */
export interface SectionsToMessageInputsOptions {
  variables?: Record<string, string>;
  templateOptions?: TemplateOptions;
}

/**
 * Renders a composer's sections into an ordered array of `system`-role
 * {@link MessageInput}s — one per section, in priority order — instead of
 * collapsing them into a single joined string. This is the structured
 * prompt-assembly path: each segment (shared contract, guidelines, task
 * context, diff, agent role, ...) stays individually addressable in the
 * resulting conversation, and a section's `cacheBoundary` carries through to
 * its message so the stable prefix survives into the provider adapters.
 *
 * Rendering is a pure function of the composer's sections and the supplied
 * variables — sections sort deterministically (stable sort by priority, ties
 * broken by insertion order) and template substitution has no hidden state,
 * so two assemblies of the same composer with the same variables produce
 * byte-identical output.
 */
export function sectionsToMessageInputs(
  composer: InstructionComposer,
  options?: SectionsToMessageInputsOptions,
): MessageInput[] {
  const variables = options?.variables;
  const templateOptions = options?.templateOptions;

  return sortedSections(composer.sections()).map((section) => {
    const content = variables
      ? renderTemplate(section.content, variables, templateOptions)
      : section.content;

    return {
      role: 'system' as const,
      content,
      ...(section.cacheBoundary ? { cacheBoundary: true as const } : {}),
    };
  });
}

function sortedSections(sections: readonly InstructionSection[]): InstructionSection[] {
  return [...sections].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}
