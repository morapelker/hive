import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const claudeProviders = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'opus-4.5': { id: 'opus-4.5', name: 'Opus 4.5' },
      'sonnet-4.6': { id: 'sonnet-4.6', name: 'Sonnet 4.6' }
    }
  }
]

const codexProviders = [
  {
    id: 'codex',
    name: 'Codex',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', variants: { medium: {}, high: {} } }
    }
  }
]

const apiMocks = vi.hoisted(() => ({
  dbApi: { setting: { get: vi.fn(), set: vi.fn() } },
  opencodeApi: { listModels: vi.fn(), setModel: vi.fn() },
  petApi: { hide: vi.fn(), show: vi.fn(), updateSettings: vi.fn() },
  settingsApi: { onSettingsUpdated: vi.fn() },
  systemApi: { detectAgentSdks: vi.fn() }
}))

vi.mock('@/api/db-api', () => ({ dbApi: apiMocks.dbApi }))
vi.mock('@/api/opencode-api', () => ({ opencodeApi: apiMocks.opencodeApi }))
vi.mock('@/api/pet-api', () => ({ petApi: apiMocks.petApi }))
vi.mock('@/api/settings-api', () => ({ settingsApi: apiMocks.settingsApi }))
vi.mock('@/api/system-api', () => ({ systemApi: apiMocks.systemApi }))

import { SettingsModels } from '@/components/settings/SettingsModels'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'

function mockListModels({ agentSdk }: { agentSdk?: string } = {}) {
  const providers = agentSdk === 'codex' ? codexProviders : claudeProviders
  return { success: true, value: { success: true, providers } }
}

describe('SettingsModels provider defaults', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.opencodeApi.listModels.mockImplementation(mockListModels)
    apiMocks.opencodeApi.setModel.mockResolvedValue({ success: true, value: { success: true } })
    apiMocks.petApi.hide.mockResolvedValue(undefined)
    apiMocks.petApi.show.mockResolvedValue(undefined)
    apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    apiMocks.systemApi.detectAgentSdks.mockResolvedValue({
      opencode: false,
      claude: true,
      codex: true
    })

    useSettingsStore.setState({
      defaultAgentSdk: 'claude-code',
      selectedModel: null,
      selectedModelByProvider: {},
      defaultModels: null,
      prContentModel: null,
      availableAgentSdks: { opencode: false, claude: true, codex: true }
    })
  })

  test('renders one provider default row per available provider', async () => {
    render(<SettingsModels />)

    const section = await screen.findByTestId('provider-defaults')
    expect(within(section).getByTestId('provider-default-claude-code')).toBeInTheDocument()
    expect(within(section).getByTestId('provider-default-codex')).toBeInTheDocument()
    expect(within(section).getByTestId('provider-default-claude-code-cli')).toBeInTheDocument()
    expect(within(section).getByTestId('provider-default-codex-cli')).toBeInTheDocument()
    expect(within(section).queryByTestId('provider-default-opencode')).not.toBeInTheDocument()
  })

  test('picking a model in a provider row stores it for that provider only', async () => {
    const user = userEvent.setup()
    render(<SettingsModels />)

    const row = await screen.findByTestId('provider-default-codex-cli')
    await user.click(within(row).getByTestId('model-selector'))
    await user.click(await screen.findByTestId('model-item-gpt-5.5'))

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedModelByProvider['codex-cli']).toEqual({
        agentSdk: 'codex-cli',
        providerID: 'codex',
        modelID: 'gpt-5.5',
        variant: 'medium'
      })
    })
    const state = useSettingsStore.getState()
    expect(state.selectedModel).toBeNull()
    expect(state.selectedModelByProvider['codex']).toBeUndefined()
    // The stored default is what a switch to Codex CLI resolves to.
    expect(resolveModelForSdk('codex-cli', state)).toMatchObject({
      modelID: 'gpt-5.5',
      variant: 'medium'
    })
    expect(resolveModelForSdk('claude-code', state)).toBeNull()
    // Persisted to the settings blob.
    const persisted = JSON.parse(apiMocks.dbApi.setting.set.mock.calls.at(-1)?.[1] as string)
    expect(persisted.selectedModelByProvider['codex-cli']).toMatchObject({ modelID: 'gpt-5.5' })
  })

  test('picking an effort in a provider row stores the effort with the model', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({
      selectedModelByProvider: {
        codex: { agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5', variant: 'medium' }
      }
    })
    render(<SettingsModels />)

    const row = await screen.findByTestId('provider-default-codex')
    await user.click(within(row).getByTestId('model-selector'))
    const chips = await screen.findByTestId('variant-chips-gpt-5.5')
    await user.click(within(chips).getByTestId('variant-chip-high'))

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedModelByProvider['codex']).toMatchObject({
        modelID: 'gpt-5.5',
        variant: 'high'
      })
    })
  })

  test('clearing a provider row removes only that provider default', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({
      selectedModelByProvider: {
        codex: { agentSdk: 'codex', providerID: 'codex', modelID: 'gpt-5.5' },
        'claude-code': { agentSdk: 'claude-code', providerID: 'anthropic', modelID: 'opus-4.5' }
      }
    })
    render(<SettingsModels />)

    const row = await screen.findByTestId('provider-default-codex')
    await user.click(within(row).getByRole('button', { name: 'Clear' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedModelByProvider['codex']).toBeUndefined()
    })
    expect(useSettingsStore.getState().selectedModelByProvider['claude-code']).toMatchObject({
      modelID: 'opus-4.5'
    })
  })

  test('the global default is stamped with its SDK and left out of provider defaults', async () => {
    const user = userEvent.setup()
    render(<SettingsModels />)

    const globalSelector = (await screen.findAllByTestId('model-selector'))[0]
    await user.click(globalSelector)
    // Both Claude rows list opus; the first item is the global selector's own.
    await user.click((await screen.findAllByTestId('model-item-opus-4.5'))[0])

    await waitFor(() => {
      expect(useSettingsStore.getState().selectedModel).toEqual({
        agentSdk: 'claude-code',
        providerID: 'anthropic',
        modelID: 'opus-4.5',
        variant: undefined
      })
    })
    expect(useSettingsStore.getState().selectedModelByProvider).toEqual({})
  })
})
