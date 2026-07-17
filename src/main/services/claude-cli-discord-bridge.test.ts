import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { DISCORD_CLAUDE_CLI_EVENT_CHANNEL } from '@shared/discord-events'

vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { claudeCliDiscordBridge } from './claude-cli-discord-bridge'

const DISCORD_CONFIG = JSON.stringify({
  botToken: 'token',
  guildId: 'guild-1',
  guildName: 'Guild',
  enabled: true,
  selectedProjectIds: ['project-1']
})

class FakeDb {
  settings = new Map<string, string>()
  sessions = new Map<string, { id: string; agent_sdk: string; worktree_id: string | null }>()
  channelWorktrees = new Set<string>()

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  getSession(id: string): { id: string; agent_sdk: string; worktree_id: string | null } | null {
    return this.sessions.get(id) ?? null
  }

  getDiscordChannelResourceByWorktree(worktreeId: string): { discord_id: string } | null {
    return this.channelWorktrees.has(worktreeId) ? { discord_id: 'channel-1' } : null
  }
}

const makeRes = (): ServerResponse => {
  const res = {
    writableEnded: false,
    setTimeout: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(function (this: { writableEnded: boolean }) {
      res.writableEnded = true
    })
  }
  return res as unknown as ServerResponse
}

let sessionCounter = 0
const makeCliSession = (db: FakeDb, worktreeId = 'worktree-1'): string => {
  const id = `session-${++sessionCounter}`
  db.sessions.set(id, { id, agent_sdk: 'claude-code-cli', worktree_id: worktreeId })
  return id
}

describe('claudeCliDiscordBridge dynamic ownership', () => {
  let db: FakeDb

  beforeEach(() => {
    vi.clearAllMocks()
    claudeCliDiscordBridge.cancelAll()
    db = new FakeDb()
    claudeCliDiscordBridge.setDatabase(db as never)
  })

  it('owns a claude-cli session whose worktree has a provisioned channel while Discord is enabled', () => {
    db.settings.set('discord_config', DISCORD_CONFIG)
    db.channelWorktrees.add('worktree-1')
    const sessionId = makeCliSession(db)

    expect(claudeCliDiscordBridge.isRegistered(sessionId)).toBe(true)
  })

  it('does not own sessions when Discord mode is disabled', () => {
    db.settings.set(
      'discord_config',
      JSON.stringify({ ...JSON.parse(DISCORD_CONFIG), enabled: false })
    )
    db.channelWorktrees.add('worktree-1')
    const sessionId = makeCliSession(db)

    expect(claudeCliDiscordBridge.isRegistered(sessionId)).toBe(false)
  })

  it('does not own sessions whose worktree has no channel', () => {
    db.settings.set('discord_config', DISCORD_CONFIG)
    const sessionId = makeCliSession(db, 'worktree-without-channel')

    expect(claudeCliDiscordBridge.isRegistered(sessionId)).toBe(false)
  })

  it('holds an AskUserQuestion hook for an owned session and relays the event to the backend', () => {
    db.settings.set('discord_config', DISCORD_CONFIG)
    db.channelWorktrees.add('worktree-1')
    const sessionId = makeCliSession(db)
    expect(claudeCliDiscordBridge.isRegistered(sessionId)).toBe(true)

    const res = makeRes()
    const owned = claudeCliDiscordBridge.onHook(
      sessionId,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{ question: 'Pick one', options: ['a', 'b'] }]
        }
      },
      res
    )

    expect(owned).toBe(true)
    expect(res.writableEnded).toBe(false)
    expect(publishDesktopBackendEvent).toHaveBeenCalledWith(
      DISCORD_CLAUDE_CLI_EVENT_CHANNEL,
      expect.objectContaining({ type: 'question.asked', sessionId })
    )
  })

  it('relays idle transport events to the backend channel', () => {
    db.settings.set('discord_config', DISCORD_CONFIG)
    db.channelWorktrees.add('worktree-1')
    const sessionId = makeCliSession(db)
    expect(claudeCliDiscordBridge.isRegistered(sessionId)).toBe(true)

    claudeCliDiscordBridge.notifySessionIdle(sessionId, 'final message')

    expect(publishDesktopBackendEvent).toHaveBeenCalledWith(
      DISCORD_CLAUDE_CLI_EVENT_CHANNEL,
      expect.objectContaining({ type: 'message.updated', sessionId })
    )
    expect(publishDesktopBackendEvent).toHaveBeenCalledWith(
      DISCORD_CLAUDE_CLI_EVENT_CHANNEL,
      expect.objectContaining({ type: 'session.idle', sessionId })
    )
  })
})
