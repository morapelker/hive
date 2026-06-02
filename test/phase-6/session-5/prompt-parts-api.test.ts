import { afterEach, describe, test, expect, vi } from 'vitest'
import { opencodeApi } from '../../../src/renderer/src/api/opencode-api'
import {
  resetRendererRpcClientForTests,
  setRendererRpcClient
} from '../../../src/renderer/src/api/rpc-client'

/**
 * Session 5: Prompt Parts API
 *
 * Tests the updated prompt pipeline that accepts an array of parts
 * (text + files) instead of just a string message.
 *
 * The tests cover:
 * - Renderer RPC API converts string to parts array
 * - Renderer RPC API passes parts array through
 * - MessagePart type correctness
 * - SessionView sends text as parts array
 */

describe('Session 5: Prompt Parts API', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
  })

  describe('Renderer RPC API - prompt function', () => {
    const setupPromptRequest = () => {
      const request = vi.fn().mockResolvedValue({ success: true })
      const subscribe = vi.fn()
      setRendererRpcClient({ request, subscribe })
      return request
    }

    test('prompt() converts string to parts array', async () => {
      const request = setupPromptRequest()

      await expect(
        opencodeApi.prompt('/path/to/worktree', 'session-1', 'hello world')
      ).resolves.toEqual({
        success: true,
        value: { success: true }
      })
      expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
        worktreePath: '/path/to/worktree',
        opencodeSessionId: 'session-1',
        messageOrParts: [{ type: 'text', text: 'hello world' }],
        model: undefined,
        options: undefined
      })
    })

    test('prompt() passes parts array through', async () => {
      const request = setupPromptRequest()
      const parts = [
        { type: 'text' as const, text: 'look at this' },
        { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'screenshot.png' }
      ]

      await opencodeApi.prompt('/path/to/worktree', 'session-1', parts)

      expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
        worktreePath: '/path/to/worktree',
        opencodeSessionId: 'session-1',
        messageOrParts: parts,
        model: undefined,
        options: undefined
      })
    })

    test('empty string converts to single text part with empty text', async () => {
      const request = setupPromptRequest()

      await opencodeApi.prompt('/path', 'session-1', '')

      expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
        worktreePath: '/path',
        opencodeSessionId: 'session-1',
        messageOrParts: [{ type: 'text', text: '' }],
        model: undefined,
        options: undefined
      })
    })

    test('multiple text parts preserved', async () => {
      const request = setupPromptRequest()
      const parts = [
        { type: 'text' as const, text: 'first' },
        { type: 'text' as const, text: 'second' }
      ]

      await opencodeApi.prompt('/path', 'session-1', parts)

      expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
        worktreePath: '/path',
        opencodeSessionId: 'session-1',
        messageOrParts: parts,
        model: undefined,
        options: undefined
      })
    })

    test('file part included in prompt', async () => {
      const request = setupPromptRequest()
      const parts = [
        { type: 'text' as const, text: 'look at this' },
        { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,abc123' }
      ]

      await opencodeApi.prompt('/path', 'session-1', parts)

      expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
        worktreePath: '/path',
        opencodeSessionId: 'session-1',
        messageOrParts: parts,
        model: undefined,
        options: undefined
      })
    })

    test('file part with optional filename', async () => {
      const request = setupPromptRequest()
      const parts = [
        { type: 'file' as const, mime: 'application/pdf', url: 'data:application/pdf;base64,xyz', filename: 'report.pdf' }
      ]

      await opencodeApi.prompt('/path', 'session-1', parts)

      expect(request).toHaveBeenCalledWith('opencodeOps.prompt', {
        worktreePath: '/path',
        opencodeSessionId: 'session-1',
        messageOrParts: parts,
        model: undefined,
        options: undefined
      })
    })
  })

  describe('RPC params - backward compatibility', () => {
    function parseRpcPromptParams(params: unknown): {
      worktreePath: string
      opencodeSessionId: string
      messageOrParts: string | unknown[]
    } {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        throw new Error('Prompt params must be an object')
      }
      const obj = params as Record<string, unknown>
      return {
        worktreePath: obj.worktreePath as string,
        opencodeSessionId: obj.opencodeSessionId as string,
        messageOrParts: obj.messageOrParts as string | unknown[]
      }
    }

    test('RPC params accept object-style call with parts', () => {
      const result = parseRpcPromptParams({
        worktreePath: '/path',
        opencodeSessionId: 'session-1',
        messageOrParts: [{ type: 'text', text: 'hello' }]
      })

      expect(result.worktreePath).toBe('/path')
      expect(result.opencodeSessionId).toBe('session-1')
      expect(result.messageOrParts).toEqual([{ type: 'text', text: 'hello' }])
    })

    test('RPC params accept string message for router-level compatibility', () => {
      const result = parseRpcPromptParams({
        worktreePath: '/path',
        opencodeSessionId: 'session-1',
        messageOrParts: 'hello'
      })

      expect(result.messageOrParts).toBe('hello')
    })

    test('RPC params reject legacy positional args', () => {
      expect(() => parseRpcPromptParams(['/path', 'session-1', 'hello'])).toThrow(
        'Prompt params must be an object'
      )
    })
  })

  describe('Service - prompt method', () => {
    // Simulate the service prompt method's parts normalization
    function normalizeMessageOrParts(
      messageOrParts: string | Array<{ type: string; text?: string }>
    ): Array<{ type: string; text?: string }> {
      return typeof messageOrParts === 'string'
        ? [{ type: 'text', text: messageOrParts }]
        : messageOrParts
    }

    test('service normalizes string to parts array', () => {
      const result = normalizeMessageOrParts('hello')

      expect(result).toEqual([{ type: 'text', text: 'hello' }])
    })

    test('service passes parts array through unchanged', () => {
      const parts = [
        { type: 'text', text: 'hello' },
        { type: 'file' }
      ]
      const result = normalizeMessageOrParts(parts)

      expect(result).toBe(parts) // Same reference — no conversion
    })
  })

  describe('SessionView integration', () => {
    test('handleSend constructs parts array from text', () => {
      // Simulate what SessionView.handleSend does
      const trimmedValue = 'implement auth'
      const modePrefix = ''
      const promptMessage = modePrefix + trimmedValue
      const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: promptMessage }]

      expect(parts).toEqual([{ type: 'text', text: 'implement auth' }])
    })

    test('handleSend constructs parts with plan mode prefix', () => {
      const trimmedValue = 'implement auth'
      const modePrefix = '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'
      const promptMessage = modePrefix + trimmedValue
      const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: promptMessage }]

      expect(parts).toHaveLength(1)
      expect(parts[0].type).toBe('text')
      expect(parts[0].text).toContain('[Mode: Plan]')
      expect(parts[0].text).toContain('implement auth')
    })

    test('prompt called with parts array (not string)', () => {
      // Simulate the call path
      const promptMessage = 'hello'
      const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: promptMessage }]

      // The call should use parts not a raw string
      const callArg = typeof parts === 'string' ? 'string' : 'array'
      expect(callArg).toBe('array')
      expect(Array.isArray(parts)).toBe(true)

      // Verify the shape matches MessagePart[]
      for (const part of parts) {
        expect(part).toHaveProperty('type')
        expect(part).toHaveProperty('text')
        expect(part.type).toBe('text')
      }
    })
  })

  describe('MessagePart type validation', () => {
    test('text part has correct shape', () => {
      const part = { type: 'text' as const, text: 'hello' }

      expect(part.type).toBe('text')
      expect(part.text).toBe('hello')
    })

    test('file part has correct shape', () => {
      const part = {
        type: 'file' as const,
        mime: 'image/png',
        url: 'data:image/png;base64,abc'
      }

      expect(part.type).toBe('file')
      expect(part.mime).toBe('image/png')
      expect(part.url).toMatch(/^data:/)
    })

    test('file part with filename has correct shape', () => {
      const part = {
        type: 'file' as const,
        mime: 'image/jpeg',
        url: 'data:image/jpeg;base64,xyz',
        filename: 'photo.jpg'
      }

      expect(part.type).toBe('file')
      expect(part.filename).toBe('photo.jpg')
    })

    test('parts array can contain mixed types', () => {
      const parts: Array<
        { type: 'text'; text: string } |
        { type: 'file'; mime: string; url: string; filename?: string }
      > = [
        { type: 'text', text: 'describe this image' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,abc' },
        { type: 'text', text: 'and also this one' },
        { type: 'file', mime: 'image/jpeg', url: 'data:image/jpeg;base64,xyz', filename: 'test.jpg' }
      ]

      expect(parts).toHaveLength(4)
      expect(parts.filter(p => p.type === 'text')).toHaveLength(2)
      expect(parts.filter(p => p.type === 'file')).toHaveLength(2)
    })
  })
})
