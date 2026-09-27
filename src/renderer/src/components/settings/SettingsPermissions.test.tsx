import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { toast } from '@/lib/toast'
import { SettingsPermissions } from './SettingsPermissions'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

const installRpc = (
  status: { supported: boolean; fullDiskAccess: boolean },
  openResult: { success: boolean; error?: string } = { success: true }
): ReturnType<typeof vi.fn> => {
  const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
    if (method === 'systemOps.getMacosPermissions') return status
    if (method === 'systemOps.openMacosPrivacySettings') return openResult
    throw new Error(`unexpected method ${method}`)
  })
  setRendererRpcClient({ request, subscribe: vi.fn() })
  return request
}

describe('SettingsPermissions', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.clearAllMocks()
  })

  it('shows Full Disk Access as granted', async () => {
    const request = installRpc({ supported: true, fullDiskAccess: true })

    render(<SettingsPermissions />)
    await act(async () => {})

    expect(request).toHaveBeenCalledWith('systemOps.getMacosPermissions', {})
    expect(screen.getByTestId('permissions-fda-status')).toHaveTextContent('Granted')
  })

  it('shows Full Disk Access as missing and opens its System Settings pane', async () => {
    const user = userEvent.setup()
    const request = installRpc({ supported: true, fullDiskAccess: false })

    render(<SettingsPermissions />)
    await act(async () => {})

    expect(screen.getByTestId('permissions-fda-status')).toHaveTextContent('Not granted')

    await user.click(screen.getByTestId('permissions-open-fda'))
    await act(async () => {})

    expect(request).toHaveBeenCalledWith('systemOps.openMacosPrivacySettings', {
      pane: 'fullDiskAccess'
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('opens the Files and Folders pane for per-folder answers', async () => {
    const user = userEvent.setup()
    const request = installRpc({ supported: true, fullDiskAccess: false })

    render(<SettingsPermissions />)
    await act(async () => {})

    await user.click(screen.getByTestId('permissions-open-files-and-folders'))
    await act(async () => {})

    expect(request).toHaveBeenCalledWith('systemOps.openMacosPrivacySettings', {
      pane: 'filesAndFolders'
    })
  })

  it('toasts when System Settings cannot be opened', async () => {
    const user = userEvent.setup()
    installRpc({ supported: true, fullDiskAccess: false }, { success: false, error: 'no open' })

    render(<SettingsPermissions />)
    await act(async () => {})

    await user.click(screen.getByTestId('permissions-open-fda'))
    await act(async () => {})

    expect(toast.error).toHaveBeenCalledWith('Could not open System Settings', {
      description: 'no open'
    })
  })

  it('re-probes on demand', async () => {
    const user = userEvent.setup()
    const request = installRpc({ supported: true, fullDiskAccess: false })

    render(<SettingsPermissions />)
    await act(async () => {})
    const before = request.mock.calls.filter(
      ([method]) => method === 'systemOps.getMacosPermissions'
    ).length

    await user.click(screen.getByTestId('permissions-check-again'))
    await act(async () => {})

    const after = request.mock.calls.filter(
      ([method]) => method === 'systemOps.getMacosPermissions'
    ).length
    expect(after).toBeGreaterThan(before)
  })

  it('says there is nothing to manage off macOS', async () => {
    installRpc({ supported: false, fullDiskAccess: false })

    render(<SettingsPermissions />)
    await act(async () => {})

    expect(screen.getByTestId('permissions-unsupported')).toBeInTheDocument()
    expect(screen.queryByTestId('permissions-open-fda')).toBeNull()
  })
})
