import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPENCODE_STREAM_CHANNEL } from '@shared/opencode-events'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import { DiscordSessionBridge, splitDiscordMessage } from './discord-session-bridge'
import type { DiscordResource, Session, Worktree } from '../db/types'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

const PLAN_MODE_PREFIX =
  '[Mode: Plan] You are in planning mode. Focus on designing, analyzing, and outlining an approach. Do NOT make code changes - instead describe what changes should be made and why.\n\n'

const SUPER_PLAN_MODE_PREFIX =
  'Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.\n\nIf a question can be answered by exploring the codebase, explore the codebase instead.\nAll questions should be asked using the AskUserQuestion tool if possible\n\n'

type StreamListener = (event: OpenCodeStreamEvent) => void
const BUILD_MODEL = { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' }
const PLAN_MODEL = {
  providerID: 'anthropic',
  modelID: 'sonnet',
  variant: 'high',
  agentSdk: 'claude-code-cli'
}
const PLAN_PROMPT_MODEL = {
  providerID: 'anthropic',
  modelID: 'sonnet',
  variant: 'high'
}

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

  setDiscordResourceManagedSession(
    resourceId: string,
    sessionId: string | null
  ): DiscordResource | null {
    this.managedSessionUpdates.push({ resourceId, sessionId })
    const resource = this.resources.find((candidate) => candidate.id === resourceId)
    if (!resource) return null
    resource.managed_session_id = sessionId
    return resource
  }

  getSession(id: string): Session | null {
    return this.sessions.find((session) => session.id === id) ?? null
  }

  getAgentSdkForSession(agentSessionId: string): string | null {
    return (
      this.sessions.find((session) => session.opencode_session_id === agentSessionId)?.agent_sdk ??
      null
    )
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

const setAppSettings = (db: FakeBridgeDatabase, settings: Record<string, unknown>): void => {
  db.settings.set(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
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

const setupBridge = (
  overrides: { publishEvent?: (channel: string, payload: unknown) => void } = {}
) => {
  const db = new FakeBridgeDatabase()
  db.resources = [makeResource()]
  setAppSettings(db, {
    defaultAgentSdk: 'opencode',
    selectedModelByProvider: {
      opencode: BUILD_MODEL
    },
    defaultModels: null
  })
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
    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: 'ship this' }],
      BUILD_MODEL
    )
    expect(channel.sendTyping).toHaveBeenCalledTimes(1)
  })

  it('ignores the stale selected_model key and creates a plain-message session from app_settings', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.settings.set(
      'selected_model',
      JSON.stringify({ providerID: 'legacy', modelID: 'stale-model' })
    )
    setAppSettings(db, {
      defaultAgentSdk: 'codex',
      selectedModelByProvider: {
        codex: { providerID: 'codex', modelID: 'gpt-5.5' }
      }
    })

    await bridge.handleUserMessage(userMessage(makeChannel(), 'use app settings'))

    expect(db.createdSessions[0]).toEqual(
      expect.objectContaining({
        agent_sdk: 'codex',
        mode: 'build',
        model_provider_id: 'codex',
        model_id: 'gpt-5.5'
      })
    )
    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: 'use app settings' }],
      { providerID: 'codex', modelID: 'gpt-5.5' }
    )
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
    expect(openCode.prompt).toHaveBeenLastCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: 'second' }],
      BUILD_MODEL
    )
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
    expect(openCode.prompt).toHaveBeenLastCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: 'second' }],
      BUILD_MODEL
    )
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
    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-existing',
      [{ type: 'text', text: 'after restart' }],
      { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' }
    )
  })

  it('prepends the plan prefix when the managed session is in plan mode', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession({ mode: 'plan' })]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'review the approach'))

    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-existing',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}review the approach` }],
      { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' }
    )
  })

  it('prepends the OpenCode super-plan prefix when the managed session is in super-plan mode', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession({ mode: 'super-plan' })]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'stress test this plan'))

    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-existing',
      [{ type: 'text', text: `${SUPER_PLAN_MODE_PREFIX}stress test this plan` }],
      { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' }
    )
  })

  it('keeps build mode prompts raw', async () => {
    const { db, bridge, openCode } = setupBridge()
    db.sessions = [makeSession({ mode: 'build' })]
    db.resources = [makeResource({ managed_session_id: 'hive-existing' })]

    await bridge.handleUserMessage(userMessage(makeChannel(), 'make the edit'))

    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-existing',
      [{ type: 'text', text: 'make the edit' }],
      { providerID: 'anthropic', modelID: 'claude-opus-4-5-20251101' }
    )
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
    expect(openCode.prompt).toHaveBeenLastCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}second` }],
      BUILD_MODEL
    )
  })

  it('creates an empty-channel /plan session with the configured plan model and SDK', async () => {
    const { db, bridge, openCode } = setupBridge()
    setAppSettings(db, {
      defaultAgentSdk: 'opencode',
      selectedModelByProvider: {
        opencode: BUILD_MODEL
      },
      defaultModels: {
        plan: PLAN_MODEL
      }
    })

    await bridge.setWorktreeMode(
      {
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        worktreePath: '/repo/project/worktree'
      },
      'plan'
    )
    await bridge.handleUserMessage(userMessage(makeChannel(), 'plan this'))

    expect(db.createdSessions[0]).toEqual(
      expect.objectContaining({
        agent_sdk: 'claude-code-cli',
        mode: 'plan',
        model_provider_id: 'anthropic',
        model_id: 'sonnet',
        model_variant: 'high'
      })
    )
    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}plan this` }],
      PLAN_PROMPT_MODEL
    )
  })

  it('changes only mode for an existing session and keeps the original prompt model override', async () => {
    const { db, bridge, openCode, emit } = setupBridge()
    setAppSettings(db, {
      defaultAgentSdk: 'opencode',
      selectedModelByProvider: {
        opencode: BUILD_MODEL
      },
      defaultModels: {
        plan: PLAN_MODEL
      }
    })
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
    await bridge.handleUserMessage(userMessage(channel, 'second'))

    expect(db.updatedSessions).toContainEqual({ id: 'hive-1', data: { mode: 'plan' } })
    expect(db.updatedSessions).not.toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          model_provider_id: expect.any(String)
        })
      })
    )
    expect(db.getSession('hive-1')).toEqual(
      expect.objectContaining({
        agent_sdk: 'opencode',
        model_provider_id: 'openai',
        model_id: 'gpt-5.5',
        model_variant: 'high'
      })
    )
    expect(openCode.prompt).toHaveBeenLastCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}second` }],
      BUILD_MODEL
    )
  })

  it('remembers channel mode across clear and recreates the next plain-message session with that mode default', async () => {
    const { db, bridge, openCode } = setupBridge()
    setAppSettings(db, {
      defaultAgentSdk: 'opencode',
      selectedModelByProvider: {
        opencode: BUILD_MODEL
      },
      defaultModels: {
        plan: PLAN_MODEL
      }
    })

    await bridge.setWorktreeMode(
      {
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        worktreePath: '/repo/project/worktree'
      },
      'plan'
    )
    await bridge.clearManagedSession({
      worktreeId: 'worktree-1',
      worktreePath: '/repo/project/worktree'
    })
    openCode.connect.mockResolvedValueOnce({ sessionId: 'oc-2' })
    await bridge.handleUserMessage(userMessage(makeChannel(), 'after clear'))

    expect(db.createdSessions).toHaveLength(2)
    expect(db.createdSessions[1]).toEqual(
      expect.objectContaining({
        agent_sdk: 'claude-code-cli',
        mode: 'plan',
        model_provider_id: 'anthropic',
        model_id: 'sonnet',
        model_variant: 'high'
      })
    )
    expect(openCode.prompt).toHaveBeenLastCalledWith(
      '/repo/project/worktree',
      'oc-2',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}after clear` }],
      PLAN_PROMPT_MODEL
    )
  })

  it('treats claude-code-cli as registered when the Claude Code implementer is available', async () => {
    const { db, bridge, openCode } = setupBridge()
    const getImplementer = vi.fn((sdk: string) => {
      if (sdk === 'claude-code') return {}
      throw new Error(`Unknown agent SDK: "${sdk}"`)
    })
    bridge.setAgentSdkManager({ getImplementer } as never)
    setAppSettings(db, {
      defaultAgentSdk: 'opencode',
      defaultModels: {
        plan: PLAN_MODEL
      }
    })

    await bridge.setWorktreeMode(
      {
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        worktreePath: '/repo/project/worktree'
      },
      'plan'
    )
    await bridge.handleUserMessage(userMessage(makeChannel(), 'cli route'))

    expect(getImplementer).toHaveBeenCalledWith('claude-code')
    expect(db.createdSessions[0]).toEqual(
      expect.objectContaining({
        agent_sdk: 'claude-code-cli',
        mode: 'plan',
        model_provider_id: 'anthropic',
        model_id: 'sonnet',
        model_variant: 'high'
      })
    )
    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}cli route` }],
      PLAN_PROMPT_MODEL
    )
  })

  it('falls back to opencode when the resolved SDK is not registered', async () => {
    const { db, bridge, openCode } = setupBridge()
    setAppSettings(db, {
      defaultAgentSdk: 'opencode',
      defaultModels: {
        plan: {
          providerID: 'codex',
          modelID: 'gpt-5.5',
          agentSdk: 'codex'
        }
      }
    })
    bridge.setAgentSdkManager({
      getImplementer: vi.fn(() => {
        throw new Error('Unknown agent SDK: "codex"')
      })
    } as never)

    await bridge.setWorktreeMode(
      {
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        worktreePath: '/repo/project/worktree'
      },
      'plan'
    )
    await bridge.handleUserMessage(userMessage(makeChannel(), 'fallback route'))

    expect(db.createdSessions[0]).toEqual(
      expect.objectContaining({
        agent_sdk: 'opencode',
        mode: 'plan',
        model_provider_id: 'codex',
        model_id: 'gpt-5.5'
      })
    )
    expect(openCode.prompt).toHaveBeenCalledWith(
      '/repo/project/worktree',
      'oc-1',
      [{ type: 'text', text: `${PLAN_MODE_PREFIX}fallback route` }],
      { providerID: 'codex', modelID: 'gpt-5.5' }
    )
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
