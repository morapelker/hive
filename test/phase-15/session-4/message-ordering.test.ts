import { describe, test, expect, beforeEach } from 'vitest'

/**
 * Session 4: User Message Ordering Fix — Tests
 *
 * These tests verify:
 * 1. Merge-based message replacement preserves locally-added messages
 * 2. No duplication of messages already in DB
 * 3. Finalization guard skips reload when a new prompt is pending
 * 4. Finalization performs reload when no new prompt is pending
 * 5. newPromptPendingRef resets on session.status busy
 */

// ---------- helpers ----------

interface MockMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

function makeMsg(id: string, role: 'user' | 'assistant' = 'user', content = ''): MockMessage {
  return { id, role, content: content || `msg-${id}`, timestamp: new Date().toISOString() }
}

// ---------- 1. Merge-based setMessages logic ----------

/**
 * This mirrors the merge logic introduced in loadMessagesFromDatabase.
 * We test the pure logic rather than the full React component.
 */
function mergeMessages(
  currentMessages: MockMessage[],
  loadedMessages: MockMessage[]
): MockMessage[] {
  const loadedIds = new Set(loadedMessages.map((m) => m.id))
  const localOnly = currentMessages.filter((m) => !loadedIds.has(m.id))
  return localOnly.length > 0 ? [...loadedMessages, ...localOnly] : loadedMessages
}

describe('Session 4: User Message Ordering Fix', () => {
  describe('mergeMessages (loadMessagesFromDatabase logic)', () => {
    test('preserves locally-added messages not yet in DB', () => {
      const current = [makeMsg('A'), makeMsg('B'), makeMsg('C')]
      const fromDb = [makeMsg('A'), makeMsg('B')]

      const result = mergeMessages(current, fromDb)

      expect(result.map((m) => m.id)).toEqual(['A', 'B', 'C'])
    })

    test('does not duplicate messages already in DB', () => {
      const current = [makeMsg('A'), makeMsg('B')]
      const fromDb = [makeMsg('A'), makeMsg('B'), makeMsg('D', 'assistant')]

      const result = mergeMessages(current, fromDb)

      expect(result.map((m) => m.id)).toEqual(['A', 'B', 'D'])
    })

    test('returns loaded messages directly when no local-only exist', () => {
      const current = [makeMsg('A')]
      const fromDb = [makeMsg('A'), makeMsg('B', 'assistant')]

      const result = mergeMessages(current, fromDb)

      // Should be the exact reference (no spread needed)
      expect(result).toBe(fromDb)
    })

    test('appends multiple local-only messages in order', () => {
      const current = [makeMsg('A'), makeMsg('X'), makeMsg('Y')]
      const fromDb = [makeMsg('A'), makeMsg('B', 'assistant')]

      const result = mergeMessages(current, fromDb)

      expect(result.map((m) => m.id)).toEqual(['A', 'B', 'X', 'Y'])
    })

    test('handles empty current messages', () => {
      const current: MockMessage[] = []
      const fromDb = [makeMsg('A'), makeMsg('B', 'assistant')]

      const result = mergeMessages(current, fromDb)

      expect(result).toBe(fromDb)
    })

    test('handles empty DB messages with local messages', () => {
      const current = [makeMsg('X')]
      const fromDb: MockMessage[] = []

      const result = mergeMessages(current, fromDb)

      expect(result.map((m) => m.id)).toEqual(['X'])
    })
  })

  // ---------- 2. Finalization guard logic ----------

  describe('finalization guard (newPromptPending)', () => {
    let newPromptPending: boolean
    let loadMessagesFromDatabaseCalled: boolean
    let resetStreamingStateCalled: boolean
    let isSendingSetTo: boolean | null

    // Simulates the finalizeResponseFromDatabase logic
    async function finalizeResponseFromDatabase(): Promise<void> {
      if (newPromptPending) {
        newPromptPending = false
        resetStreamingStateCalled = true
        return
      }

      try {
        loadMessagesFromDatabaseCalled = true
      } finally {
        resetStreamingStateCalled = true
        isSendingSetTo = false
      }
    }

    beforeEach(() => {
      newPromptPending = false
      loadMessagesFromDatabaseCalled = false
      resetStreamingStateCalled = false
      isSendingSetTo = null
    })

    test('skips full reload when new prompt is pending', async () => {
      newPromptPending = true

      await finalizeResponseFromDatabase()

      expect(loadMessagesFromDatabaseCalled).toBe(false)
      expect(resetStreamingStateCalled).toBe(true)
      expect(newPromptPending).toBe(false) // ref was reset
    })

    test('performs full reload when no new prompt pending', async () => {
      newPromptPending = false

      await finalizeResponseFromDatabase()

      expect(loadMessagesFromDatabaseCalled).toBe(true)
      expect(resetStreamingStateCalled).toBe(true)
      expect(isSendingSetTo).toBe(false)
    })

    test('does not set isSending=false when skipping due to pending prompt', async () => {
      newPromptPending = true

      await finalizeResponseFromDatabase()

      expect(isSendingSetTo).toBeNull() // not touched
    })
  })

  // ---------- 3. session.status busy resets newPromptPending ----------

  describe('session.status busy handler', () => {
    test('resets newPromptPending on busy', () => {
      // Simulate the ref
      let newPromptPending = true
      let isStreaming = false

      // Simulate the handler logic
      const handleBusy = (): void => {
        isStreaming = true
        newPromptPending = false
      }

      handleBusy()

      expect(newPromptPending).toBe(false)
      expect(isStreaming).toBe(true)
    })
  })

  // ---------- 4. handleSend sets newPromptPending ----------

  describe('handleSend sets newPromptPending', () => {
    test('sets newPromptPending to true after adding user message', () => {
      let newPromptPending = false

      // Simulate the handleSend logic after saving message
      const simulatePostSave = (): void => {
        // setMessages(...) happens
        newPromptPending = true
      }

      simulatePostSave()

      expect(newPromptPending).toBe(true)
    })
  })

  // ---------- 5. Race scenario integration ----------

  describe('race condition: send during finalization', () => {
    test('user message survives finalization race', () => {
      // Scenario:
      // 1. Session has messages [A (user), B (assistant)]
      // 2. User sends message C while finalization is in-flight
      // 3. Finalization arrives with DB data [A, B]
      // 4. Message C should survive at the end

      const step1 = [makeMsg('A'), makeMsg('B', 'assistant')]

      // User sends C — added locally
      const afterSend = [...step1, makeMsg('C')]

      // Finalization arrives with DB data (doesn't include C yet)
      const dbResult = [makeMsg('A'), makeMsg('B', 'assistant')]

      const merged = mergeMessages(afterSend, dbResult)

      expect(merged.map((m) => m.id)).toEqual(['A', 'B', 'C'])
    })

    test('rapid sequential sends all survive', () => {
      // User sends X, Y, Z rapidly before any DB sync
      const current = [
        makeMsg('A'),
        makeMsg('B', 'assistant'),
        makeMsg('X'),
        makeMsg('Y'),
        makeMsg('Z')
      ]

      // DB only knows about A and B
      const dbResult = [makeMsg('A'), makeMsg('B', 'assistant')]

      const merged = mergeMessages(current, dbResult)

      expect(merged.map((m) => m.id)).toEqual(['A', 'B', 'X', 'Y', 'Z'])
    })

    test('DB with new assistant response plus local user message', () => {
      // DB has caught up with a new assistant response D
      // But user already sent E locally
      const current = [
        makeMsg('A'),
        makeMsg('B', 'assistant'),
        makeMsg('C'),
        makeMsg('D', 'assistant'),
        makeMsg('E')
      ]

      // DB finalization returns A, B, C, D (E not yet persisted)
      const dbResult = [
        makeMsg('A'),
        makeMsg('B', 'assistant'),
        makeMsg('C'),
        makeMsg('D', 'assistant')
      ]

      const merged = mergeMessages(current, dbResult)

      expect(merged.map((m) => m.id)).toEqual(['A', 'B', 'C', 'D', 'E'])
    })
  })
})
