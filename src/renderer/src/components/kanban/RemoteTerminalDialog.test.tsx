import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteTerminalDialog } from './RemoteTerminalDialog'
import type { ServerEvent } from '@shared/rpc/protocol'
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

// Minimal xterm.js mock: RemoteTerminalDialog only calls open/clear/write/
// onData/focus/dispose/loadAddon on a Terminal instance. We track every
// constructed instance so tests can assert `open` was called with the real
// container element.
const xtermMocks = vi.hoisted(() => {
  class MockTerminal {
    open = vi.fn()
    clear = vi.fn()
    write = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    focus = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
  }
  const instances: MockTerminal[] = []
  return { instances, MockTerminal }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => {
    const instance = new xtermMocks.MockTerminal()
    xtermMocks.instances.push(instance)
    return instance
  })
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 }))
  }))
}))

// jsdom has no ResizeObserver.
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

// HiveClient mock: `attachTerminal` resolves a terminal id, `subscribe`
// captures listeners so tests can push server events directly.
const hiveClientMocks = vi.hoisted(() => ({
  request: vi.fn(async (method: string) => {
    if (method === 'remoteLaunchOps.attachTerminal') return { terminalId: 't1' }
    return undefined
  }),
  subscribers: new Map<string, (event: ServerEvent) => void>(),
  close: vi.fn()
}))

vi.mock('@/api/hive-client', () => ({
  HiveClient: vi.fn().mockImplementation(() => ({
    request: hiveClientMocks.request,
    subscribe: vi.fn((channel: string, listener: (event: ServerEvent) => void) => {
      hiveClientMocks.subscribers.set(channel, listener)
      return () => hiveClientMocks.subscribers.delete(channel)
    }),
    close: hiveClientMocks.close
  }))
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
    xtermMocks.instances.length = 0
    hiveClientMocks.subscribers.clear()
    hiveClientMocks.request.mockClear()
    hiveClientMocks.close.mockClear()
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

  // Regression test: Radix's Portal renders `null` on the commit where it
  // first mounts (its own `mounted` state starts false, flipped true by a
  // useLayoutEffect — see @radix-ui/react-portal). Because Presence tears
  // the Portal down whenever the dialog closes, this replays on every open,
  // not just the first. The `open` effect used to fire connect() off of a
  // plain ref read (`containerRef.current`), which raced this and was still
  // null when `ensureTerminalMounted()` ran — so `term.open(container)` was
  // never called and the terminal stayed permanently blank even though the
  // connection reached `connected` state. Mounting off `containerEl` state
  // (set via a callback ref) instead of a plain ref closes that race.
  it('mounts the xterm terminal into the portal-rendered container once it is attached to the DOM', async () => {
    settingsMocks.state.teleport = { url: 'https://remote.example.com', bootstrapToken: 'tok-1' }

    render(<RemoteTerminalDialog open onOpenChange={vi.fn()} remoteLaunch={remoteLaunch} />)

    await waitFor(() =>
      expect(hiveClientMocks.request).toHaveBeenCalledWith(
        'remoteLaunchOps.attachTerminal',
        expect.objectContaining({ remoteSessionId: remoteLaunch.remoteSessionId })
      )
    )

    const container = await screen.findByTestId('remote-terminal-container')

    await waitFor(() => expect(xtermMocks.instances).toHaveLength(1))
    expect(xtermMocks.instances[0]?.open).toHaveBeenCalledWith(container)
  })

  it('routes a terminal:data: server event to the mounted xterm instance', async () => {
    settingsMocks.state.teleport = { url: 'https://remote.example.com', bootstrapToken: 'tok-1' }

    render(<RemoteTerminalDialog open onOpenChange={vi.fn()} remoteLaunch={remoteLaunch} />)

    await waitFor(() => expect(xtermMocks.instances).toHaveLength(1))
    await waitFor(() => expect(hiveClientMocks.subscribers.get('terminal:data:t1')).toBeTypeOf('function'))

    const dataListener = hiveClientMocks.subscribers.get('terminal:data:t1')

    act(() => {
      dataListener?.({ channel: 'terminal:data:t1', payload: 'hello world' } as ServerEvent)
    })

    expect(xtermMocks.instances[0]?.write).toHaveBeenCalledWith('hello world')
  })
})
