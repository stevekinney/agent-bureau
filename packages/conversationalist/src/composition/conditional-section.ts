import {
  createInstructionComposer,
  type InstructionComposer,
  type InstructionComposerRenderOptions,
  type InstructionSection,
} from './instruction-composer';

export interface InstructionContext {
  toolNames?: readonly string[];
  step?: number;
  metadata?: Record<string, unknown>;
}

export interface ConditionalInstructionSection extends InstructionSection {
  when: (context: InstructionContext) => boolean;
}

export interface ConditionalInstructionComposerRenderOptions extends InstructionComposerRenderOptions {
  context?: InstructionContext;
}

export interface ConditionalInstructionComposer {
  section(section: InstructionSection): ConditionalInstructionComposer;
  conditionalSection(section: ConditionalInstructionSection): ConditionalInstructionComposer;
  removeSection(name: string): ConditionalInstructionComposer;
  sectionNames(context?: InstructionContext): readonly string[];
  hasSection(name: string): boolean;
  sections(): readonly (InstructionSection | ConditionalInstructionSection)[];
  resolve(context?: InstructionContext): InstructionComposer;
  render(options?: ConditionalInstructionComposerRenderOptions): string;
}

function isConditional(
  section: InstructionSection | ConditionalInstructionSection,
): section is ConditionalInstructionSection {
  return 'when' in section && typeof section.when === 'function';
}

function filterSections(
  allSections: readonly (InstructionSection | ConditionalInstructionSection)[],
  context: InstructionContext,
): InstructionSection[] {
  return allSections.filter((section) => {
    if (isConditional(section)) {
      return section.when(context);
    }
    return true;
  });
}

export function createConditionalInstructionComposer(
  ...initialSections: (InstructionSection | ConditionalInstructionSection)[]
): ConditionalInstructionComposer {
  return buildConditionalComposer(deduplicateSections(initialSections));
}

function deduplicateSections(
  sections: readonly (InstructionSection | ConditionalInstructionSection)[],
): (InstructionSection | ConditionalInstructionSection)[] {
  const map = new Map<string, InstructionSection | ConditionalInstructionSection>();
  for (const section of sections) {
    map.set(section.name, section);
  }
  return [...map.values()];
}

function buildConditionalComposer(
  currentSections: (InstructionSection | ConditionalInstructionSection)[],
): ConditionalInstructionComposer {
  return {
    section(section: InstructionSection): ConditionalInstructionComposer {
      const existing = currentSections.filter((s) => s.name !== section.name);
      return buildConditionalComposer([...existing, section]);
    },

    conditionalSection(section: ConditionalInstructionSection): ConditionalInstructionComposer {
      const existing = currentSections.filter((s) => s.name !== section.name);
      return buildConditionalComposer([...existing, section]);
    },

    removeSection(name: string): ConditionalInstructionComposer {
      return buildConditionalComposer(currentSections.filter((s) => s.name !== name));
    },

    sectionNames(context?: InstructionContext): readonly string[] {
      if (context) {
        const filtered = filterSections(currentSections, context);
        return sortedSections(filtered).map((s) => s.name);
      }
      return sortedSections(currentSections).map((s) => s.name);
    },

    hasSection(name: string): boolean {
      return currentSections.some((s) => s.name === name);
    },

    sections(): readonly (InstructionSection | ConditionalInstructionSection)[] {
      return [...currentSections];
    },

    resolve(context?: InstructionContext): InstructionComposer {
      const filtered = filterSections(currentSections, context ?? {});
      return createInstructionComposer(...filtered);
    },

    render(options?: ConditionalInstructionComposerRenderOptions): string {
      const context = options?.context ?? {};
      const resolved = this.resolve(context);
      return resolved.render(options);
    },
  };
}

function sortedSections(
  sections: readonly (InstructionSection | ConditionalInstructionSection)[],
): (InstructionSection | ConditionalInstructionSection)[] {
  return [...sections].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

// Predicate factories

export function whenToolsAvailable(...names: string[]) {
  return (context: InstructionContext): boolean => {
    if (!context.toolNames) return false;
    return names.every((name) => context.toolNames!.includes(name));
  };
}

export function whenAnyToolAvailable(...names: string[]) {
  return (context: InstructionContext): boolean => {
    if (!context.toolNames) return false;
    return names.some((name) => context.toolNames!.includes(name));
  };
}

export function whenStep(predicate: (step: number) => boolean) {
  return (context: InstructionContext): boolean => {
    if (context.step === undefined) return false;
    return predicate(context.step);
  };
}

export function whenMetadata(key: string, value: unknown) {
  return (context: InstructionContext): boolean => {
    if (!context.metadata) return false;
    return context.metadata[key] === value;
  };
}

export function whenMetadataPresent(key: string) {
  return (context: InstructionContext): boolean => {
    if (!context.metadata) return false;
    return key in context.metadata;
  };
}
