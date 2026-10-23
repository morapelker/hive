// Settings › Databases: defaults for new connections, read from and written to the dedicated
// `data_projects_defaults` setting (never the app_settings blob phones can write).

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setting = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock('@/api/db-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/db-api')>()
  return { dbApi: { ...original.dbApi, setting: { ...original.dbApi.setting, ...setting } } }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { SettingsDatabases } = await import('./SettingsDatabases')
const { useDataProjectStore, BUILTIN_DATA_PROJECT_DEFAULTS } =
  await import('@/stores/useDataProjectStore')

beforeEach(() => {
  vi.clearAllMocks()
  useDataProjectStore.getState().reset()
  setting.get.mockResolvedValue(
    JSON.stringify({ ...BUILTIN_DATA_PROJECT_DEFAULTS, environment: 'staging', defaultLimit: 500 })
  )
  setting.set.mockResolvedValue(true)
})

afterEach(() => cleanup())

// Other stores loaded alongside (useSettingsStore) may write their own keys; only ours count.
const savedDefaults = (): unknown[][] =>
  setting.set.mock.calls.filter(([key]) => key === 'data_projects_defaults')

const lastSaved = (): Record<string, unknown> =>
  JSON.parse(savedDefaults().at(-1)?.[1] as string) as Record<string, unknown>

describe('SettingsDatabases', () => {
  it('loads the stored defaults', async () => {
    render(<SettingsDatabases />)
    await waitFor(() => expect(screen.getByTestId('settings-databases-limit')).toHaveValue('500'))
    expect(setting.get).toHaveBeenCalledWith('data_projects_defaults')
    expect(screen.getByTestId('settings-databases-environment-staging')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('saves safe mode, environment and AI access under data_projects_defaults', async () => {
    render(<SettingsDatabases />)
    await waitFor(() => expect(useDataProjectStore.getState().defaultsLoaded).toBe(true))

    await userEvent.click(screen.getByTestId('settings-databases-safe-mode-read-only'))
    expect(savedDefaults()).toHaveLength(1)
    expect(lastSaved().safeMode).toBe('read-only')

    await userEvent.click(screen.getByTestId('settings-databases-environment-production'))
    expect(lastSaved().environment).toBe('production')

    await userEvent.click(screen.getByTestId('settings-databases-ai-data-access'))
    expect(lastSaved().allowAiDataAccess).toBe(true)
    expect(savedDefaults()).toHaveLength(3)
    // The whole object every time: environment and safe mode survive the later writes.
    expect(lastSaved()).toMatchObject({ safeMode: 'read-only', environment: 'production' })
  })

  it('validates the row limit and timeout before saving them on blur', async () => {
    render(<SettingsDatabases />)
    const limit = screen.getByTestId('settings-databases-limit')
    await waitFor(() => expect(limit).toHaveValue('500'))

    fireEvent.change(limit, { target: { value: '999999' } })
    fireEvent.blur(limit)
    expect(limit).toHaveAttribute('aria-invalid', 'true')
    expect(savedDefaults()).toHaveLength(0)

    fireEvent.change(limit, { target: { value: '250' } })
    fireEvent.blur(limit)
    await waitFor(() => expect(lastSaved().defaultLimit).toBe(250))

    const timeout = screen.getByTestId('settings-databases-timeout')
    fireEvent.change(timeout, { target: { value: '30' } })
    fireEvent.blur(timeout)
    await waitFor(() => expect(lastSaved().queryTimeoutMs).toBe(30_000))
  })
})
