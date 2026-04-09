import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getImageMimeType } from '@shared/types/file-utils'

const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024 // 20MB

export function readFile(filePath: string): {
  success: boolean
  content?: string
  error?: string
} {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (!existsSync(filePath)) {
      return { success: false, error: 'File does not exist' }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: 'File too large (max 1MB)' }
    }
    const content = readFileSync(filePath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function readFileAsBase64(filePath: string): {
  success: boolean
  data?: string
  mimeType?: string
  error?: string
} {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (!existsSync(filePath)) {
      return { success: false, error: 'File does not exist' }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    if (stat.size > MAX_IMAGE_FILE_SIZE) {
      return { success: false, error: 'File too large (max 20MB)' }
    }
    const buffer = readFileSync(filePath)
    const data = buffer.toString('base64')
    const mimeType = getImageMimeType(filePath) ?? undefined
    return { success: true, data, mimeType }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function readPromptFile(promptName: string): {
  success: boolean
  content?: string
  error?: string
} {
  try {
    if (!promptName || typeof promptName !== 'string') {
      return { success: false, error: 'Invalid prompt name' }
    }
    const appPath = app.getAppPath()
    let promptPath = join(appPath, 'prompts', promptName)
    if (!existsSync(promptPath)) {
      const resourcesPath = join(appPath, '..', 'prompts', promptName)
      if (existsSync(resourcesPath)) {
        promptPath = resourcesPath
      } else {
        return { success: false, error: 'Prompt file not found' }
      }
    }
    const content = readFileSync(promptPath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function writeFile(filePath: string, content: string): { success: boolean; error?: string } {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (typeof content !== 'string') {
      return { success: false, error: 'Invalid content' }
    }
    if (!existsSync(filePath)) {
      return { success: false, error: 'File does not exist' }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
