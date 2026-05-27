// src/renderer/src/lib/custom-commands.ts
// Re-export from shared for backward compatibility

export type {
  CustomProjectCommand,
  PromptLintFinding,
  ValidationResult
} from '@shared/lib/custom-commands'
export {
  CUSTOM_COMMAND_EXAMPLES,
  PROJECT_PLACEHOLDERS,
  lintPromptBraces,
  mergeCustomCommands,
  replaceTemplateVariables,
  validateCustomCommand
} from '@shared/lib/custom-commands'
