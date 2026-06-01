// src/renderer/src/lib/custom-commands.ts
// Re-export from shared for backward compatibility

export type { CustomProjectCommand, ValidationResult } from '@shared/lib/custom-commands'
export { validateCustomCommand, replaceTemplateVariables } from '@shared/lib/custom-commands'
