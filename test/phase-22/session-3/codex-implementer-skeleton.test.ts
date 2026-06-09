/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const eventBusMocks = vi.hoisted(() => ({
  publish: vi.fn()
}))

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/agent-event-bus', () => ({
  agentEventBus: eventBusMocks
}))

vi.mock('../../../src/main/services/notification-service', () => ({
  notificationService: { shouldNotifyWhenWindowUnfocused: vi.fn(() => false) }
}))

vi.mock('../../../src/main/services/codex-session-title', () => ({
  generateCodexSessionTitle: vi.fn()
}))

vi.mock('../../../src/main/services/git-service', () => ({
  autoRenameWorktreeBranch: vi.fn()
}))

vi.mock('../../../src/main/services/worktree-events', () => ({
  emitWorktreeBranchRenamed: vi.fn()
}))

import { CodexImplementer } from '../../../src/main/services/codex-implementer'
import { CODEX_CAPABILITIES } from '../../../src/main/services/agent-sdk-types'
import { CODEX_DEFAULT_MODEL } from '../../../src/main/services/codex-models'

describe('CodexImplementer skeleton', () => {
  let impl: CodexImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new CodexImplementer()
  })

  function seedCodexSession(): void {
    ;(impl as any).sessions.set('/path::thread-1', {
      threadId: 'thread-1',
      hiveSessionId: 'hive-1',
      worktreePath: '/path',
      status: 'ready',
      messages: [],
      pendingHitlRequestIds: new Set<string>(),
      liveAssistantDraft: null,
      currentTurnId: null,
      currentAssistantMessageId: null,
      revertMessageID: null,
      revertDiff: null,
      titleGenerated: true,
      titleGenerationStarted: true,
      persistDebounceTimer: null
    })
  }

  // ── Identity & capabilities ────────────────────────────────────

  describe('identity', () => {
    it('has id "codex"', () => {
      expect(impl.id).toBe('codex')
    })

    it('has CODEX_CAPABILITIES', () => {
      expect(impl.capabilities).toEqual(CODEX_CAPABILITIES)
    })

    it('supportsUndo is true', () => {
      expect(impl.capabilities.supportsUndo).toBe(true)
    })

    it('supportsRedo is false', () => {
      expect(impl.capabilities.supportsRedo).toBe(false)
    })

    it('supportsCommands is true', () => {
      expect(impl.capabilities.supportsCommands).toBe(true)
    })

    it('supportsModelSelection is true', () => {
      expect(impl.capabilities.supportsModelSelection).toBe(true)
    })
  })

  // ── Model methods (implemented) ────────────────────────────────

  describe('getAvailableModels', () => {
    it('returns array with codex provider', async () => {
      const result = (await impl.getAvailableModels()) as any[]
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('codex')
    })

    it('provider contains all 5 models', async () => {
      const result = (await impl.getAvailableModels()) as any[]
      const models = result[0].models
      expect(Object.keys(models)).toHaveLength(5)
      expect(models['gpt-5.5']).toMatchObject({
        id: 'gpt-5.5',
        name: 'GPT-5.5'
      })
    })
  })

  describe('getModelInfo', () => {
    it('returns info for a known model', async () => {
      const info = await impl.getModelInfo('/path', 'gpt-5.5')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.5')
      expect(info!.name).toBe('GPT-5.5')
    })

    it('resolves aliased model slugs', async () => {
      const info = await impl.getModelInfo('/path', '5.5')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.5')
      expect(info!.name).toBe('GPT-5.5')
    })

    it('still returns info for legacy codex models', async () => {
      const info = await impl.getModelInfo('/path', 'gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
    })

    it('returns null for unknown model', async () => {
      const info = await impl.getModelInfo('/path', 'unknown')
      expect(info).toBeNull()
    })
  })

  // ── setSelectedModel ───────────────────────────────────────────

  describe('setSelectedModel', () => {
    it('stores the model selection', () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex' })
      expect(impl.getSelectedModel()).toBe('gpt-5.3-codex')
    })

    it('stores the variant selection', () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.4', variant: 'xhigh' })
      expect(impl.getSelectedVariant()).toBe('xhigh')
    })

    it('defaults to gpt-5.5 before any selection', () => {
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
    })
  })

  // ── renderer delivery ──────────────────────────────────────────

  describe('renderer delivery', () => {
    it('does not expose desktop window hooks after event bus migration', () => {
      for (const hook of ['set' + 'MainWindow', 'get' + 'MainWindow']) {
        expect((impl as any)[hook]).toBeUndefined()
      }
    })
  })

  // ── cleanup ────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('resets selected model to default', async () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex', variant: 'low' })

      await impl.cleanup()
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
      expect(impl.getSelectedVariant()).toBeUndefined()
    })

    it('does not throw', async () => {
      await expect(impl.cleanup()).resolves.toBeUndefined()
    })
  })

  // ── Unimplemented lifecycle methods throw ──────────────────────

  describe('lifecycle methods are implemented (session 4)', () => {
    it('connect is a function', () => {
      expect(typeof impl.connect).toBe('function')
    })

    it('reconnect is a function', () => {
      expect(typeof impl.reconnect).toBe('function')
    })

    it('disconnect is a function', () => {
      expect(typeof impl.disconnect).toBe('function')
    })
  })

  // ── Unimplemented messaging methods throw ──────────────────────

  describe('implemented messaging methods', () => {
    it('prompt throws when session not found', async () => {
      await expect(impl.prompt('/path', 'session-1', 'hello')).rejects.toThrow(
        'session not found'
      )
    })

    it('abort returns false for unknown session', async () => {
      const result = await impl.abort('/path', 'session-1')
      expect(result).toBe(false)
    })

    it('getMessages returns empty array for unknown session', async () => {
      const messages = await impl.getMessages('/path', 'session-1')
      expect(messages).toEqual([])
    })
  })

  describe('goal slash command support', () => {
    it('lists the Codex goal slash command', async () => {
      const commands = (await impl.listCommands('/path')) as Array<{ name: string; template: string }>

      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'goal',
            template: '/goal '
          })
        ])
      )
    })

    it('lists enabled Codex skills after the goal command', async () => {
      const manager = {
        listSkills: vi.fn().mockResolvedValue({
          data: [
            {
              cwd: '/path',
              skills: [
                {
                  name: 'brainstorming',
                  description: 'Full description',
                  shortDescription: 'Legacy short',
                  interface: {
                    shortDescription: 'Explore requirements',
                    defaultPrompt: '  design this  '
                  },
                  path: '/skills/brainstorming/SKILL.md',
                  scope: 'user',
                  enabled: true
                },
                {
                  name: 'disabled-skill',
                  description: 'Disabled',
                  path: '/skills/disabled/SKILL.md',
                  scope: 'user',
                  enabled: false
                },
                {
                  name: 'missing-path',
                  description: 'Invalid',
                  path: '',
                  scope: 'user',
                  enabled: true
                }
              ],
              errors: [{ message: 'bad repo skill' }]
            }
          ]
        })
      }
      ;(impl as any).manager = manager

      const commands = (await impl.listCommands('/path', 'thread-1')) as any[]

      expect(commands[0]).toMatchObject({ name: 'goal', source: 'codex' })
      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'brainstorming',
            description: 'Explore requirements',
            template: '/brainstorming design this ',
            source: 'skill',
            path: '/skills/brainstorming/SKILL.md',
            scope: 'user',
            enabled: true
          })
        ])
      )
      expect(commands.find((command) => command.name === 'disabled-skill')).toBeUndefined()
      expect(commands.find((command) => command.name === 'missing-path')).toBeUndefined()
    })

    it('prefers exact skills/list cwd matches over fallback flattening', async () => {
      const manager = {
        listSkills: vi.fn().mockResolvedValue({
          data: [
            {
              cwd: '/other',
              skills: [
                {
                  name: 'other-skill',
                  description: 'Other',
                  path: '/skills/other/SKILL.md',
                  scope: 'user',
                  enabled: true
                }
              ],
              errors: []
            },
            {
              cwd: '/path',
              skills: [
                {
                  name: 'exact-skill',
                  description: 'Exact',
                  path: '/skills/exact/SKILL.md',
                  scope: 'repo',
                  enabled: true
                }
              ],
              errors: []
            }
          ]
        })
      }
      ;(impl as any).manager = manager

      const commands = (await impl.listCommands('/path', 'thread-1')) as any[]

      expect(commands.find((command) => command.name === 'exact-skill')).toBeDefined()
      expect(commands.find((command) => command.name === 'other-skill')).toBeUndefined()
    })

    it('flattens skills/list entries when no exact cwd match is returned', async () => {
      const manager = {
        listSkills: vi.fn().mockResolvedValue({
          data: [
            {
              cwd: '/other-a',
              skills: [
                {
                  name: 'skill-a',
                  description: 'A',
                  path: '/skills/a/SKILL.md',
                  scope: 'user',
                  enabled: true
                }
              ],
              errors: []
            },
            {
              cwd: '/other-b',
              skills: [
                {
                  name: 'skill-b',
                  description: 'B',
                  path: '/skills/b/SKILL.md',
                  scope: 'system',
                  enabled: true
                }
              ],
              errors: []
            }
          ]
        })
      }
      ;(impl as any).manager = manager

      const commands = (await impl.listCommands('/path', 'thread-1')) as any[]

      expect(commands.find((command) => command.name === 'skill-a')).toBeDefined()
      expect(commands.find((command) => command.name === 'skill-b')).toBeDefined()
    })

    it('falls back to goal only when skills/list fails', async () => {
      const manager = {
        listSkills: vi.fn().mockRejectedValue(new Error('protocol unavailable'))
      }
      ;(impl as any).manager = manager

      await expect(impl.listCommands('/path', 'thread-1')).resolves.toEqual([
        expect.objectContaining({ name: 'goal' })
      ])
    })

    it('clears cached skills when skills/list fails after a previous successful fetch', async () => {
      const manager = {
        listSkills: vi
          .fn()
          .mockResolvedValueOnce({
            data: [
              {
                cwd: '/path',
                skills: [
                  {
                    name: 'imagegen',
                    description: 'Generate an image',
                    path: '/skills/imagegen/SKILL.md',
                    scope: 'system',
                    enabled: true
                  }
                ],
                errors: []
              }
            ]
          })
          .mockRejectedValueOnce(new Error('protocol unavailable'))
      }
      ;(impl as any).manager = manager

      await impl.listCommands('/path', 'thread-1')
      await expect(impl.listCommands('/path', 'thread-1')).resolves.toEqual([
        expect.objectContaining({ name: 'goal' })
      ])

      await expect(impl.sendCommand('/path', 'thread-1', 'imagegen', 'a poster')).rejects.toThrow(
        'Unsupported Codex command: /imagegen'
      )
    })

    it('emits commands_available when Codex reports skills/changed', () => {
      seedCodexSession()

      ;(impl as any).handleManagerEvent({
        id: 'skills-changed-1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'skills/changed',
        payload: {}
      })

      expect(eventBusMocks.publish).toHaveBeenCalledWith({
        type: 'session.commands_available',
        sessionId: 'hive-1',
        data: {}
      })
    })

    it('clears cached skills for the changed session before notifying commands_available', async () => {
      seedCodexSession()
      const manager = {
        listSkills: vi.fn().mockResolvedValue({
          data: [
            {
              cwd: '/path',
              skills: [
                {
                  name: 'imagegen',
                  description: 'Generate an image',
                  path: '/skills/imagegen/SKILL.md',
                  scope: 'system',
                  enabled: true
                }
              ],
              errors: []
            }
          ]
        })
      }
      ;(impl as any).manager = manager

      await impl.listCommands('/path', 'thread-1')
      ;(impl as any).handleManagerEvent({
        id: 'skills-changed-1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'skills/changed',
        payload: {}
      })

      await expect(impl.sendCommand('/path', 'thread-1', 'imagegen', 'a poster')).rejects.toThrow(
        'Unsupported Codex command: /imagegen'
      )
      expect(eventBusMocks.publish).toHaveBeenCalledWith({
        type: 'session.commands_available',
        sessionId: 'hive-1',
        data: {}
      })
    })

    it('sends known skill commands as structured Codex input through the turn lifecycle', async () => {
      seedCodexSession()
      const manager = new EventEmitter() as any
      manager.listSkills = vi.fn().mockResolvedValue({
        data: [
          {
            cwd: '/path',
            skills: [
              {
                name: 'imagegen',
                description: 'Generate an image',
                path: '/skills/imagegen/SKILL.md',
                scope: 'system',
                enabled: true
              }
            ],
            errors: []
          }
        ]
      })
      manager.sendTurn = vi.fn(async (threadId: string) => {
        setTimeout(() => {
          manager.emit('event', {
            id: 'event-1',
            kind: 'notification',
            provider: 'codex',
            threadId,
            createdAt: new Date().toISOString(),
            method: 'turn/completed',
            turnId: 'turn-1',
            payload: { turn: { id: 'turn-1', status: 'completed' } }
          })
        }, 0)
        return { threadId, turnId: 'turn-1' }
      })
      ;(impl as any).manager = manager

      await impl.listCommands('/path', 'thread-1')
      await impl.sendCommand(
        '/path',
        'thread-1',
        'imagegen',
        'a clean product mockup',
        { providerID: 'codex', modelID: 'gpt-5.5', variant: 'high' },
        { codexFastMode: true }
      )

      expect(manager.sendTurn).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          input: [
            { type: 'skill', name: 'imagegen', path: '/skills/imagegen/SKILL.md' },
            { type: 'text', text: 'a clean product mockup', text_elements: [] }
          ],
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          serviceTier: 'fast'
        })
      )
      expect((impl as any).sessions.get('/path::thread-1').messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: 'text',
                text: '/imagegen a clean product mockup'
              })
            ])
          })
        ])
      )
    })

    it('routes /goal objective to thread/goal/set and emits a visible confirmation', async () => {
      const manager = {
        setThreadGoal: vi.fn().mockResolvedValue({
          goal: {
            threadId: 'thread-1',
            objective: 'Finish the migration',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1
          }
        })
      }
      ;(impl as any).manager = manager
      ;(impl as any).sessions.set('/path::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/path',
        status: 'ready',
        messages: [],
        pendingHitlRequestIds: new Set<string>(),
        liveAssistantDraft: null,
        currentTurnId: null,
        currentAssistantMessageId: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      })
      await impl.sendCommand('/path', 'thread-1', 'goal', 'Finish the migration')

      expect(manager.setThreadGoal).toHaveBeenCalledWith('thread-1', {
        objective: 'Finish the migration',
        status: 'active'
      })
      expect((impl as any).sessions.get('/path::thread-1').messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: 'text',
                text: '/goal Finish the migration'
              })
            ])
          })
        ])
      )
      expect(eventBusMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex.goal.updated',
          sessionId: 'hive-1',
          data: expect.objectContaining({
            threadId: 'thread-1',
            goal: expect.objectContaining({
              objective: 'Finish the migration',
              status: 'active'
            })
          })
        })
      )
      expect(eventBusMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message.part.updated',
          sessionId: 'hive-1',
          data: expect.objectContaining({
            part: expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('Goal active')
            })
          })
        })
      )
    })

    it('does not stream goal notifications whose payload thread does not match the running session thread', async () => {
      const manager = new EventEmitter() as EventEmitter & {
        sendTurn: ReturnType<typeof vi.fn>
      }
      manager.sendTurn = vi.fn().mockImplementation(async () => {
        manager.emit('event', {
          id: 'event-1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          method: 'thread/goal/updated',
          payload: {
            threadId: 'other-thread',
            goal: {
              threadId: 'other-thread',
              objective: 'Unrelated goal',
              status: 'active',
              tokenBudget: null,
              tokensUsed: 1,
              timeUsedSeconds: 1,
              createdAt: 1,
              updatedAt: 1
            }
          },
          createdAt: '2026-05-02T10:00:00.000Z'
        })
        manager.emit('event', {
          id: 'event-2',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          turnId: 'turn-1',
          method: 'turn/completed',
          payload: {
            turn: { id: 'turn-1', status: 'completed' }
          },
          createdAt: '2026-05-02T10:00:01.000Z'
        })
      })
      ;(impl as any).manager = manager
      ;(impl as any).sessions.set('/path::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/path',
        status: 'ready',
        messages: [],
        pendingHitlRequestIds: new Set<string>(),
        liveAssistantDraft: null,
        currentTurnId: null,
        currentAssistantMessageId: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      })

      await impl.prompt('/path', 'thread-1', 'continue')

      expect(eventBusMocks.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex.goal.updated',
          sessionId: 'hive-1'
        })
      )
    })

    it('routes /goal clear to thread/goal/clear and emits a goal cleared stream event', async () => {
      const manager = {
        clearThreadGoal: vi.fn().mockResolvedValue({ cleared: true })
      }
      ;(impl as any).manager = manager
      ;(impl as any).sessions.set('/path::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/path',
        status: 'ready',
        messages: [],
        pendingHitlRequestIds: new Set<string>(),
        liveAssistantDraft: null,
        currentTurnId: null,
        currentAssistantMessageId: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      })
      await impl.sendCommand('/path', 'thread-1', 'goal', 'clear')

      expect(manager.clearThreadGoal).toHaveBeenCalledWith('thread-1')
      expect(eventBusMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'codex.goal.cleared',
          sessionId: 'hive-1',
          data: expect.objectContaining({
            threadId: 'thread-1'
          })
        })
      )
    })

    it('streams autonomous goal continuation events from the global manager listener', () => {
      const manager = new EventEmitter()
      ;(impl as any).manager = manager
      ;(impl as any).sessions.set('/path::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/path',
        status: 'ready',
        messages: [],
        pendingHitlRequestIds: new Set<string>(),
        liveAssistantDraft: null,
        currentTurnId: null,
        currentAssistantMessageId: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      })
      ;(impl as any).attachManagerListener()

      manager.emit('event', {
        id: 'goal-turn-started',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-goal-1',
        method: 'turn/started',
        payload: { threadId: 'thread-1', turn: { id: 'turn-goal-1' } },
        createdAt: '2026-05-06T10:00:00.000Z'
      })
      manager.emit('event', {
        id: 'goal-delta-1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-goal-1',
        method: 'item/agentMessage/delta',
        textDelta: 'Goal continuation output',
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-goal-1',
          delta: 'Goal continuation output'
        },
        createdAt: '2026-05-06T10:00:01.000Z'
      })
      manager.emit('event', {
        id: 'goal-turn-completed',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-goal-1',
        method: 'turn/completed',
        payload: {
          threadId: 'thread-1',
          turn: { id: 'turn-goal-1', status: 'completed' }
        },
        createdAt: '2026-05-06T10:00:02.000Z'
      })

      expect(eventBusMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message.part.updated',
          sessionId: 'hive-1',
          data: expect.objectContaining({
            delta: 'Goal continuation output',
            part: expect.objectContaining({
              type: 'text',
              text: 'Goal continuation output'
            })
          })
        })
      )
      expect(eventBusMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session.status',
          sessionId: 'hive-1',
          statusPayload: { type: 'idle' }
        })
      )
      expect((impl as any).sessions.get('/path::thread-1').messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'turn-goal-1:assistant',
            role: 'assistant',
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: 'text',
                text: 'Goal continuation output'
              })
            ])
          })
        ])
      )
    })
  })

  describe('steer', () => {
    it('assigns canonical same-turn IDs and rolls subsequent assistant deltas below the steered user', async () => {
      const state = {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/path',
        status: 'running' as const,
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            parts: [{ type: 'text', text: 'First question', timestamp: '2026-03-14T10:00:00.000Z' }],
            timestamp: '2026-03-14T10:00:00.000Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            parts: [{ type: 'text', text: 'First answer', timestamp: '2026-03-14T10:00:01.000Z' }],
            timestamp: '2026-03-14T10:00:01.000Z'
          }
        ],
        pendingHitlRequestIds: new Set<string>(),
        liveAssistantDraft: null,
        currentTurnId: 'turn-1',
        currentAssistantMessageId: 'turn-1:assistant',
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        persistDebounceTimer: null
      }

      ;((impl as any).sessions as Map<string, unknown>).set('/path::session-1', state)
      ;(impl as any).manager = {
        getSession: vi.fn().mockReturnValue({ activeTurnId: 'turn-1' }),
        steerTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' })
      }

      const result = await impl.steer('/path', 'session-1', 'Follow-up steer')

      expect(result).toEqual({
        steered: true,
        insertedMessageId: 'turn-1:user:2',
        nextAssistantMessageId: 'turn-1:assistant:2',
        turnId: 'turn-1'
      })
      expect((impl as any).manager.steerTurn).toHaveBeenCalledWith(
        'thread-1',
        { text: 'Follow-up steer' },
        'turn-1'
      )

      ;(impl as any).appendCanonicalAssistantText(state, 'text', 'Continued answer', 'turn-1')

      expect(
        state.messages.map((message: { id: string }) => message.id)
      ).toEqual(['turn-1:user', 'turn-1:assistant', 'turn-1:user:2', 'turn-1:assistant:2'])
      expect(state.currentAssistantMessageId).toBe('turn-1:assistant:2')
    })
  })

  // ── Unimplemented session info methods throw ───────────────────

  describe('implemented session info methods', () => {
    it('getSessionInfo returns null/null for unknown session', async () => {
      const result = await impl.getSessionInfo('/path', 'session-1')
      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })

    it('renameSession does not throw without dbService', async () => {
      await expect(
        impl.renameSession('/path', 'session-1', 'new name')
      ).resolves.not.toThrow()
    })
  })

  // ── Implemented human-in-the-loop methods ──────────────────────

  describe('implemented human-in-the-loop methods handle missing requests', () => {
    it('questionReply throws for unknown requestId', async () => {
      await expect(impl.questionReply('req-1', [['answer']])).rejects.toThrow(
        'No pending question found for requestId: req-1'
      )
    })

    it('questionReject throws for unknown requestId', async () => {
      await expect(impl.questionReject('req-1')).rejects.toThrow(
        'No pending question found for requestId: req-1'
      )
    })

    it('permissionReply throws for unknown requestId', async () => {
      await expect(impl.permissionReply('req-1', 'once')).rejects.toThrow(
        'No pending approval found for requestId: req-1'
      )
    })

    it('permissionList returns empty array with no sessions', async () => {
      const result = await impl.permissionList()
      expect(result).toEqual([])
    })
  })

  // ── Unimplemented undo/redo methods throw ──────────────────────

  describe('undo/redo methods', () => {
    it('undo throws for unknown session', async () => {
      await expect(impl.undo('/path', 'session-1', 'hive-1')).rejects.toThrow(
        'session not found'
      )
    })

    it('redo throws unsupported', async () => {
      await expect(impl.redo('/path', 'session-1', 'hive-1')).rejects.toThrow(
        'Redo is not supported for Codex sessions'
      )
    })
  })

  // ── Command methods ──────────────────────────────────────────────

  describe('implemented command methods validate session and command', () => {
    it('sendCommand throws for unsupported commands', async () => {
      await expect(impl.sendCommand('/path', 'session-1', '/help')).rejects.toThrow(
        'Unsupported Codex command: /help'
      )
    })

    it('sendCommand throws when the session is missing', async () => {
      await expect(impl.sendCommand('/path', 'session-1', 'goal', 'ship')).rejects.toThrow(
        'session not found'
      )
    })
  })

  // ── Implements AgentSdkImplementer interface ───────────────────

  describe('interface compliance', () => {
    it('has all required methods', () => {
      const requiredMethods = [
        'connect',
        'reconnect',
        'disconnect',
        'cleanup',
        'prompt',
        'abort',
        'getMessages',
        'getAvailableModels',
        'getModelInfo',
        'setSelectedModel',
        'getSessionInfo',
        'questionReply',
        'questionReject',
        'permissionReply',
        'permissionList',
        'undo',
        'redo',
        'listCommands',
        'sendCommand',
        'renameSession'
      ]

      for (const method of requiredMethods) {
        expect(typeof (impl as any)[method]).toBe('function')
      }
    })

    it('has id property set to codex', () => {
      expect(impl.id).toBe('codex')
    })

    it('has readonly capabilities property', () => {
      expect(impl.capabilities).toBeDefined()
    })
  })
})
