import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CustomClaudeProvider } from '@shared/types/custom-provider'
import { SettingsCustomProviders } from './SettingsCustomProviders'

const initialSettingsState = useSettingsStore.getState()

function seedProvider(overrides: Partial<CustomClaudeProvider> = {}): CustomClaudeProvider {
  const provider: CustomClaudeProvider = {
    id: 'prov-1',
    name: 'Proxy',
    command: 'claudex',
    usageProvider: 'none',
    models: [],
    ...overrides
  }
  useSettingsStore.setState({ customProviders: [provider] })
  return provider
}

function currentModels(): NonNullable<CustomClaudeProvider['models']> {
  return useSettingsStore.getState().customProviders?.[0]?.models ?? []
}

describe('SettingsCustomProviders models editor', () => {
  beforeEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
  })

  it('adds a model row with empty name/slug and no efforts', async () => {
    const user = userEvent.setup()
    seedProvider()
    render(<SettingsCustomProviders />)

    await user.click(screen.getByTestId('custom-provider-model-add'))

    const models = currentModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ name: '', slug: '', efforts: [] })
    expect(models[0].id).toBeTruthy()
  })

  it('persists typed name and slug into the settings store', async () => {
    const user = userEvent.setup()
    seedProvider({ models: [{ id: 'm1', name: '', slug: '', efforts: [] }] })
    render(<SettingsCustomProviders />)

    await user.type(screen.getByTestId('custom-provider-model-name'), 'GLM 4.6')
    await user.type(screen.getByTestId('custom-provider-model-slug'), 'glm-4.6')

    expect(currentModels()[0]).toMatchObject({ name: 'GLM 4.6', slug: 'glm-4.6' })
  })

  it('toggles effort chips and stores them in canonical order', async () => {
    const user = userEvent.setup()
    seedProvider({ models: [{ id: 'm1', name: 'GLM', slug: 'glm-4.6', efforts: [] }] })
    render(<SettingsCustomProviders />)

    await user.click(screen.getByTestId('custom-provider-model-effort-high'))
    await user.click(screen.getByTestId('custom-provider-model-effort-low'))
    expect(currentModels()[0].efforts).toEqual(['low', 'high'])

    await user.click(screen.getByTestId('custom-provider-model-effort-high'))
    expect(currentModels()[0].efforts).toEqual(['low'])
  })

  it('removes a model row', async () => {
    const user = userEvent.setup()
    seedProvider({
      models: [
        { id: 'm1', name: 'A', slug: 'a', efforts: [] },
        { id: 'm2', name: 'B', slug: 'b', efforts: [] }
      ]
    })
    render(<SettingsCustomProviders />)

    const removeButtons = screen.getAllByTestId('custom-provider-model-remove')
    await user.click(removeButtons[0])

    const models = currentModels()
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('m2')
  })

  it('flags blank and duplicate slugs without blocking the save', () => {
    seedProvider({
      models: [
        { id: 'm1', name: 'Blank', slug: '', efforts: [] },
        { id: 'm2', name: 'One', slug: 'dup', efforts: [] },
        { id: 'm3', name: 'Two', slug: 'dup', efforts: [] }
      ]
    })
    render(<SettingsCustomProviders />)

    expect(screen.getAllByText(/Slug required/)).toHaveLength(1)
    expect(screen.getAllByText(/Duplicate slug/)).toHaveLength(2)
    // All rows are still persisted — validation is presentational only.
    expect(currentModels()).toHaveLength(3)
  })
})
