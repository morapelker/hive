// src/main/services/custom-commands-file-service.ts

import { dirname } from 'path'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import {
  validateCustomCommand,
  type CustomProjectCommand
} from '@shared/lib/custom-commands'
import { getHiveCustomCommandsFile } from './hive-paths'

/**
 * Gets the full path to custom commands file
 * @returns Path to ~/.hive/custom-commands.json
 */
export function getCustomCommandsFilePath(): string {
  return getHiveCustomCommandsFile()
}

/**
 * Gets the modification time of the custom commands file
 * @returns Modification time in milliseconds, or null if file doesn't exist
 */
export function getFileModTime(): number | null {
  const filePath = getCustomCommandsFilePath()
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const stats = statSync(filePath)
    return stats.mtimeMs
  } catch {
    return null
  }
}

const TEMPLATE_COMMANDS = [
  {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Analyze Architecture',
    prompt:
      'Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements.'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440001',
    name: 'Review Dependencies',
    prompt:
      'Review all dependencies in the {{project.language}} project at {{project.path}}. Check for outdated packages and security issues.'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002',
    name: 'Generate Tests',
    prompt:
      'Generate comprehensive test coverage for {{project.name}}. Focus on {{project.description}}.'
  }
]

export interface CustomCommandFileResult {
  success: boolean
  commands?: CustomProjectCommand[]
  error?: string
  mtime?: number | null
}

export interface SaveCustomCommandFileResult {
  success: boolean
  error?: string
  mtime?: number | null
}

/**
 * Creates a template file with example commands
 * @returns Result object with success, created flags and optional error message
 */
export function createTemplateFile(): { success: boolean; created: boolean; error?: string } {
  const filePath = getCustomCommandsFilePath()

  if (existsSync(filePath)) {
    return { success: true, created: false }
  }

  try {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const content = JSON.stringify(TEMPLATE_COMMANDS, null, 2)
    writeFileSync(filePath, content, 'utf-8')

    return { success: true, created: true }
  } catch (error) {
    return {
      success: false,
      created: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Saves custom commands to the file config path.
 * Settings UI writes through this so later file-to-database sync does not
 * restore stale commands after the user saved an empty list.
 */
export function saveCustomCommandsToFile(
  commands: CustomProjectCommand[]
): SaveCustomCommandFileResult {
  const filePath = getCustomCommandsFilePath()

  try {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const validCommands: CustomProjectCommand[] = []
    for (const command of commands) {
      const validation = validateCustomCommand(command)
      if (validation.valid) {
        validCommands.push(command)
      } else {
        console.warn('Skipped invalid command while saving file:', validation.errors)
      }
    }

    writeFileSync(filePath, JSON.stringify(validCommands, null, 2), 'utf-8')

    return {
      success: true,
      mtime: getFileModTime()
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error writing file'
    }
  }
}

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

/**
 * Loads and validates custom commands from the custom commands file
 * @returns Result object with commands array, mtime, and success/error status
 */
export function loadCustomCommandsFromFile(): CustomCommandFileResult {
  const filePath = getCustomCommandsFilePath()

  // File doesn't exist - not an error, just return empty
  if (!existsSync(filePath)) {
    return { success: true, commands: [], mtime: null }
  }

  try {
    // Check file size
    const stats = statSync(filePath)
    if (stats.size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: 'Custom commands file too large (max 1MB)'
      }
    }

    // Read and parse file
    const content = readFileSync(filePath, 'utf-8')
    let parsed: unknown

    try {
      parsed = JSON.parse(content)
    } catch {
      return {
        success: false,
        error: 'Invalid JSON in custom commands file'
      }
    }

    // Validate root is array
    if (!Array.isArray(parsed)) {
      return {
        success: false,
        error: 'Custom commands file must contain a JSON array'
      }
    }

    // Validate and filter commands
    const validCommands: CustomProjectCommand[] = []
    for (const item of parsed) {
      const validation = validateCustomCommand(item)
      if (validation.valid) {
        validCommands.push(item as CustomProjectCommand)
      } else {
        console.warn('Skipped invalid command in file:', validation.errors)
      }
    }

    return {
      success: true,
      commands: validCommands,
      mtime: stats.mtimeMs
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error reading file'
    }
  }
}
