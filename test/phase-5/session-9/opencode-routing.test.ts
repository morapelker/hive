import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockDb = {
  getSessionMessageByOpenCodeId: vi.fn(),
  upsertSessionMessageByOpenCodeId: vi.fn()
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

vi.mock('../../../src/main/db', () => ({
  getDatabase: () => mockDb
}))

import { openCodeService } from '../../../src/main/services/opencode-service'

describe('Session 9: OpenCode session routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.getSessionMessageByOpenCodeId.mockReturnValue(null)
  })

  test('routes event to correct hive session when opencode session IDs collide across directories', async () => {
    const send = vi.fn()

    openCodeService.setMainWindow({
      isDestroyed: () => false,
      webContents: { send }
    } as never)

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

    await (openCodeService as never as {
      handleEvent: (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instance: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rawEvent: any,
        directory?: string
      ) => Promise<void>
    }).handleEvent(
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

    expect(send).toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({ sessionId: 'hive-session-a', type: 'session.idle' })
    )
  })
})
