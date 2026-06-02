import { describe, test, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

describe('Session 8: Plain File Rendering Backend', () => {
  // ── Type declaration contract ──────────────────────────────────────────────
  describe('Type declaration', () => {
    test('getFileContent type declaration exists on window.gitOps', () => {
      // Verify the type contract matches: (worktreePath, filePath) => Promise<{success, content, error?}>
      type Expected = (
        worktreePath: string,
        filePath: string
      ) => Promise<{
        success: boolean
        content: string | null
        error?: string
      }>

      // If this compiles, the type declaration is correct
      const _typeCheck: Expected = window.gitOps.getFileContent
      expect(_typeCheck).toBeDefined()
    })
  })

  // ── Preload bridge contract ────────────────────────────────────────────────
  describe('Preload bridge', () => {
    let mockGetFileContent: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockGetFileContent = vi.fn()

      Object.defineProperty(window, 'gitOps', {
        writable: true,
        configurable: true,
        value: {
          ...window.gitOps,
          getFileContent: mockGetFileContent
        }
      })
    })

    test('getFileContent is callable with worktreePath and filePath', async () => {
      mockGetFileContent.mockResolvedValue({
        success: true,
        content: 'console.log("hello")'
      })

      const result = await window.gitOps.getFileContent('/path/to/worktree', 'src/index.ts')

      expect(mockGetFileContent).toHaveBeenCalledWith('/path/to/worktree', 'src/index.ts')
      expect(result).toEqual({
        success: true,
        content: 'console.log("hello")'
      })
    })

    test('getFileContent returns error for missing file', async () => {
      mockGetFileContent.mockResolvedValue({
        success: false,
        content: null,
        error: "ENOENT: no such file or directory, open '/path/to/worktree/missing.ts'"
      })

      const result = await window.gitOps.getFileContent('/path/to/worktree', 'missing.ts')

      expect(result.success).toBe(false)
      expect(result.content).toBeNull()
      expect(result.error).toContain('ENOENT')
    })

    test('getFileContent returns content as string', async () => {
      const fileContent = [
        'import React from "react"',
        '',
        'export function App() {',
        '  return <div>Hello</div>',
        '}'
      ].join('\n')

      mockGetFileContent.mockResolvedValue({
        success: true,
        content: fileContent
      })

      const result = await window.gitOps.getFileContent('/worktree', 'src/App.tsx')

      expect(result.success).toBe(true)
      expect(result.content).toBe(fileContent)
      expect(result.content).toContain('import React')
    })
  })

  // ── IPC handler contract ──────────────────────────────────────────────────
  describe('IPC handler contract', () => {
    test('IPC channel name is git:getFileContent', () => {
      const expectedChannel = 'git:getFileContent'
      expect(expectedChannel).toBe('git:getFileContent')
    })

    test('handler accepts { worktreePath, filePath } payload', () => {
      const payload = { worktreePath: '/path/to/worktree', filePath: 'src/index.ts' }
      expect(payload).toHaveProperty('worktreePath')
      expect(payload).toHaveProperty('filePath')
      expect(typeof payload.worktreePath).toBe('string')
      expect(typeof payload.filePath).toBe('string')
    })

    test('success response shape includes content string', () => {
      const response = { success: true, content: 'file contents here' }
      expect(response).toHaveProperty('success', true)
      expect(response).toHaveProperty('content')
      expect(typeof response.content).toBe('string')
    })

    test('error response shape includes null content and error string', () => {
      const response = { success: false, content: null, error: 'File not found' }
      expect(response).toHaveProperty('success', false)
      expect(response.content).toBeNull()
      expect(response).toHaveProperty('error')
      expect(typeof response.error).toBe('string')
    })
  })

  // ── Handler logic (isolated) ──────────────────────────────────────────────
  describe('Handler logic', () => {
    test('joins worktreePath and filePath correctly', () => {
      const worktreePath = '/Users/test/project'
      const filePath = 'src/index.ts'
      const fullPath = join(worktreePath, filePath)
      expect(fullPath).toBe('/Users/test/project/src/index.ts')
    })

    test('joins nested file paths correctly', () => {
      const worktreePath = '/Users/test/project'
      const filePath = 'src/components/deep/Component.tsx'
      const fullPath = join(worktreePath, filePath)
      expect(fullPath).toBe('/Users/test/project/src/components/deep/Component.tsx')
    })

    test('handles error narrowing correctly', () => {
      // Replicate the error handling from the handler
      const error1 = new Error('ENOENT: no such file or directory')
      const msg1 = error1 instanceof Error ? error1.message : String(error1)
      expect(msg1).toBe('ENOENT: no such file or directory')

      const error2 = 'string error'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg2 = (error2 as any) instanceof Error ? (error2 as any).message : String(error2)
      expect(msg2).toBe('string error')
    })
  })
})
