import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { useSettingsStore } from '@/stores/useSettingsStore'
import { SettingsTeleport } from './SettingsTeleport'

const initialSettingsState = useSettingsStore.getState()

describe('SettingsTeleport', () => {
  beforeEach(() => {
    useSettingsStore.setState(initialSettingsState, true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not report a URL-only remote as configured', () => {
    useSettingsStore.setState({ teleport: { url: 'http://remote.test', bootstrapToken: '' } })

    render(<SettingsTeleport />)

    expect(screen.queryByText('Status: missing bootstrap token')).not.toBeNull()
    expect((screen.getByTestId('teleport-test-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('authenticates with the bootstrap token when testing the remote', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      if (url.endsWith('/.well-known/hive/environment')) {
        return { ok: true, status: 200, json: async () => ({ mode: 'desktop' }) }
      }
      if (url.endsWith('/api/auth/bootstrap')) {
        return { ok: true, status: 200, json: async () => ({ session: { accessToken: 'access' } }) }
      }
      if (url.endsWith('/api/auth/ws-token')) {
        return { ok: true, status: 200, json: async () => ({ webSocketToken: { token: 'ws' } }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SettingsTeleport />)

    await user.type(screen.getByTestId('teleport-url-input'), ' http://remote.test/ ')
    await user.type(screen.getByTestId('teleport-token-input'), ' token ')
    await user.click(screen.getByTestId('teleport-test-button'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://remote.test/api/auth/bootstrap',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ bootstrapToken: 'token' })
        })
      )
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote.test/api/auth/ws-token',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer access' }
      })
    )
  })
})
