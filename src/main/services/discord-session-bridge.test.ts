import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { DiscordSessionBridge, splitDiscordMessage } from './discord-session-bridge'
import type { DiscordResource, Session, Worktree } from '../db/types'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'

const SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the AskUserQuestion tool if possible\n\n'

type StreamListener = (event: OpenCodeStreamEvent) => void

class FakeBridgeDatabase {
  settings = new Map<string, string>()
  resources: DiscordResource[] = []
  sessions: Session[] = []
  worktrees: Worktree[] = []
  createdSessions: Array<Partial<Session>> = []
  updatedSessions: Array<{ id: string; data: Partial<Session> }> = []
  managedSessionUpdates: Array<{ resourceId: string; sessionId: string | null }> = []
  nextSessionId = 1

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  getDiscordChannelResourceByWorktree(worktreeId: string): DiscordResource | null {
    return (
      this.resources.find(
        (resource) => resource.type === 'channel' && resource.worktree_id === worktreeId
      ) ?? null
    )
  }

  setDiscordResourceManagedSession(resourceId: string, sessionId: string | null): DiscordResource | null {
    this.managedSessionUpdates.push({ resourceId, sessionId })
    const resource = this.resources.find((candidate) => candidate.id === resourceId)
    if (!resource) return null
    resource.managed_session_id = sessionId
    return resource
  }

  getSession(id: string): Session | null {
    return this.sessions.find((session) => session.id === id) ?? null
  }

  createSession(data: Partial<Session>): Session {
    this.createdSessions.push(data)
    const now = '2026-01-01T00:00:00.000Z'
    const session: Session = {
      id: `hive-${this.nextSessionId++}`,
      worktree_id: data.worktree_id ?? null,
      project_id: data.project_id ?? 'project-1',
      connection_id: null,
      name: null,
      status: 'active',
      opencode_session_id: data.opencode_session_id ?? null,
      claude_session_id: null,
      agent_sdk: data.agent_sdk ?? 'opencode',
      mode: data.mode ?? 'build',
      session_type: data.session_type ?? 'default',
      model_provider_id: data.model_provider_id ?? null,
      model_id: data.model_id ?? null,
      model_variant: data.model_variant ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      pinned_to_board: false
    }
    this.sessions.push(session)
    return session
  }

  updateSession(id: string, data: Partial<Session>): Session | null {
    this.updatedSessions.push({ id, data })
    const session = this.getSession(id)
    if (!session) return null
    Object.assign(session, data)
    return session
  }
}

const makeResource = (overrides: Partial<DiscordResource> = {}): DiscordResource => ({
  id: 'resource-1',
  project_id: 'project-1',
  worktree_id: 'worktree-1',
  discord_id: 'channel-1',
  type: 'channel',
  guild_id: 'guild-1',
  managed_session_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'hive-existing',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: null,
  name: null,
  status: 'active',
  opencode_session_id: 'oc-existing',
  claude_session_id: null,
  agent_sdk: 'opencode',
  mode: 'build',
  session_type: 'default',
  model_provider_id: 'anthropic',
  model_id: 'claude-opus-4-5-20251101',
  model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null,
  pinned_to_board: false,
  ...overrides
})

const makeChannel = () => ({
  send: vi.fn(async (_content: string) => undefined),
  sendTyping: vi.fn(async () => undefined)
})

const setupBridge = (overrides: { publishEvent?: (channel: string, payload: unknown) => void } = {}) => {
  const db = new FakeBridgeDatabase()
  db.resources = [makeResource()]
  db.settings.set(
    'selected_model',
    JSON.stringify({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' })
  )
  let listener: StreamListener | null = null
  const openCode = {
    connect: vi.fn(async () => ({ sessionId: 'oc-1' })),
    reconnect: vi.fn(async () => ({ success: true, sessionStatus: 'idle' as const })),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => true),
    disconnect: vi.fn(async () => undefined)
  }
  const bridge = new DiscordSessionBridge({
    db: db as never,
    openCodeService: openCode,
    subscribeToAgentEvents: (callback) => {
      listener = callback
      return vi.fn()
    },
    publishEvent: overrides.publishEvent,
    typingIntervalMs: 50
  })
  bridge.start()
  return {
    db,
    bridge,
    openCode,
    emit: (event: OpenCodeStreamEvent) => listener?.(event)
  }
}

const userMessage = (channel = makeChannel(), text = 'ship this') => ({
  channelId: 'channel-1',
  worktreeId: 'worktree-1',
  projectId: 'project-1',
  worktreePath: '/repo/project/worktree',
  text,
  channel
})

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('DiscordSessionBridge managed sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('creates a managed OpenCode build session on the first message and persists both ids', async () => {
    const { db, bridge, openCode } = setupBridge()
    const channel = makeChannel()

    await bridge.handleUserMessage(userMessage(channel))

    expect(db.createdSessions).toEqual([
      expect.objectContaining({
        worktree_id: 'worktree-1',
        project_id: 'project-1',
        agent_sdk: 'opencode',
        mode: 'build',
        session_type: 'default',
        model_provider_id: 'openai',
        model_id: 'gpt-5.5',
        model_variant: 'high'
      })
    ])
    expect(openCode.connect).toHaveBeenCalledWith('/repo/project/worktree', 'hive-1')
    expect(db.getSession('hive-1')?.opencode_session_id).toBe('oc-1')
    expect(db.resources[0].managed_session_id).toBe('hive-1')
    expect(openCode.prompt).toHaveBeenCalledWith('/repo/project/worktree', 'oc-1', [
      { type: 'text', text: 'ship this' }
    ])
    expect(channel.sendTyping).toHaveBeenCalledTimes(1)
  })

  it('reuses the same managed session for later messages without creating another one', async () => {
    const { db, bridge, openCode, emit } = setupBridge()
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel, 'first'))
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })

    await bridge.handleUserMessage(userMessage(channel, 'second'))

    expect(db.createdSessions).toHaveLength(1)
    expect(openCode.connect).toHaveBeenCalledTimes(1)
    expect(openCode.prompt).toHaveBeenCalledTimes(2)
    expect(openCode.prompt).toHaveBeenLastCalledWith('/repo/project/worktree', 'oc-1', [
      { type: 'text', text: 'second' }
    ])
  })

  it('queues a message received while busy and dispatches it as its own turn on idle', async () => {
    const { bridge, openCode, emit } = setupBridge()
    const channel = makeChannel()

    await bridge.handleUserMessage(userMessage(channel, 'first'))
    await bridge.handleUserMessage(userMessage(channel, 'second'))

    expect(openCode.prompt).toHaveBeenCalledTimes(1)
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })
    await Promise.resolve()

    expect(openCode.prompt).toHaveBeenCalledTimes(2)
    expect(openCode.prompt).toHaveBeenLastCalledWith('/repo/project/worktree', 'oc-1', [
      { type: 'text', text: 'second' }
    ])
  })

  it('reconnects a stored managed session after restart without creating a duplicate session', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession()]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'after restart'))

    expect(openCode.reconnect).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-existing',
      'hive-existing'
    )
    expect(db.createdSessions).toHaveLength(0)
    expect(openCode.connect).not.toHaveBeenCalled()
    expect(openCode.prompt).toHaveBeenCalledWith('/repo/project/worktree', 'oc-existing', [
      { type: 'text', text: 'after restart' }
    ])
  })

  it('prepends the plan prefix when the managed session is in plan mode', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession({ mode: 'plan' })]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'review the approach'))

    expect(openCode.prompt).toHaveBeenCalledWith('/repo/project/worktree', 'oc-existing', [
      { type: 'text', text: `${PLAN_MODE_PREFIX}review the approach` }
    ])
  })

  it('prepends the OpenCode super-plan prefix when the managed session is in super-plan mode', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession({ mode: 'super-plan' })]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'stress test this plan'))

    expect(openCode.prompt).toHaveBeenCalledWith('/repo/project/worktree', 'oc-existing', [
      { type: 'text', text: `${SUPER_PLAN_MODE_PREFIX}stress test this plan` }
    ])
  })

  it('keeps build mode prompts raw', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession({ mode: 'build' })]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'make the edit'))

    expect(openCode.prompt).toHaveBeenCalledWith('/repo/project/worktree', 'oc-existing', [
      { type: 'text', text: 'make the edit' }
    ])
  })

  it('persists mode changes on the managed session and updates the active runtime', async () => {
    const { db, bridge, openCode, emit } = setupBridge()
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel, 'first'))
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })
    db.updatedSessions = []

    await bridge.setWorktreeMode(
      {
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        worktreePath: '/repo/project/worktree'
      },
      'plan'
    )

    expect(db.updatedSessions).toContainEqual({ id: 'hive-1', data: { mode: 'plan' } })
    expect(openCode.connect).toHaveBeenCalledTimes(1)

    await bridge.handleUserMessage(userMessage(channel, 'second'))
    expect(openCode.prompt).toHaveBeenLastCalledWith('/repo/project/worktree', 'oc-1', [
      { type: 'text', text: `${PLAN_MODE_PREFIX}second` }
    ])
  })

  it('clears a managed session by aborting, disconnecting, unlinking, and dropping later stream events', async () => {
    const { db, bridge, openCode, emit } = setupBridge()
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel, 'long task'))

    await bridge.clearManagedSession({
      worktreeId: 'worktree-1',
      worktreePath: '/repo/project/worktree'
    })
    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: {
        role: 'assistant',
        part: { type: 'text', text: 'late output', messageID: 'msg-1' }
      }
    })
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(100)

    expect(openCode.abort).toHaveBeenCalledWith('/repo/project/worktree', 'oc-1')
    expect(openCode.disconnect).toHaveBeenCalledWith('/repo/project/worktree', 'oc-1')
    expect(db.managedSessionUpdates).toContainEqual({ resourceId: 'resource-1', sessionId: null })
    expect(db.resources[0].managed_session_id).toBeNull()
    expect(db.getSession('hive-1')?.status).toBe('active')
    expect(channel.sendTyping).toHaveBeenCalledTimes(1)
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('treats clearing a provisioned channel without an attached session as a no-op', async () => {
    const { db, bridge, openCode } = setupBridge()

    await bridge.clearManagedSession({
      worktreeId: 'worktree-1',
      worktreePath: '/repo/project/worktree'
    })

    expect(openCode.abort).not.toHaveBeenCalled()
    expect(openCode.disconnect).not.toHaveBeenCalled()
    expect(db.managedSessionUpdates).toEqual([])
  })
})

describe('DiscordSessionBridge stream delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('posts assistant text on idle, posts terminal tool completions, stops typing, and ignores child events', async () => {
    const { bridge, emit } = setupBridge()
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel))

    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { part: { type: 'text', messageID: 'user-echo-without-role' }, delta: 'ship this' }
    })
    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { role: 'user', part: { type: 'text', messageID: 'user-msg' }, delta: 'prompt echo' }
    })
    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { role: 'assistant', part: { type: 'text', messageID: 'msg-1' }, delta: 'Hello' }
    })
    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      childSessionId: 'child-1',
      data: { part: { type: 'text', messageID: 'child-msg' }, delta: 'hidden' }
    })
    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: {
        part: {
          type: 'tool',
          callID: 'tool-1',
          tool: 'Bash',
          state: {
            status: 'completed',
            input: { command: 'npm test' }
          }
        }
      }
    })
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })
    await flushPromises()

    expect(channel.send).toHaveBeenNthCalledWith(1, 'Hello')
    expect(channel.send).toHaveBeenNthCalledWith(2, '💻 Bash: npm test')
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('ship this'))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('prompt echo'))
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('hidden'))
    vi.advanceTimersByTime(60)
    expect(channel.sendTyping).toHaveBeenCalledTimes(1)
  })

  it('forwards managed session stream events to the renderer event channel', async () => {
    const publishEvent = vi.fn()
    const { bridge, emit } = setupBridge({ publishEvent })
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel))

    const event: OpenCodeStreamEvent = {
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { role: 'assistant', part: { type: 'text', messageID: 'msg-1' }, delta: 'Hello' }
    }
    emit(event)

    expect(publishEvent).toHaveBeenCalledWith(OPENCODE_STREAM_CHANNEL, event)
  })

  it('does not forward stream events for sessions the Discord bridge is not managing', () => {
    const publishEvent = vi.fn()
    const { emit } = setupBridge({ publishEvent })

    emit({
      type: 'message.part.updated',
      sessionId: 'other-session',
      data: { role: 'assistant', part: { type: 'text', messageID: 'msg-1' }, delta: 'Hello' }
    })

    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('flushes the previous assistant message when a new assistant message begins', async () => {
    const { bridge, emit } = setupBridge()
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel))

    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { part: { type: 'text', messageID: 'msg-1' }, delta: 'First' }
    })
    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { part: { type: 'text', messageID: 'msg-2' }, delta: 'Second' }
    })
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })
    await flushPromises()

    expect(channel.send).toHaveBeenNthCalledWith(1, 'First')
    expect(channel.send).toHaveBeenNthCalledWith(2, 'Second')
  })

  it('splits assistant text over Discord message limits', async () => {
    const { bridge, emit } = setupBridge()
    const channel = makeChannel()
    await bridge.handleUserMessage(userMessage(channel))
    const longText = `${'a'.repeat(1990)} ${'b'.repeat(100)}`

    emit({
      type: 'message.part.updated',
      sessionId: 'hive-1',
      data: { part: { type: 'text', messageID: 'msg-1' }, delta: longText }
    })
    emit({ type: 'session.idle', sessionId: 'hive-1', data: {} })
    await flushPromises()

    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(channel.send.mock.calls.every(([content]) => content.length <= 2000)).toBe(true)
  })
})

describe('splitDiscordMessage', () => {
  it('prefers whitespace boundaries while respecting the max length', () => {
    expect(splitDiscordMessage('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma'])
  })
})
