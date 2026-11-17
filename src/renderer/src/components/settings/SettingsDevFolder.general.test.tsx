// The dev folder row where it lives: in Settings › General, mounted the way the suites of
// that section mount it (the settings, theme and shortcut stores and the toasts replaced by
// bare stand-ins), with the real flow behind "Move projects…", the real reloads after a move
// and the real dialog host beside it. One pass goes from the row to the dialog, through a
// move, and back to the row.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockSettingsState: Record<string, unknown> = {}

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector ? selector(mockSettingsState) : mockSettingsState,
    { getState: () => mockSettingsState }
  )
}))
vi.mock('@/stores/useThemeStore', () => ({ useThemeStore: () => ({ setTheme: vi.fn() }) }))
vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: () => ({ resetToDefaults: vi.fn() })
}))
vi.mock('@/lib/themes', () => ({ DEFAULT_THEME_ID: 'default' }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import { DevFolderMoveHost } from '@/components/settings/dev-folder/DevFolderMoveHost'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { CLOSED_DEV_FOLDER_MOVE, useDevFolderMoveStore } from '@/lib/dev-folder/store'
import {
  DEV_FOLDER_RPC,
  type DevFolderMovePlan,
  type DevFolderMoveResult,
  type DevFolderState
} from '@shared/types/dev-folder'

const OLD = '/Users/me/hive-projects'
const NEW = '/Users/me/Dev'

const defaultClient = getRendererRpcClient()

const stateOf = (count: number): DevFolderState => ({
  path: NEW,
  isDefault: false,
  defaultPath: OLD,
  exists: true,
  previousPaths: [OLD],
  leftBehind: { count, folders: count > 0 ? [OLD] : [] }
})

const PLAN: DevFolderMovePlan = {
  devFolder: NEW,
  sources: [OLD],
  candidates: [
    {
      projectId: 'p1',
      projectName: 'api',
      source: OLD,
      fromPath: `${OLD}/api`,
      toPath: `${NEW}/api`,
      skipReason: null,
      detail: null
    }
  ]
}

const MOVED: DevFolderMoveResult = {
  projectId: 'p1',
  projectName: 'api',
  action: 'moved',
  fromPath: `${OLD}/api`,
  toPath: `${NEW}/api`,
  skipReason: null,
  detail: null,
  warnings: ['The worktree "feature" could not be repaired.'],
  movedPaths: [{ from: `${OLD}/api`, to: `${NEW}/api` }]
}

/** The stand-in server: the dev folder calls answer here, every other call as in any suite. */
const server = { state: stateOf(1) as unknown }
const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === DEV_FOLDER_RPC.get) return server.state
  if (method === DEV_FOLDER_RPC.planMove) return PLAN
  if (method === DEV_FOLDER_RPC.moveProject) {
    // As the server: once the project moved, nothing is left behind.
    server.state = stateOf(0)
    return MOVED
  }
  return defaultClient.request(method, params)
})
const callsOf = (method: string): unknown[] =>
  request.mock.calls.filter(([name]) => name === method).map(([, params]) => params)

const baseSettings = (): Record<string, unknown> => ({
  autoStartSession: true,
  autoPullBeforeWorktree: true,
  boardMode: 'sticky-tab',
  followUpTriggerColumn: 'done',
  vimModeEnabled: false,
  keepAwakeEnabled: false,
  mergeConflictMode: 'always-ask',
  tipsEnabled: true,
  warnBeforeQuitting: true,
  breedType: 'dogs',
  showModelIcons: false,
  showModelProvider: false,
  usageIndicatorMode: 'current-agent',
  usageIndicatorProviders: [],
  defaultAgentSdk: 'opencode',
  availableAgentSdks: null,
  stripAtMentions: true,
  updateSetting: vi.fn(),
  resetToDefaults: vi.fn()
})

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

beforeEach(() => {
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  mockSettingsState = baseSettings()
  server.state = stateOf(1)
  setRendererRpcClient({ request: request as never, subscribe: () => () => {} })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
  useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
  setRendererRpcClient(defaultClient)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('Settings › General with the dev folder row', () => {
  it('draws the row between the heading and "Warn before quitting"', async () => {
    const { container } = render(<SettingsGeneral />)
    const row = await screen.findByTestId('dev-folder')

    const blocks = Array.from(container.firstElementChild?.children ?? [])
    expect(blocks[0]).toHaveTextContent('General')
    expect(blocks[1]).toBe(row)
    expect(blocks[2]).toContainElement(screen.getByTestId('warn-before-quitting-toggle'))
    expect(screen.getByTestId('dev-folder-path')).toHaveValue(NEW)
  })

  it('is the section it was when the server answers no dev folder', async () => {
    setRendererRpcClient(defaultClient)

    const { container } = render(<SettingsGeneral />)
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))))

    expect(screen.queryByTestId('dev-folder')).not.toBeInTheDocument()
    const blocks = Array.from(container.firstElementChild?.children ?? [])
    expect(blocks[0]).toHaveTextContent('General')
    expect(blocks[1]).toContainElement(screen.getByTestId('warn-before-quitting-toggle'))
  })

  it('says under "Reset All to Defaults" that the dev folder is kept', () => {
    render(<SettingsGeneral />)

    const reset = screen.getByTestId('reset-all-settings')
    expect(reset.parentElement).toHaveTextContent(
      'This will reset all settings, theme, and keyboard shortcuts to their defaults. The dev folder is kept.'
    )
  })

  it('draws the row, with nothing to change, when opened while projects are being moved', async () => {
    useDevFolderMoveStore.setState({ phase: 'running' })

    render(<SettingsGeneral />)
    await screen.findByTestId('dev-folder')

    expect(screen.getByTestId('dev-folder-path')).toHaveValue(NEW)
    expect(screen.getByTestId('dev-folder-path')).toHaveAttribute('readonly')
    expect(screen.getByTestId('dev-folder-browse')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-use-default')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-move-open')).toBeDisabled()
    expect(callsOf(DEV_FOLDER_RPC.planMove)).toHaveLength(0)

    // The run is over and its dialog closed: the row counts again and can be used.
    server.state = stateOf(0)
    act(() => useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE }))

    await waitFor(() =>
      expect(screen.queryByTestId('dev-folder-move-hint')).not.toBeInTheDocument()
    )
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(2)
    expect(screen.getByTestId('dev-folder-path')).not.toHaveAttribute('readonly')
    expect(screen.getByTestId('dev-folder-browse')).toBeEnabled()
  })

  it('goes from the row to the dialog, through a move, and back to the row', async () => {
    render(
      <>
        <SettingsGeneral />
        <DevFolderMoveHost />
      </>
    )
    expect(await screen.findByTestId('dev-folder-move-hint')).toHaveTextContent(
      `1 project is still in ${OLD}.`
    )
    expect(callsOf(DEV_FOLDER_RPC.planMove)).toHaveLength(0)

    fireEvent.click(screen.getByTestId('dev-folder-move-open'))
    const dialog = await screen.findByTestId('dev-folder-move-dialog')
    await waitFor(() => expect(dialog).toHaveAttribute('data-phase', 'confirm'))
    expect(screen.getByTestId('dev-folder-move-row-p1')).toHaveTextContent(`${NEW}/api`)
    expect(callsOf(DEV_FOLDER_RPC.planMove)).toEqual([{}])
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(1)

    fireEvent.click(screen.getByTestId('dev-folder-move-start'))
    await waitFor(() => expect(dialog).toHaveAttribute('data-phase', 'summary'))
    expect(callsOf(DEV_FOLDER_RPC.moveProject)).toEqual([
      { projectId: 'p1', expectedToPath: `${NEW}/api` }
    ])
    expect(screen.getByTestId('dev-folder-move-lead')).toHaveTextContent(
      `Moved 1 project to ${NEW}.`
    )
    expect(screen.getByTestId('dev-folder-move-row-p1')).toHaveTextContent(
      'The worktree "feature" could not be repaired.'
    )
    // The window reloaded its projects after the move, through the real stores.
    expect(callsOf('db.project.getAll').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('dev-folder-move-close'))
    await waitFor(() =>
      expect(screen.queryByTestId('dev-folder-move-dialog')).not.toBeInTheDocument()
    )
    // Back in the row: the dev folder is read again, and nothing is left behind.
    await waitFor(() =>
      expect(screen.queryByTestId('dev-folder-move-hint')).not.toBeInTheDocument()
    )
    expect(callsOf(DEV_FOLDER_RPC.get)).toHaveLength(2)
    expect(useDevFolderMoveStore.getState()).toEqual(CLOSED_DEV_FOLDER_MOVE)
  })
})
