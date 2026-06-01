// src/main/services/custom-commands-file-service.ts

import { app } from 'electron'
import { join, dirname } from 'path'
import { stat, writeFile, mkdir, access, readFile } from 'fs/promises'
import { constants } from 'fs'
import {
  validateCustomCommand,
  type CustomProjectCommand
} from '../../renderer/src/lib/custom-commands'

/**
 * Gets the full path to custom commands file
 * @returns Path to ~/.hive/custom-commands.json
 */
export function getCustomCommandsFilePath(): string {
  const homeDir = app.getPath('home')
  return join(homeDir, '.hive', 'custom-commands.json')
}

/**
 * Gets the modification time of a file
 * @param filePath - Path to the file
 * @returns Date of last modification, or null if file doesn't exist
 */
export async function getFileModTime(filePath: string): Promise<Date | null> {
  try {
    const stats = await stat(filePath)
    return stats.mtime
  } catch (error) {
    // File doesn't exist or can't be accessed
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

export interface FileOperationResult {
  success: boolean
  error?: string
}

export interface LoadCommandsResult {
  success: boolean
  commands: CustomProjectCommand[]
  error?: string
}

/**
 * Creates a template file with example commands
 * @param filePath - Path where the template file should be created
 * @returns Result object with success flag and optional error message
 */
export async function createTemplateFile(filePath: string): Promise<FileOperationResult> {
  try {
    // Check if file already exists
    try {
      await access(filePath, constants.F_OK)
      return {
        success: false,
        error: 'File already exists'
      }
    } catch {
      // File doesn't exist, proceed
    }

    // Ensure directory exists
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true })

    // Write template file
    const content = JSON.stringify(TEMPLATE_COMMANDS, null, 2)
    await writeFile(filePath, content, 'utf-8')

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

/**
 * Loads and validates custom commands from a file
 * @param filePath - Path to the commands file
 * @returns Result object with commands array and success/error status
 */
export async function loadCustomCommandsFromFile(
  filePath: string
): Promise<LoadCommandsResult> {
  try {
    // Check if file exists
    const stats = await stat(filePath)

    // Check file size
    if (stats.size > MAX_FILE_SIZE) {
      return {
        success: false,
        commands: [],
        error: 'File is too large (maximum 1MB)'
      }
    }

    // Read file content
    const content = await readFile(filePath, 'utf-8')

    // Parse JSON
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return {
        success: false,
        commands: [],
        error: 'Invalid JSON format'
      }
    }

    // Validate that content is an array
    if (!Array.isArray(parsed)) {
      return {
        success: false,
        commands: [],
        error: 'File content must be an array of commands'
      }
    }

    // Filter and validate commands
    const validCommands: CustomProjectCommand[] = []
    for (const item of parsed) {
      const validation = validateCustomCommand(item)
      if (validation.valid) {
        validCommands.push(item as CustomProjectCommand)
      }
    }

    return {
      success: true,
      commands: validCommands
    }
  } catch (error) {
    // File doesn't exist or can't be read - return empty array
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: true,
        commands: []
      }
    }

    // Other errors
    return {
      success: false,
      commands: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
