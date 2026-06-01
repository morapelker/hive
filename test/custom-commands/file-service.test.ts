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
  it('should return null if file does not exist', () => {
    vi.mocked(app.getPath).mockReturnValue('/nonexistent')

    const result = getFileModTime()

    expect(result).toBeNull()
  })

  it('should return mtime in milliseconds if file exists', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      await fs.writeFile(testFile, '{}')
      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = getFileModTime()

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThan(0)
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
    const hiveDir = path.join(tempDir, '.hive')
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = createTemplateFile()

      expect(result.success).toBe(true)
      expect(result.created).toBe(true)

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

  it('should return success with created=false when file exists', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      const existingContent = '[]'
      await fs.writeFile(testFile, existingContent)

      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = createTemplateFile()

      expect(result.success).toBe(true)
      expect(result.created).toBe(false)
      expect(result.error).toBeUndefined()

      // Verify file was not modified
      const content = await fs.readFile(testFile, 'utf-8')
      expect(content).toBe(existingContent)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should handle directory creation errors', () => {
    vi.mocked(app.getPath).mockReturnValue('/root/cannot-write-here')

    const result = createTemplateFile()

    expect(result.success).toBe(false)
    expect(result.created).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('loadCustomCommandsFromFile', () => {
  it('should return empty array with mtime null if file does not exist', () => {
    vi.mocked(app.getPath).mockReturnValue('/nonexistent')

    const result = loadCustomCommandsFromFile()

    expect(result.success).toBe(true)
    expect(result.commands).toEqual([])
    expect(result.mtime).toBeNull()
  })

  it('should load and return valid commands with mtime', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      const validCommands = [
        { id: 'cmd-1', name: 'Command 1', prompt: 'Do something' },
        { id: 'cmd-2', name: 'Command 2', prompt: 'Do another thing' }
      ]
      await fs.writeFile(testFile, JSON.stringify(validCommands))

      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = loadCustomCommandsFromFile()

      expect(result.success).toBe(true)
      expect(result.commands).toEqual(validCommands)
      expect(typeof result.mtime).toBe('number')
      expect(result.mtime).toBeGreaterThan(0)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should return error for invalid JSON', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      await fs.writeFile(testFile, '{ invalid json }')

      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = loadCustomCommandsFromFile()

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
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      await fs.writeFile(testFile, JSON.stringify({ notAnArray: true }))

      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = loadCustomCommandsFromFile()

      expect(result.success).toBe(false)
      expect(result.error).toContain('must contain a JSON array')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should filter out invalid commands and keep valid ones', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      const mixedCommands = [
        { id: 'cmd-1', name: 'Valid Command', prompt: 'Do something' },
        { id: 'cmd-2', name: '', prompt: 'Invalid: empty name' }, // Invalid
        { id: 'cmd-3', name: 'Another Valid', prompt: 'Do another thing' },
        { name: 'Missing id', prompt: 'Invalid: no id' } // Invalid
      ]
      await fs.writeFile(testFile, JSON.stringify(mixedCommands))

      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = loadCustomCommandsFromFile()

      expect(result.success).toBe(true)
      expect(result.commands).toHaveLength(2)
      expect(result.commands![0].id).toBe('cmd-1')
      expect(result.commands![1].id).toBe('cmd-3')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should return error if file is too large (> 1MB)', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-commands-test-'))
    const hiveDir = path.join(tempDir, '.hive')
    await fs.mkdir(hiveDir, { recursive: true })
    const testFile = path.join(hiveDir, 'custom-commands.json')

    try {
      // Create a file larger than 1MB
      const largeContent = '[' + JSON.stringify({ id: 'x', name: 'x', prompt: 'x'.repeat(10000) }) + ']'
      const repeatedContent = largeContent.repeat(150) // Create ~1.5MB file
      await fs.writeFile(testFile, repeatedContent)

      vi.mocked(app.getPath).mockReturnValue(tempDir)

      const result = loadCustomCommandsFromFile()

      expect(result.success).toBe(false)
      expect(result.error).toContain('too large')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('should return empty array if file does not exist in home directory', () => {
    vi.mocked(app.getPath).mockReturnValue('/some/nonexistent/path')

    const result = loadCustomCommandsFromFile()

    // Either file doesn't exist (returns empty array)
    expect(result.success).toBe(true)
    expect(result.commands).toEqual([])
    expect(result.mtime).toBeNull()
  })
})
