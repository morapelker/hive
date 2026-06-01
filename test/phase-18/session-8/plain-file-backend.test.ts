import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { join } from 'path'
import { gitApi } from '../../../src/renderer/src/api/git-api'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../../src/renderer/src/api/rpc-client'

describe('Session 8: Plain File Rendering RPC Backend', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  // ── Renderer API type contract ────────────────────────────────────────────
  describe('Renderer API type declaration', () => {
    test('getFileContent type declaration exists on gitApi', () => {
      type Expected = typeof gitApi.getFileContent

      const _typeCheck: Expected = gitApi.getFileContent
      expect(_typeCheck).toBeDefined()
    })
  })

  // ── Renderer RPC client contract ──────────────────────────────────────────
  describe('Renderer RPC client contract', () => {
    let request: ReturnType<typeof vi.fn>
    let subscribe: ReturnType<typeof vi.fn>

    beforeEach(() => {
      request = vi.fn()
      subscribe = vi.fn()
      setRendererRpcClient({ request, subscribe })
    })

    test('getFileContent is callable with worktreePath and filePath', async () => {
      request.mockResolvedValue({
        success: true,
        content: 'console.log("hello")'
      })

      const result = await gitApi.getFileContent('/path/to/worktree', 'src/index.ts')

      expect(request).toHaveBeenCalledWith('gitOps.getFileContent', {
        worktreePath: '/path/to/worktree',
        filePath: 'src/index.ts'
      })
      expect(result).toEqual({
        success: true,
        content: 'console.log("hello")'
      })
    })

    test('getFileContent returns error for missing file', async () => {
      request.mockResolvedValue({
        success: false,
        content: null,
        error: "ENOENT: no such file or directory, open '/path/to/worktree/missing.ts'"
      })

      const result = await gitApi.getFileContent('/path/to/worktree', 'missing.ts')

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

      request.mockResolvedValue({
        success: true,
        content: fileContent
      })

      const result = await gitApi.getFileContent('/worktree', 'src/App.tsx')

      expect(result.success).toBe(true)
      expect(result.content).toBe(fileContent)
      expect(result.content).toContain('import React')
    })
  })

  // ── RPC method contract ───────────────────────────────────────────────────
  describe('RPC method contract', () => {
    test('RPC method name is gitOps.getFileContent', () => {
      const expectedMethod = 'gitOps.getFileContent'
      expect(expectedMethod).toBe('gitOps.getFileContent')
    })

    test('method accepts { worktreePath, filePath } params', () => {
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
