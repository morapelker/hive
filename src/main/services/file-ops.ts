import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
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

export function createFile(
  directoryPath: string,
  fileName: string,
  content: string,
  overwrite: boolean
): { success: boolean; error?: string; code?: string } {
  try {
    if (!directoryPath || typeof directoryPath !== 'string') {
      return { success: false, error: 'Invalid directory path', code: 'DirectoryNotFound' }
    }
    if (typeof content !== 'string') {
      return { success: false, error: 'Invalid content', code: 'InvalidContent' }
    }
    if (
      !fileName ||
      typeof fileName !== 'string' ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName === '.' ||
      fileName === '..'
    ) {
      return { success: false, error: 'Invalid file name', code: 'InvalidFileName' }
    }
    if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
      return { success: false, error: 'Directory does not exist', code: 'DirectoryNotFound' }
    }
    const filePath = join(directoryPath, fileName)
    if (existsSync(filePath)) {
      if (statSync(filePath).isDirectory()) {
        return {
          success: false,
          error: 'A directory with this name exists',
          code: 'InvalidFileName'
        }
      }
      if (!overwrite) {
        return { success: false, error: 'File already exists', code: 'FileAlreadyExists' }
      }
    }
    writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
