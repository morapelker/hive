import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteTerminalDialog } from './RemoteTerminalDialog'
import type { RemoteLaunchClientInfo } from '@shared/types/remote-launch'

// useSettingsStore schedules a one-shot 200ms timer on module import that
// reloads settings via the renderer RPC client (see MEMORY: settings-store
// timer test flake). Mocking the module entirely — rather than using the
// real store + setState like WorktreePickerModal.remote.test.tsx does —
// sidesteps that timer altogether since the real module body never runs.
const settingsMocks = vi.hoisted(() => ({
  state: { teleport: null as { url: string; bootstrapToken: string } | null }
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof settingsMocks.state) => unknown) => selector(settingsMocks.state),
    { getState: () => settingsMocks.state }
  )
}))

const remoteLaunch: RemoteLaunchClientInfo = {
  role: 'client',
  url: 'https://remote.example.com',
  remoteSessionId: 'remote-session-1',
  remoteWorktreeId: 'remote-worktree-1',
  remoteProjectId: 'remote-project-1',
  tmuxSession: 'hive-launch-1',
  branch: 'feature/x',
  worktreePath: '/remote/worktree',
  launchedAt: '2026-01-01T00:00:00.000Z'
}

describe('RemoteTerminalDialog', () => {
  afterEach(() => {
    cleanup()
    settingsMocks.state.teleport = null
  })

  it('renders the settings-missing error state (no retry, Close only) when teleport settings are absent', async () => {
    render(<RemoteTerminalDialog open onOpenChange={vi.fn()} remoteLaunch={remoteLaunch} />)

    expect(await screen.findByTestId('remote-terminal-error')).toHaveTextContent(
      'Teleport settings not configured'
    )
    expect(screen.queryByTestId('remote-terminal-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('remote-terminal-close')).toBeInTheDocument()
  })

  it('renders the settings-missing error state when the bootstrap token is blank', async () => {
    settingsMocks.state.teleport = { url: 'https://remote.example.com', bootstrapToken: '' }

    render(<RemoteTerminalDialog open onOpenChange={vi.fn()} remoteLaunch={remoteLaunch} />)

    expect(await screen.findByTestId('remote-terminal-error')).toHaveTextContent(
      'Teleport settings not configured'
    )
  })

  it('shows the tmux session name in the dialog title', async () => {
    render(<RemoteTerminalDialog open onOpenChange={vi.fn()} remoteLaunch={remoteLaunch} />)

    expect(screen.getByTestId('remote-terminal-dialog')).toHaveTextContent(
      'Remote session — hive-launch-1'
    )
  })
})
