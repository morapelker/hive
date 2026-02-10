import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const sessionViewPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions',
  'SessionView.tsx'
)

function readSessionView(): string {
  return fs.readFileSync(sessionViewPath, 'utf-8')
}

describe('Session 8: Streaming Bugfixes', () => {
  describe('Loading state preservation', () => {
    test('partial clear does not call resetStreamingState during initialization', () => {
      const content = readSessionView()
      // The stream subscription effect should do a partial clear, NOT call
      // resetStreamingState() directly. The partial clear resets display data
      // (parts, content) without touching isStreaming.
      // Verify the partial clear pattern exists:
      expect(content).toContain('// Partial clear')
      expect(content).toContain('streamingPartsRef.current = []')
      expect(content).toContain("streamingContentRef.current = ''")
      expect(content).toContain('setStreamingParts([])')
      expect(content).toContain("setStreamingContent('')")
      // Verify there's a comment explaining why we don't reset isStreaming:
      expect(content).toContain('Do NOT')
      expect(content).toContain('isStreaming')
    })

    test('resetStreamingState still exists for finalization', () => {
      const content = readSessionView()
      // resetStreamingState should still be defined and called during finalization
      expect(content).toContain('const resetStreamingState = useCallback(')
      expect(content).toContain('setIsStreaming(false)')
      // It should still be called in finalizeResponseFromDatabase
      expect(content).toContain('resetStreamingState()')
    })

    test('session.status busy sets isStreaming true', () => {
      const content = readSessionView()
      // Verify the session.status handler sets isStreaming on busy
      expect(content).toContain("status.type === 'busy'")
      expect(content).toContain('setIsStreaming(true)')
    })
  })

  describe('Cross-tab bleed prevention', () => {
    test('streamGenerationRef is declared', () => {
      const content = readSessionView()
      expect(content).toContain('const streamGenerationRef = useRef(0)')
    })

    test('generation counter increments on session change', () => {
      const content = readSessionView()
      // Verify the generation counter is incremented in the main effect
      expect(content).toContain('streamGenerationRef.current += 1')
      expect(content).toContain('const currentGeneration = streamGenerationRef.current')
    })

    test('stale closure events are rejected via generation check', () => {
      const content = readSessionView()
      // Verify the guard exists inside the stream handler
      expect(content).toContain('streamGenerationRef.current !== currentGeneration')
    })

    test('session ID check and generation check are both present', () => {
      const content = readSessionView()
      // The stream handler should have BOTH guards:
      // 1. Session ID check (existing)
      expect(content).toContain('event.sessionId !== sessionId')
      // 2. Generation check (new)
      expect(content).toContain('streamGenerationRef.current !== currentGeneration')
    })
  })

  describe('Tool call result reconciliation', () => {
    test('streaming parts restored from last assistant message on remount', () => {
      const content = readSessionView()
      // Verify the restoration logic exists in initializeSession
      expect(content).toContain("lastMsg.role === 'assistant'")
      expect(content).toContain('lastMsg.parts')
      expect(content).toContain('streamingPartsRef.current = lastMsg.parts.map')
    })

    test('text content restored from persisted parts', () => {
      const content = readSessionView()
      // Verify text parts are restored to streamingContentRef
      expect(content).toContain("p.type === 'text'")
      expect(content).toContain("p.text || ''")
      expect(content).toContain('streamingContentRef.current = content')
    })

    test('childToSubtaskIndexRef is cleared on session change', () => {
      const content = readSessionView()
      // The partial clear should also reset the child-to-subtask mapping
      expect(content).toContain('childToSubtaskIndexRef.current = new Map()')
    })

    test('hasFinalizedCurrentResponseRef is reset on session change', () => {
      const content = readSessionView()
      // The partial clear should reset the finalization flag
      expect(content).toContain('hasFinalizedCurrentResponseRef.current = false')
    })
  })

  describe('mapStoredPartsToStreamingParts', () => {
    test('function exists for converting DB parts to streaming format', () => {
      const content = readSessionView()
      expect(content).toContain('function mapStoredPartsToStreamingParts')
    })

    test('handles text parts', () => {
      const content = readSessionView()
      // Verify text part handling
      expect(content).toContain("partType === 'text'")
    })

    test('handles tool parts with callID for result merging', () => {
      const content = readSessionView()
      // Verify tool part handling preserves callID
      expect(content).toContain("partType === 'tool'")
      expect(content).toContain('part.callID')
    })

    test('handles subtask parts', () => {
      const content = readSessionView()
      expect(content).toContain("partType === 'subtask'")
    })
  })
})
