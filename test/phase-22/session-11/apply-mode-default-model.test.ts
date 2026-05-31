import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore, type AgentSdk, type SelectedModel } from '@/stores/useSettingsStore'

const baseSession = {
  id: 'session-1',
  worktree_id: 'wt-1',
  project_id: 'project-1',
  connection_id: null,
  name: 'Session 1',
  status: 'active',
  opencode_session_id: null,
  agent_sdk: 'claude-code',
  mode: 'build',
  session_type: 'default',
  model_provider_id: 'anthropic',
  model_id: 'opus-4.5',
  model_variant: 'high',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null
} as const

const claudePlanDefault: SelectedModel = {
  agentSdk: 'claude-code',
  providerID: 'anthropic',
  modelID: 'sonnet-4.6',
  variant: 'high'
}

const codexPlanDefault: SelectedModel = {
  agentSdk: 'codex',
  providerID: 'codex',
  modelID: 'gpt-5.5',
  variant: 'xhigh'
}

const claudeUnsetSdkDefault: SelectedModel = {
  providerID: 'anthropic',
  modelID: 'sonnet-4.6',
  variant: 'high'
}

const claudeFallback: SelectedModel = {
  providerID: 'anthropic',
  modelID: 'opus-4.5',
  variant: 'high'
}

function seedSession(agentSdk: AgentSdk = 'claude-code'): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([
      [
        'wt-1',
        [
          {
            ...baseSession,
            agent_sdk: agentSdk
          }
        ]
      ]
    ]),
    sessionsByConnection: new Map(),
    boardAssistantByProject: new Map()
  })
}

function seedSettings(planDefault: SelectedModel | null, fallback?: SelectedModel): void {
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code',
    defaultModels: {
      build: null,
      plan: planDefault,
      ask: null,
      review: null
    },
    selectedModel: null,
    selectedModelByProvider: fallback
      ? {
          'claude-code': fallback
        }
      : {}
  })
}

describe('applyModeDefaultModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    seedSession()
    seedSettings(null)
  })

  test('applies mode default when modeDefault.agentSdk matches the session SDK', async () => {
    seedSettings(claudePlanDefault)
    const setSessionModel = vi
      .spyOn(useSessionStore.getState(), 'setSessionModel')
      .mockResolvedValue(undefined)

    await useSessionStore.getState().applyModeDefaultModel('session-1', 'plan')

    expect(setSessionModel).toHaveBeenCalledWith('session-1', claudePlanDefault, {
      skipGlobalUpdate: true
    })
  })

  test('applies mode default when modeDefault.agentSdk is unset', async () => {
    seedSettings(claudeUnsetSdkDefault)
    const setSessionModel = vi
      .spyOn(useSessionStore.getState(), 'setSessionModel')
      .mockResolvedValue(undefined)

    await useSessionStore.getState().applyModeDefaultModel('session-1', 'plan')

    expect(setSessionModel).toHaveBeenCalledWith('session-1', claudeUnsetSdkDefault, {
      skipGlobalUpdate: true
    })
  })

  test('does not apply unset-SDK mode default to a non-default live session SDK', async () => {
    seedSession('codex')
    seedSettings(claudeUnsetSdkDefault)
    const setSessionModel = vi
      .spyOn(useSessionStore.getState(), 'setSessionModel')
      .mockResolvedValue(undefined)

    await useSessionStore.getState().applyModeDefaultModel('session-1', 'plan')

    expect(setSessionModel).not.toHaveBeenCalled()
  })

  test('does not change the model when modeDefault.agentSdk differs from the session SDK', async () => {
    seedSettings(codexPlanDefault)
    const setSessionModel = vi
      .spyOn(useSessionStore.getState(), 'setSessionModel')
      .mockResolvedValue(undefined)

    await useSessionStore.getState().applyModeDefaultModel('session-1', 'plan')

    expect(setSessionModel).not.toHaveBeenCalled()
  })

  test('falls back to the session SDK default when no mode default is configured', async () => {
    seedSettings(null, claudeFallback)
    const setSessionModel = vi
      .spyOn(useSessionStore.getState(), 'setSessionModel')
      .mockResolvedValue(undefined)

    await useSessionStore.getState().applyModeDefaultModel('session-1', 'plan')

    expect(setSessionModel).toHaveBeenCalledWith('session-1', claudeFallback, {
      skipGlobalUpdate: true
    })
  })

  test('does not change terminal session models', async () => {
    seedSession('terminal')
    seedSettings(claudePlanDefault)
    const setSessionModel = vi
      .spyOn(useSessionStore.getState(), 'setSessionModel')
      .mockResolvedValue(undefined)

    await useSessionStore.getState().applyModeDefaultModel('session-1', 'plan')

    expect(setSessionModel).not.toHaveBeenCalled()
  })
})
