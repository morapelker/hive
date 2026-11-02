// The assistant's model: the user's default (default SDK → its launch model), folded onto an
// installed provider; a panel override goes through the same resolver; the header label.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({
  state: {
    defaultAgentSdk: 'claude-code-cli' as string | null,
    availableAgentSdks: { claude: true, codex: true, opencode: true } as {
      claude: boolean
      codex: boolean
      opencode: boolean
    } | null
  },
  launchModel: {
    providerID: 'anthropic',
    modelID: 'claude-opus-4-5-20251101',
    variant: 'ultracode'
  } as {
    providerID: string
    modelID: string
    variant?: string
  }
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: { getState: () => settings.state },
  resolvePreferredAgentSdk: () => {
    const sdk = settings.state.defaultAgentSdk ?? 'opencode'
    return sdk === 'terminal' ? 'opencode' : sdk
  }
}))

vi.mock('@/lib/launch-model', () => ({
  resolveDefaultLaunchModel: () => settings.launchModel
}))

const {
  defaultAssistantModel,
  describeAssistantGeneration,
  resolveDataAssistantGeneration,
  shortModelName
} = await import('./assistant-generation')

beforeEach(() => {
  settings.state = {
    defaultAgentSdk: 'claude-code-cli',
    availableAgentSdks: { claude: true, codex: true, opencode: true }
  }
  settings.launchModel = {
    providerID: 'anthropic',
    modelID: 'claude-opus-4-5-20251101',
    variant: 'ultracode'
  }
})

describe('resolveDataAssistantGeneration', () => {
  it("uses the default SDK's launch model, CLI folded onto the SDK and ultracode as xhigh", () => {
    expect(defaultAssistantModel()).toEqual({
      agentSdk: 'claude-code-cli',
      providerID: 'anthropic',
      modelID: 'claude-opus-4-5-20251101',
      variant: 'ultracode'
    })
    expect(resolveDataAssistantGeneration()).toEqual({
      provider: 'claude-code',
      model: 'claude-opus-4-5-20251101',
      effort: 'xhigh'
    })
  })

  it('gives OpenCode a provider/model slug', () => {
    settings.state.defaultAgentSdk = 'opencode'
    settings.launchModel = { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }
    expect(resolveDataAssistantGeneration()).toEqual({
      provider: 'opencode',
      model: 'anthropic/claude-sonnet-4-5'
    })
  })

  it('honours a panel override, falling back when its provider is not installed', () => {
    expect(
      resolveDataAssistantGeneration({
        agentSdk: 'codex',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variant: 'high'
      })
    ).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'high' })

    settings.state.availableAgentSdks = { claude: true, codex: false, opencode: false }
    expect(
      resolveDataAssistantGeneration({
        agentSdk: 'codex',
        providerID: 'openai',
        modelID: 'gpt-5.5'
      })
    ).toEqual({ provider: 'claude-code' })
  })

  it('returns null when no provider is installed', () => {
    settings.state.availableAgentSdks = { claude: false, codex: false, opencode: false }
    expect(resolveDataAssistantGeneration()).toBeNull()
  })
})

describe('describeAssistantGeneration', () => {
  it('names provider, short model and effort', () => {
    expect(
      describeAssistantGeneration({
        provider: 'claude-code',
        model: 'claude-opus-4-5-20251101',
        effort: 'high'
      })
    ).toBe('Claude Code · opus 4.5 · high')
    expect(
      describeAssistantGeneration({ provider: 'opencode', model: 'anthropic/claude-sonnet-4-5' })
    ).toBe('OpenCode · sonnet 4.5')
    expect(describeAssistantGeneration({ provider: 'codex' })).toBe('Codex')
    expect(describeAssistantGeneration(null)).toBe('No AI provider available')
    expect(shortModelName('gpt-5.5')).toBe('gpt-5.5')
  })
})
