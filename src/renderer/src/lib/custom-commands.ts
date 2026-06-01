// src/renderer/src/lib/custom-commands.ts

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
