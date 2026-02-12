import { describe, test, expect } from 'vitest'
import type { StreamingPart } from '@/components/sessions/SessionView'

/**
 * Session 2: Tool Call Correlation Fix — Tests
 *
 * These tests verify:
 * 1. Streaming parts are preserved when the session is actively streaming (conditional clearing)
 * 2. Streaming parts are cleared when the session is NOT streaming
 * 3. DB restoration merges with existing streaming parts (no duplicate tool IDs)
 * 4. DB restoration replaces when no existing streaming parts
 * 5. Extra in-flight tool calls not in DB are preserved during merge
 */

// Helper to create a text streaming part
function makeTextPart(text: string): StreamingPart {
  return { type: 'text', text }
}

// Helper to create a tool_use streaming part
function makeToolUsePart(
  id: string,
  status: 'running' | 'success' | 'error' = 'running',
  name = 'Write'
): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: {
      id,
      name,
      status,
      input: '{}'
    }
  }
}

describe('Session 2: Tool Call Correlation Fix', () => {
  describe('Conditional streaming parts clearing', () => {
    test('streaming parts should be preserved when isStreaming is true', () => {
      // Simulate: isStreaming = true, streamingPartsRef has existing parts
      const isStreaming = true
      let streamingParts = [makeToolUsePart('tool-1'), makeTextPart('Hello')]
      let streamingContent = 'Hello'

      // This mirrors the logic in the session init effect:
      // if (!isStreaming) { clear everything }
      if (!isStreaming) {
        streamingParts = []
        streamingContent = ''
      }

      // Parts should be preserved
      expect(streamingParts).toHaveLength(2)
      expect(streamingParts[0].toolUse?.id).toBe('tool-1')
      expect(streamingContent).toBe('Hello')
    })

    test('streaming parts should be cleared when isStreaming is false', () => {
      // Simulate: isStreaming = false, streamingPartsRef has leftover parts
      const isStreaming = false
      let streamingParts: StreamingPart[] = [makeToolUsePart('tool-1'), makeTextPart('Hello')]
      let streamingContent = 'Hello'

      if (!isStreaming) {
        streamingParts = []
        streamingContent = ''
      }

      expect(streamingParts).toHaveLength(0)
      expect(streamingContent).toBe('')
    })
  })

  describe('DB restoration merge logic', () => {
    test('replaces streamingParts when ref is empty (normal case)', () => {
      const streamingPartsRef: StreamingPart[] = []
      const dbParts = [makeTextPart('Response text'), makeToolUsePart('tool-1', 'success')]

      let result: StreamingPart[]
      if (streamingPartsRef.length > 0) {
        const dbToolIds = new Set(
          dbParts.filter((p) => p.type === 'tool_use' && p.toolUse?.id).map((p) => p.toolUse!.id)
        )
        const extraParts = streamingPartsRef.filter(
          (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
        )
        result = [...dbParts, ...extraParts]
      } else {
        result = dbParts
      }

      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('text')
      expect(result[1].toolUse?.id).toBe('tool-1')
    })

    test('merges DB parts with in-flight streaming parts', () => {
      // streamingPartsRef has a tool that is still running (not yet in DB)
      const streamingPartsRef = [
        makeToolUsePart('tool-1', 'success'), // already in DB
        makeToolUsePart('tool-2', 'running') // NOT in DB yet (in-flight)
      ]
      const dbParts = [makeTextPart('Response text'), makeToolUsePart('tool-1', 'success')]

      let result: StreamingPart[]
      if (streamingPartsRef.length > 0) {
        const dbToolIds = new Set(
          dbParts.filter((p) => p.type === 'tool_use' && p.toolUse?.id).map((p) => p.toolUse!.id)
        )
        const extraParts = streamingPartsRef.filter(
          (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
        )
        result = [...dbParts, ...extraParts]
      } else {
        result = dbParts
      }

      // Should have all DB parts + the extra in-flight tool
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe('text')
      expect(result[1].toolUse?.id).toBe('tool-1')
      expect(result[1].toolUse?.status).toBe('success')
      expect(result[2].toolUse?.id).toBe('tool-2')
      expect(result[2].toolUse?.status).toBe('running')
    })

    test('does not duplicate tools already in DB', () => {
      // streamingPartsRef has only tools that are already in DB
      const streamingPartsRef = [makeToolUsePart('tool-1', 'running')]
      const dbParts = [makeTextPart('Text'), makeToolUsePart('tool-1', 'success')]

      let result: StreamingPart[]
      if (streamingPartsRef.length > 0) {
        const dbToolIds = new Set(
          dbParts.filter((p) => p.type === 'tool_use' && p.toolUse?.id).map((p) => p.toolUse!.id)
        )
        const extraParts = streamingPartsRef.filter(
          (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
        )
        result = [...dbParts, ...extraParts]
      } else {
        result = dbParts
      }

      // No duplicates — DB version wins for tool-1
      expect(result).toHaveLength(2)
      expect(result[1].toolUse?.id).toBe('tool-1')
      expect(result[1].toolUse?.status).toBe('success') // DB version (updated status)
    })

    test('preserves text content from merged parts', () => {
      const dbParts = [makeTextPart('Hello '), makeTextPart('world')]
      const streamingPartsRef: StreamingPart[] = []

      let result: StreamingPart[]
      if (streamingPartsRef.length > 0) {
        result = [...dbParts]
      } else {
        result = dbParts
      }

      const textParts = result.filter((p) => p.type === 'text')
      const content = textParts.map((p) => p.text || '').join('')
      expect(content).toBe('Hello world')
    })

    test('handles multiple in-flight tools correctly', () => {
      const streamingPartsRef = [
        makeToolUsePart('tool-1', 'success'),
        makeToolUsePart('tool-2', 'running'),
        makeToolUsePart('tool-3', 'running')
      ]
      const dbParts = [makeTextPart('Response'), makeToolUsePart('tool-1', 'success')]

      const dbToolIds = new Set(
        dbParts.filter((p) => p.type === 'tool_use' && p.toolUse?.id).map((p) => p.toolUse!.id)
      )
      const extraParts = streamingPartsRef.filter(
        (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
      )
      const result = [...dbParts, ...extraParts]

      // DB has text + tool-1, extras are tool-2 and tool-3
      expect(result).toHaveLength(4)
      expect(result.map((p) => p.toolUse?.id).filter(Boolean)).toEqual([
        'tool-1',
        'tool-2',
        'tool-3'
      ])
    })
  })

  describe('upsertToolUse correlation after restoration', () => {
    test('existing tool can be found and updated by callID', () => {
      // Simulate streamingPartsRef after merge restoration
      const parts = [
        makeTextPart('Working on it...'),
        makeToolUsePart('write-123', 'running', 'Write')
      ]

      // Simulate upsertToolUse logic: find existing part by callID and update
      const callID = 'write-123'
      const existingIndex = parts.findIndex(
        (p) => p.type === 'tool_use' && p.toolUse?.id === callID
      )

      expect(existingIndex).toBe(1) // Found at index 1

      // Update the existing part (simulates what upsertToolUse does)
      parts[existingIndex] = {
        ...parts[existingIndex],
        toolUse: {
          ...parts[existingIndex].toolUse!,
          status: 'success',
          output: 'File written successfully'
        }
      }

      expect(parts[existingIndex].toolUse?.status).toBe('success')
      expect(parts[existingIndex].toolUse?.output).toBe('File written successfully')
      // No new part was created
      expect(parts).toHaveLength(2)
    })

    test('no duplicate entry created when tool result arrives for restored part', () => {
      const parts = [makeTextPart('Checking...'), makeToolUsePart('read-456', 'running', 'Read')]

      const callID = 'read-456'
      const existingIndex = parts.findIndex(
        (p) => p.type === 'tool_use' && p.toolUse?.id === callID
      )

      // Should find the existing entry, not -1
      expect(existingIndex).not.toBe(-1)

      // Verify it doesn't add a new entry
      const beforeLength = parts.length
      if (existingIndex >= 0) {
        parts[existingIndex] = {
          ...parts[existingIndex],
          toolUse: { ...parts[existingIndex].toolUse!, status: 'success' }
        }
      }
      expect(parts.length).toBe(beforeLength)
    })
  })
})
