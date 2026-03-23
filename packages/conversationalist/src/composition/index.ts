export type {
  ConditionalInstructionComposer,
  ConditionalInstructionComposerRenderOptions,
  ConditionalInstructionSection,
  InstructionContext,
} from './conditional-section';
export {
  createConditionalInstructionComposer,
  whenAnyToolAvailable,
  whenMetadata,
  whenMetadataPresent,
  whenStep,
  whenToolsAvailable,
} from './conditional-section';
export type {
  InstructionComposer,
  InstructionComposerRenderOptions,
  InstructionSection,
} from './instruction-composer';
export { createInstructionComposer } from './instruction-composer';
export type { InstructionTemplate, MissingVariableStrategy, TemplateOptions } from './template';
export { createInstructionTemplate, extractTemplateVariables, renderTemplate } from './template';
