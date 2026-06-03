import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { OpenCodeStreamEvent } from '../../../src/shared/types/opencode'

const mockDb = {
  getSessionMessageByOpenCodeId: vi.fn(),
  upsertSessionMessageByOpenCodeId: vi.fn(),
  updateSession: vi.fn(),
  getWorktreeBySessionId: vi.fn(),
  updateWorktree: vi.fn(),
  getSession: vi.fn(),
  getProject: vi.fn()
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.1.10'),
    isPackaged: false
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  }
}))

vi.mock('../../../src/main/desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

vi.mock('../../../src/main/db', () => ({
  getDatabase: () => mockDb
}))

import { openCodeService } from '../../../src/main/services/opencode-service'
import { agentEventBus } from '../../../src/main/services/agent-event-bus'

describe('Session 9: OpenCode session routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.getSessionMessageByOpenCodeId.mockReturnValue(null)
    mockDb.getWorktreeBySessionId.mockReturnValue(null)
  })

  test('routes event to correct hive session when opencode session IDs collide across directories', async () => {
    const events: OpenCodeStreamEvent[] = []
    const unsubscribe = agentEventBus.subscribe((event) => events.push(event))

    const instance = {
      client: {
        session: {
          get: vi.fn().mockResolvedValue({ data: {} })
        }
      },
      server: { url: 'http://localhost', close: vi.fn() },
      sessionMap: new Map<string, string>([
        ['/repo/a::opc-session-1', 'hive-session-a'],
        ['/repo/b::opc-session-1', 'hive-session-b']
      ]),
      sessionDirectories: new Map<string, string>(),
      directorySubscriptions: new Map(),
      childToParentMap: new Map<string, string>()
    }

    try {
      await (
        openCodeService as never as {
          handleEvent: (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            instance: any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rawEvent: any,
            directory?: string
          ) => Promise<void>
        }
      ).handleEvent(
        instance,
        {
          data: {
            type: 'session.idle',
            properties: {
              sessionID: 'opc-session-1'
            }
          }
        },
        '/repo/a'
      )
    } finally {
      unsubscribe()
    }

    expect(events).toContainEqual(
      expect.objectContaining({ sessionId: 'hive-session-a', type: 'session.idle' })
    )
  })

  test('routes message.updated without touching DB transcript persistence', async () => {
    const events: OpenCodeStreamEvent[] = []
    const unsubscribe = agentEventBus.subscribe((event) => events.push(event))

    const instance = {
      client: {
        session: {
          get: vi.fn().mockResolvedValue({ data: {} })
        }
      },
      server: { url: 'http://localhost', close: vi.fn() },
      sessionMap: new Map<string, string>([
        ['/repo/a::opc-session-1', 'hive-session-a'],
        ['/repo/b::opc-session-1', 'hive-session-b']
      ]),
      sessionDirectories: new Map<string, string>(),
      directorySubscriptions: new Map(),
      childToParentMap: new Map<string, string>()
    }

    try {
      await (
        openCodeService as never as {
          handleEvent: (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            instance: any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rawEvent: any,
            directory?: string
          ) => Promise<void>
        }
      ).handleEvent(
        instance,
        {
          data: {
            type: 'message.updated',
            properties: {
              sessionID: 'opc-session-1',
              info: { messageID: 'msg-1' },
              message: { id: 'msg-1', role: 'assistant' },
              parts: [{ type: 'text', text: 'hello' }]
            }
          }
        },
        '/repo/b'
      )
    } finally {
      unsubscribe()
    }

    expect(events).toContainEqual(
      expect.objectContaining({ sessionId: 'hive-session-b', type: 'message.updated' })
    )
    expect(mockDb.getSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    expect(mockDb.upsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
  })
})
