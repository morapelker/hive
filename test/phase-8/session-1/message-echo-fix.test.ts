import { describe, test, expect, beforeEach, vi } from 'vitest'

// Mock the database module before importing the service
const mockGetSessionMessageByOpenCodeId = vi.fn().mockReturnValue(null)
const mockUpsertSessionMessageByOpenCodeId = vi.fn()

vi.mock('../../../src/main/db', () => ({
  getDatabase: () => ({
    getSessionMessageByOpenCodeId: mockGetSessionMessageByOpenCodeId,
    upsertSessionMessageByOpenCodeId: mockUpsertSessionMessageByOpenCodeId
  })
}))

// Mock the logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock the notification service
vi.mock('../../../src/main/services/notification-service', () => ({
  notificationService: {
    showSessionComplete: vi.fn()
  }
}))

// Import service after mocks are set up
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let service: any

beforeEach(async () => {
  vi.clearAllMocks()
  // Re-import to get a fresh singleton for each test
  const mod = await import('../../../src/main/services/opencode-service')
  service = mod.openCodeService
})

describe('Session 1: Message Echo Fix', () => {
  describe('extractEventMessageRole', () => {
    test('extracts role from message.role path', () => {
      const role = service.extractEventMessageRole({ message: { role: 'user' } })
      expect(role).toBe('user')
    })

    test('extracts role from info.role path', () => {
      const role = service.extractEventMessageRole({ info: { role: 'assistant' } })
      expect(role).toBe('assistant')
    })

    test('extracts role from part.role path', () => {
      const role = service.extractEventMessageRole({ part: { role: 'user' } })
      expect(role).toBe('user')
    })

    test('extracts role from direct role path', () => {
      const role = service.extractEventMessageRole({ role: 'assistant' })
      expect(role).toBe('assistant')
    })

    test('extracts role from nested properties.message path', () => {
      const role = service.extractEventMessageRole({
        properties: { message: { role: 'assistant' } }
      })
      expect(role).toBe('assistant')
    })

    test('extracts role from nested properties.info path', () => {
      const role = service.extractEventMessageRole({
        properties: { info: { role: 'user' } }
      })
      expect(role).toBe('user')
    })

    test('extracts role from nested properties.part path', () => {
      const role = service.extractEventMessageRole({
        properties: { part: { role: 'assistant' } }
      })
      expect(role).toBe('assistant')
    })

    test('extracts role from nested properties.role path', () => {
      const role = service.extractEventMessageRole({
        properties: { role: 'user' }
      })
      expect(role).toBe('user')
    })

    test('extracts role from metadata.role path', () => {
      const role = service.extractEventMessageRole({ metadata: { role: 'assistant' } })
      expect(role).toBe('assistant')
    })

    test('extracts role from content.role path', () => {
      const role = service.extractEventMessageRole({ content: { role: 'user' } })
      expect(role).toBe('user')
    })

    test('returns undefined when role not found', () => {
      const role = service.extractEventMessageRole({ foo: 'bar' })
      expect(role).toBeUndefined()
    })

    test('returns undefined for empty object', () => {
      const role = service.extractEventMessageRole({})
      expect(role).toBeUndefined()
    })

    test('first valid path wins', () => {
      const role = service.extractEventMessageRole({
        message: { role: 'user' },
        info: { role: 'assistant' }
      })
      expect(role).toBe('user')
    })

    test('falls through to later paths when earlier are missing', () => {
      const role = service.extractEventMessageRole({
        message: {},
        info: {},
        metadata: { role: 'assistant' }
      })
      expect(role).toBe('assistant')
    })
  })

  describe('persistStreamEvent role guards', () => {
    const hiveSessionId = 'hive-session-123'
    const messageId = 'msg-001'

    test('message.part.updated with role=assistant is persisted', () => {
      const eventData = {
        message: { role: 'assistant', id: messageId },
        part: { type: 'text', text: 'Hello', id: 'part-1' },
        delta: 'Hello'
      }

      service.persistStreamEvent(hiveSessionId, 'message.part.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledTimes(1)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: hiveSessionId,
          role: 'assistant',
          opencode_message_id: messageId
        })
      )
    })

    test('message.part.updated with role=user is NOT persisted', () => {
      const eventData = {
        message: { role: 'user', id: messageId },
        part: { type: 'text', text: 'Hello', id: 'part-1' },
        delta: 'Hello'
      }

      service.persistStreamEvent(hiveSessionId, 'message.part.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    })

    test('message.part.updated with undefined role IS persisted (SDK often omits role)', () => {
      const eventData = {
        message: { id: messageId },
        part: { type: 'text', text: 'Hello', id: 'part-1' },
        delta: 'Hello'
      }

      // The SDK often omits the role field on streaming payloads.
      // undefined role is treated as assistant (only explicit 'user' is skipped).
      service.persistStreamEvent(hiveSessionId, 'message.part.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledTimes(1)
    })

    test('message.updated with role=assistant is persisted', () => {
      const eventData = {
        message: { role: 'assistant', id: messageId },
        info: { sessionID: 'oc-123' }
      }

      service.persistStreamEvent(hiveSessionId, 'message.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledTimes(1)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: hiveSessionId,
          role: 'assistant',
          opencode_message_id: messageId
        })
      )
    })

    test('message.updated with role=user is NOT persisted', () => {
      const eventData = {
        message: { role: 'user', id: messageId },
        info: { sessionID: 'oc-123' }
      }

      service.persistStreamEvent(hiveSessionId, 'message.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    })

    test('message.updated with undefined role IS persisted (SDK often omits role)', () => {
      const eventData = {
        message: { id: messageId },
        info: { sessionID: 'oc-123' }
      }

      // The SDK often omits the role field on message.updated payloads.
      // undefined role is treated as assistant (only explicit 'user' is skipped).
      service.persistStreamEvent(hiveSessionId, 'message.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledTimes(1)
    })

    test('message.updated with role=system IS persisted (only user is skipped)', () => {
      const eventData = {
        role: 'system',
        message: { id: messageId }
      }

      // Only explicit 'user' role is skipped; other roles (system, undefined) are persisted.
      service.persistStreamEvent(hiveSessionId, 'message.updated', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).toHaveBeenCalledTimes(1)
    })

    test('unrelated event type is not persisted', () => {
      const eventData = {
        message: { role: 'assistant', id: messageId }
      }

      service.persistStreamEvent(hiveSessionId, 'session.idle', eventData)
      expect(mockUpsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    })
  })
})
