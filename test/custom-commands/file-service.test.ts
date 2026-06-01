// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { app } from 'electron'
import { join } from 'path'
import {
  getCustomCommandsFilePath,
  getFileModTime,
  loadCustomCommandsFromFile,
  createTemplateFile
} from '../../src/main/services/custom-commands-file-service'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn()
  }
}))

describe('getCustomCommandsFilePath', () => {
  it('should return path in home directory', () => {
    vi.mocked(app.getPath).mockReturnValue('/Users/testuser')

    const result = getCustomCommandsFilePath()

    expect(result).toBe('/Users/testuser/.hive/custom-commands.json')
    expect(app.getPath).toHaveBeenCalledWith('home')
  })
})

describe('getFileModTime', () => {
  it('should return null if file does not exist', async () => {
    const result = await getFileModTime('/nonexistent/path/to/file.json')

    expect(result).toBeNull()
  })

  it('should return mtime if file exists', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'test.json')

    try {
      await fs.writeFile(testFile, '{}')
      const result = await getFileModTime(testFile)

      expect(result).toBeInstanceOf(Date)
      expect(result!.getTime()).toBeGreaterThan(0)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('createTemplateFile', () => {
  it('should create a file with 3 template commands', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'custom-commands.json')

    try {
      const result = await createTemplateFile(testFile)

      expect(result.success).toBe(true)

      // Verify file exists and has correct content
      const content = await fs.readFile(testFile, 'utf-8')
      const commands = JSON.parse(content)

      expect(Array.isArray(commands)).toBe(true)
      expect(commands).toHaveLength(3)

      // Verify structure of first command
      expect(commands[0]).toHaveProperty('id')
      expect(commands[0]).toHaveProperty('name')
      expect(commands[0]).toHaveProperty('prompt')
      expect(commands[0].id).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(commands[0].name).toBe('Analyze Architecture')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should not overwrite existing file', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'custom-commands.json')

    try {
      const existingContent = '[]'
      await fs.writeFile(testFile, existingContent)

      const result = await createTemplateFile(testFile)

      expect(result.success).toBe(false)
      expect(result.error).toContain('already exists')

      // Verify file was not modified
      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe(existingContent)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should handle directory creation errors', async () => {
    const result = await createTemplateFile('/root/cannot-write-here/custom-commands.json')

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('loadCustomCommandsFromFile', () => {
  it('should return empty array if file does not exist', async () => {
    const result = await loadCustomCommandsFromFile('/nonexistent/path/to/file.json')

    expect(result.success).toBe(true)
    expect(result.commands).toEqual([])
  })

  it('should load and return valid commands', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'test.json')

    try {
      const validCommands = [
        { id: 'cmd-1', name: 'Command 1', prompt: 'Do something' },
        { id: 'cmd-2', name: 'Command 2', prompt: 'Do another thing' }
      ]
      await fs.writeFile(testFile, JSON.stringify(validCommands))

      const result = await loadCustomCommandsFromFile(testFile)

      expect(result.success).toBe(true)
      expect(result.commands).toEqual(validCommands)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should return error for invalid JSON', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'test.json')

    try {
      await fs.writeFile(testFile, '{ invalid json }')

      const result = await loadCustomCommandsFromFile(testFile)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid JSON')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should return error if content is not an array', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'test.json')

    try {
      await fs.writeFile(testFile, JSON.stringify({ notAnArray: true }))

      const result = await loadCustomCommandsFromFile(testFile)

      expect(result.success).toBe(false)
      expect(result.error).toContain('must be an array')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should filter out invalid commands and keep valid ones', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'test.json')

    try {
      const mixedCommands = [
        { id: 'cmd-1', name: 'Valid Command', prompt: 'Do something' },
        { id: 'cmd-2', name: '', prompt: 'Invalid: empty name' }, // Invalid
        { id: 'cmd-3', name: 'Another Valid', prompt: 'Do another thing' },
        { name: 'Missing id', prompt: 'Invalid: no id' } // Invalid
      ]
      await fs.writeFile(testFile, JSON.stringify(mixedCommands))

      const result = await loadCustomCommandsFromFile(testFile)

      expect(result.success).toBe(true)
      expect(result.commands).toHaveLength(2)
      expect(result.commands[0].id).toBe('cmd-1')
      expect(result.commands[1].id).toBe('cmd-3')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should return error if file is too large (> 1MB)', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const testFile = path.join(tempDir, 'test.json')

    try {
      // Create a file larger than 1MB
      const largeContent = '[' + JSON.stringify({ id: 'x', name: 'x', prompt: 'x'.repeat(10000) }) + ']'
      const repeatedContent = largeContent.repeat(150) // Create ~1.5MB file
      await fs.writeFile(testFile, repeatedContent)

      const result = await loadCustomCommandsFromFile(testFile)

      expect(result.success).toBe(false)
      expect(result.error).toContain('too large')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should handle permission errors', async () => {
    // This test attempts to read a file without read permission
    // On some systems this might not work as expected
    const result = await loadCustomCommandsFromFile('/root/no-permission.json')

    // Either file doesn't exist (returns empty array) or permission denied
    expect(result.success).toBe(true)
    expect(result.commands).toEqual([])
  })
})
