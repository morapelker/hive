// src/shared/lib/custom-commands.ts

import type { Project } from '@shared/types/project'

/**
 * Custom command definition for project context menu
 */
export interface CustomProjectCommand {
  id: string
  name: string
  prompt: string
}

/**
 * Validation result for custom command
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validates a custom command object
 *
 * @param command - Command object to validate
 * @returns ValidationResult with valid flag and error messages
 */
export function validateCustomCommand(command: unknown): ValidationResult {
  const errors: string[] = []

  // Check if command is an object (not null)
  if (typeof command !== 'object' || command === null) {
    return { valid: false, errors: ['Command must be an object'] }
  }

  const cmd = command as Record<string, unknown>

  // Validate id
  if (typeof cmd.id !== 'string' || cmd.id.trim() === '') {
    errors.push('id must be a non-empty string')
  }

  // Validate name
  if (typeof cmd.name !== 'string' || cmd.name.trim() === '') {
    errors.push('name must be a non-empty string')
  }

  // Validate prompt
  if (typeof cmd.prompt !== 'string' || cmd.prompt.trim() === '') {
    errors.push('prompt must be a non-empty string')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Replaces template variables in a prompt string with project data
 *
 * Supported variables:
 * - {{project.name}} - Project name
 * - {{project.path}} - Full filesystem path
 * - {{project.id}} - Project UUID
 * - {{project.language}} - Programming language (fallback: "unknown")
 * - {{project.description}} - Project description (fallback: "")
 * - {{project.tags}} - Project tags (fallback: "")
 *
 * @param template - Prompt string with {{variable}} placeholders
 * @param project - Project object with data to inject
 * @returns Rendered prompt string with variables replaced
 */
export function replaceTemplateVariables(template: string, project: Project): string {
  return template
    .replace(/\{\{project\.name\}\}/g, project.name)
    .replace(/\{\{project\.path\}\}/g, project.path)
    .replace(/\{\{project\.id\}\}/g, project.id)
    .replace(/\{\{project\.language\}\}/g, project.language || 'unknown')
    .replace(/\{\{project\.description\}\}/g, project.description || '')
    .replace(/\{\{project\.tags\}\}/g, project.tags || '')
}
