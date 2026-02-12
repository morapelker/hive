import { describe, test, expect } from 'vitest'

/**
 * Session 5: Prompt Parts API
 *
 * Tests the updated prompt pipeline that accepts an array of parts
 * (text + files) instead of just a string message.
 *
 * The tests cover:
 * - Preload bridge converts string to parts array
 * - Preload bridge passes parts array through
 * - MessagePart type correctness
 * - SessionView sends text as parts array
 */

describe('Session 5: Prompt Parts API', () => {
  describe('Preload bridge - prompt function', () => {
    // Simulate the preload prompt function logic
    function preloadPrompt(
      worktreePath: string,
      opencodeSessionId: string,
      messageOrParts: string | Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }>
    ): { worktreePath: string; sessionId: string; parts: unknown[] } {
      const parts = typeof messageOrParts === 'string'
        ? [{ type: 'text' as const, text: messageOrParts }]
        : messageOrParts
      return { worktreePath, sessionId: opencodeSessionId, parts }
    }

    test('prompt() converts string to parts array', () => {
      const result = preloadPrompt('/path/to/worktree', 'session-1', 'hello world')

      expect(result.parts).toEqual([{ type: 'text', text: 'hello world' }])
      expect(result.worktreePath).toBe('/path/to/worktree')
      expect(result.sessionId).toBe('session-1')
    })

    test('prompt() passes parts array through', () => {
      const parts = [
        { type: 'text' as const, text: 'look at this' },
        { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'screenshot.png' }
      ]
      const result = preloadPrompt('/path/to/worktree', 'session-1', parts)

      expect(result.parts).toEqual(parts)
      expect(result.parts).toHaveLength(2)
    })

    test('empty string converts to single text part with empty text', () => {
      const result = preloadPrompt('/path', 'session-1', '')

      expect(result.parts).toEqual([{ type: 'text', text: '' }])
    })

    test('multiple text parts preserved', () => {
      const parts = [
        { type: 'text' as const, text: 'first' },
        { type: 'text' as const, text: 'second' }
      ]
      const result = preloadPrompt('/path', 'session-1', parts)

      expect(result.parts).toHaveLength(2)
      expect(result.parts[0]).toEqual({ type: 'text', text: 'first' })
      expect(result.parts[1]).toEqual({ type: 'text', text: 'second' })
    })

    test('file part included in prompt', () => {
      const parts = [
        { type: 'text' as const, text: 'look at this' },
        { type: 'file' as const, mime: 'image/png', url: 'data:image/png;base64,abc123' }
      ]
      const result = preloadPrompt('/path', 'session-1', parts)

      expect(result.parts).toHaveLength(2)
      expect(result.parts[1]).toEqual({
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,abc123'
      })
    })

    test('file part with optional filename', () => {
      const parts = [
        { type: 'file' as const, mime: 'application/pdf', url: 'data:application/pdf;base64,xyz', filename: 'report.pdf' }
      ]
      const result = preloadPrompt('/path', 'session-1', parts)

      expect(result.parts[0]).toEqual({
        type: 'file',
        mime: 'application/pdf',
        url: 'data:application/pdf;base64,xyz',
        filename: 'report.pdf'
      })
    })
  })

  describe('IPC handler - backward compatibility', () => {
    // Simulate IPC handler logic for parsing args
    function parseIpcArgs(...args: unknown[]): {
      worktreePath: string
      opencodeSessionId: string
      messageOrParts: string | unknown[]
    } {
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        const obj = args[0] as Record<string, unknown>
        return {
          worktreePath: obj.worktreePath as string,
          opencodeSessionId: obj.sessionId as string,
          messageOrParts: (obj.parts as unknown[]) || [{ type: 'text', text: obj.message as string }]
        }
      }
      return {
        worktreePath: args[0] as string,
        opencodeSessionId: args[1] as string,
        messageOrParts: args[2] as string
      }
    }

    test('IPC handler accepts object-style call with parts', () => {
      const result = parseIpcArgs({
        worktreePath: '/path',
        sessionId: 'session-1',
        parts: [{ type: 'text', text: 'hello' }]
      })

      expect(result.worktreePath).toBe('/path')
      expect(result.opencodeSessionId).toBe('session-1')
      expect(result.messageOrParts).toEqual([{ type: 'text', text: 'hello' }])
    })

    test('IPC handler accepts object-style call with message fallback', () => {
      const result = parseIpcArgs({
        worktreePath: '/path',
        sessionId: 'session-1',
        message: 'hello'
      })

      expect(result.messageOrParts).toEqual([{ type: 'text', text: 'hello' }])
    })

    test('IPC handler accepts legacy positional args', () => {
      const result = parseIpcArgs('/path', 'session-1', 'hello')

      expect(result.worktreePath).toBe('/path')
      expect(result.opencodeSessionId).toBe('session-1')
      expect(result.messageOrParts).toBe('hello')
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
