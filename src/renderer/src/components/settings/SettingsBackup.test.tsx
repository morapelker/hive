import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { toast } from '@/lib/toast'
import { SettingsBackup } from './SettingsBackup'

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

describe('SettingsBackup', () => {
  afterEach(() => {
    resetRendererRpcClientForTests()
    vi.clearAllMocks()
  })

  it('exports a backup and shows a success toast', async () => {
    const user = userEvent.setup()
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
      if (method === 'backupOps.exportBackup') {
        return { success: true, path: '/tmp/hive-backup.yaml', projectCount: 2 }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    render(<SettingsBackup />)

    await user.click(screen.getByTestId('backup-export'))
    await act(async () => {})

    expect(request).toHaveBeenCalledWith('backupOps.exportBackup', {})
    expect(toast.success).toHaveBeenCalledWith('Backup exported', {
      description: '2 projects → /tmp/hive-backup.yaml'
    })
  })

  it('shows an error toast when export fails', async () => {
    const user = userEvent.setup()
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
      if (method === 'backupOps.exportBackup') {
        return { success: false, error: 'disk full' }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    render(<SettingsBackup />)

    await user.click(screen.getByTestId('backup-export'))
    await act(async () => {})

    expect(toast.error).toHaveBeenCalledWith('Failed to export backup', {
      description: 'disk full'
    })
  })

  it('does not toast when export is canceled', async () => {
    const user = userEvent.setup()
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
      if (method === 'backupOps.exportBackup') {
        return { success: false, canceled: true }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    render(<SettingsBackup />)

    await user.click(screen.getByTestId('backup-export'))
    await act(async () => {})

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('opens the restore wizard after reading a backup file', async () => {
    const user = userEvent.setup()
    const backup = {
      version: 1,
      kind: 'hive-backup' as const,
      created_at: '2026-07-09T00:00:00.000Z',
      app_version: '1.2.12',
      projects: [{ name: 'hive' }, { name: 'other' }]
    }
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
      if (method === 'backupOps.openBackupFile') {
        return { canceled: false, backup }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    render(<SettingsBackup />)

    await user.click(screen.getByTestId('backup-restore'))
    await act(async () => {})

    expect(request).toHaveBeenCalledWith('backupOps.openBackupFile', {})
    expect(screen.getByTestId('restore-wizard')).not.toBeNull()
    expect(screen.getByText('2 projects found in this backup.')).not.toBeNull()
  })

  it('shows an error toast when opening the backup file fails', async () => {
    const user = userEvent.setup()
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
      if (method === 'backupOps.openBackupFile') {
        return { canceled: false, error: 'Failed to parse backup file: bad YAML' }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    render(<SettingsBackup />)

    await user.click(screen.getByTestId('backup-restore'))
    await act(async () => {})

    expect(toast.error).toHaveBeenCalledWith('Could not read backup file', {
      description: 'Failed to parse backup file: bad YAML'
    })
    expect(screen.queryByTestId('restore-wizard')).toBeNull()
  })

  it('does not toast when opening the backup file is canceled', async () => {
    const user = userEvent.setup()
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string) => {
      if (method === 'backupOps.openBackupFile') {
        return { canceled: true }
      }
      throw new Error(`unexpected method ${method}`)
    })
    setRendererRpcClient({ request, subscribe: vi.fn() })

    render(<SettingsBackup />)

    await user.click(screen.getByTestId('backup-restore'))
    await act(async () => {})

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.queryByTestId('restore-wizard')).toBeNull()
  })
})
