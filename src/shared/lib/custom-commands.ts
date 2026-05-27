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

export interface PromptLintFinding {
  from: number
  to: number
  message: string
}

export const PROJECT_PLACEHOLDERS: ReadonlyArray<{ token: string; description: string }> = [
  { token: '{{project.name}}', description: 'Project name' },
  { token: '{{project.path}}', description: 'Project filesystem path' },
  { token: '{{project.id}}', description: 'Project ID' },
  { token: '{{project.language}}', description: 'Project language' },
  { token: '{{project.description}}', description: 'Project description' },
  { token: '{{project.tags}}', description: 'Project tags' }
]

export const CUSTOM_COMMAND_EXAMPLES: ReadonlyArray<Pick<CustomProjectCommand, 'name' | 'prompt'>> =
  [
    {
      name: 'Analyze Architecture',
      prompt:
        'Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements.'
    },
    {
      name: 'Review Dependencies',
      prompt:
        'Review all dependencies in the {{project.language}} project at {{project.path}}. Check for outdated packages and security issues.'
    },
    {
      name: 'Generate Tests',
      prompt:
        'Generate comprehensive test coverage for {{project.name}}. Focus on {{project.description}}.'
    }
  ]

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

function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Merge global and project commands by normalized name.
 * Global commands establish ordering; project commands replace colliding global
 * commands and append any project-only commands after the global list.
 */
export function mergeCustomCommands(
  global: CustomProjectCommand[],
  project: CustomProjectCommand[]
): CustomProjectCommand[] {
  const commandsByName = new Map<string, CustomProjectCommand>()

  for (const command of global) {
    commandsByName.set(normalizeCommandName(command.name), command)
  }
  for (const command of project) {
    commandsByName.set(normalizeCommandName(command.name), command)
  }

  return Array.from(commandsByName.values())
}

/**
 * Lint prompt template braces. Unknown placeholders are allowed; only unmatched
 * opening and closing delimiter pairs are reported.
 */
export function lintPromptBraces(text: string): PromptLintFinding[] {
  const openings: number[] = []
  const findings: PromptLintFinding[] = []

  for (let index = 0; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2)
    if (pair === '{{') {
      openings.push(index)
      index++
      continue
    }
    if (pair === '}}') {
      const opening = openings.pop()
      if (opening === undefined) {
        findings.push({
          from: index,
          to: index + 2,
          message: 'Unexpected }} without matching {{'
        })
      }
      index++
    }
  }

  for (const opening of openings) {
    findings.push({
      from: opening,
      to: opening + 2,
      message: 'Unclosed {{ placeholder'
    })
  }

  return findings
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
 * Uses replacer callbacks to avoid $ escape sequences in project data being
 * interpreted as replacement tokens (e.g., $1, $&).
 *
 * @param template - Prompt string with {{variable}} placeholders
 * @param project - Project object with data to inject
 * @returns Rendered prompt string with variables replaced
 */
export function replaceTemplateVariables(template: string, project: Project): string {
  return template
    .replace(/\{\{project\.name\}\}/g, () => project.name)
    .replace(/\{\{project\.path\}\}/g, () => project.path)
    .replace(/\{\{project\.id\}\}/g, () => project.id)
    .replace(/\{\{project\.language\}\}/g, () => project.language || 'unknown')
    .replace(/\{\{project\.description\}\}/g, () => project.description || '')
    .replace(/\{\{project\.tags\}\}/g, () => project.tags || '')
}
