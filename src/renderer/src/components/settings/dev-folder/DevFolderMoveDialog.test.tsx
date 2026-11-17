// The "Move projects" dialog draws each phase of the state kept in lib/dev-folder/store and
// sends its buttons to the flow. The flow itself (lib/dev-folder/move-projects) is faked here
// and tested on its own; the dialog primitives are the real ones, so what Escape, a click
// outside and the close button do is what they do in the app.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const actions = vi.hoisted(() => ({
  openDevFolderMove: vi.fn(async () => undefined),
  recheckDevFolderMove: vi.fn(async () => undefined),
  toggleDevFolderMoveRow: vi.fn((_projectId: string) => undefined),
  startDevFolderMove: vi.fn(async () => undefined),
  cancelRemainingDevFolderMove: vi.fn(),
  closeDevFolderMove: vi.fn()
}))
vi.mock('@/lib/dev-folder/move-projects', () => actions)

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  CLOSED_DEV_FOLDER_MOVE,
  rowsOfDevFolderPlan,
  useDevFolderMoveStore,
  type DevFolderMoveRow,
  type DevFolderMoveState
} from '@/lib/dev-folder/store'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTerminalTabStore } from '@/stores/useTerminalTabStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type {
  DevFolderMoveCandidate,
  DevFolderMovePlan,
  DevFolderMoveResult
} from '@shared/types/dev-folder'
import { DevFolderMoveHost } from './DevFolderMoveHost'

const OLD = '/Users/me/hive-projects'
const OLDER = '/Volumes/Work/code'
const NEW = '/Users/me/Dev'

const candidate = (
  id: string,
  over: Partial<DevFolderMoveCandidate> = {}
): DevFolderMoveCandidate => ({
  projectId: id,
  projectName: id,
  source: OLD,
  fromPath: `${OLD}/${id}`,
  toPath: `${NEW}/${id}`,
  skipReason: null,
  detail: null,
  ...over
})

const PLAN: DevFolderMovePlan = {
  devFolder: NEW,
  sources: [OLD, OLDER],
  candidates: [
    candidate('api'),
    candidate('legacy', { source: OLDER, fromPath: `${OLDER}/legacy` }),
    candidate('web'),
    candidate('docs', {
      skipReason: 'exists',
      detail: 'The dev folder already has a folder named docs.'
    })
  ]
}

const result = (id: string, over: Partial<DevFolderMoveResult> = {}): DevFolderMoveResult => ({
  projectId: id,
  projectName: id,
  action: 'moved',
  fromPath: `${OLD}/${id}`,
  toPath: `${NEW}/${id}`,
  skipReason: null,
  detail: null,
  warnings: [],
  movedPaths: [{ from: `${OLD}/${id}`, to: `${NEW}/${id}` }],
  ...over
})

/** The rows of PLAN, with the given rows changed. */
const rowsWith = (changes: Record<string, Partial<DevFolderMoveRow>> = {}): DevFolderMoveRow[] =>
  rowsOfDevFolderPlan(PLAN).map((row) => ({ ...row, ...changes[row.candidate.projectId] }))

const stateOf = (change: Partial<DevFolderMoveState>): DevFolderMoveState => ({
  ...CLOSED_DEV_FOLDER_MOVE,
  plan: PLAN,
  rows: rowsWith(),
  ...change
})

function show(change: Partial<DevFolderMoveState> | null): void {
  useDevFolderMoveStore.setState(change ? stateOf(change) : { ...CLOSED_DEV_FOLDER_MOVE })
  render(<DevFolderMoveHost />)
}

const dialog = (): HTMLElement => screen.getByTestId('dev-folder-move-dialog')
const rowOf = (id: string): HTMLElement => screen.getByTestId(`dev-folder-move-row-${id}`)
const lead = (): string => screen.getByTestId('dev-folder-move-lead').textContent ?? ''

type WorktreeRow = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]
type SessionRow = NonNullable<
  ReturnType<ReturnType<typeof useSessionStore.getState>['sessionsByWorktree']['get']>
>[number]
type ConnectionRow = ReturnType<typeof useConnectionStore.getState>['connections'][number]

// Only what the dialog reads of a row; the rest does not matter to it.
const worktreeRow = (id: string, projectId: string, path: string): WorktreeRow =>
  ({ id, project_id: projectId, path }) as WorktreeRow
const sessionRow = (id: string, agentSdk: string): SessionRow =>
  ({ id, agent_sdk: agentSdk }) as SessionRow

/** The worktree rows the window holds, by project. */
const holdWorktrees = (rows: Record<string, WorktreeRow[]>): void =>
  useWorktreeStore.setState({ worktreesByProject: new Map(Object.entries(rows)) })

const initialBackend = useSettingsStore.getState().embeddedTerminalBackend

/** The dialog listens for clicks outside it a moment after it opened. */
const afterOpening = async (): Promise<void> => {
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
  useFileViewerStore.setState({ dirtyFiles: new Set() })
  useWorktreeStore.setState({ worktreesByProject: new Map() })
  useTerminalTabStore.setState({ tabsByWorktree: new Map() })
  useSessionStore.setState({ sessionsByWorktree: new Map(), sessionsByConnection: new Map() })
  useConnectionStore.setState({ connections: [] })
  useSettingsStore.setState({ embeddedTerminalBackend: initialBackend })
})

describe('DevFolderMoveHost', () => {
  it('renders nothing while the dialog is closed, and the dialog once it is opened', () => {
    show(null)
    expect(screen.queryByTestId('dev-folder-move-dialog')).not.toBeInTheDocument()

    act(() => useDevFolderMoveStore.setState(stateOf({ phase: 'planning', plan: null, rows: [] })))

    expect(dialog()).toHaveAttribute('data-phase', 'planning')
    expect(screen.getByText('Move projects to the dev folder')).toBeInTheDocument()
  })
})

describe('DevFolderMoveDialog: waiting for the plan', () => {
  it('shows that it is checking, with Cancel as the only button', () => {
    show({ phase: 'planning', plan: null, rows: [] })

    expect(screen.getByTestId('dev-folder-move-loading')).toHaveTextContent(
      'Checking each project.'
    )
    expect(screen.queryByTestId('dev-folder-move-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-recheck')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('dev-folder-move-close'))
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(1)
  })
})

describe('DevFolderMoveDialog: the list to confirm', () => {
  it('says where the projects go', () => {
    show({ phase: 'confirm' })

    expect(dialog()).toHaveAttribute('data-phase', 'confirm')
    expect(lead()).toBe(
      `Moves each project folder into ${NEW} and updates its path everywhere in Hive.`
    )
    expect(screen.queryByTestId('dev-folder-move-loading')).not.toBeInTheDocument()
  })

  it('groups the projects under the folder they sit in', () => {
    show({ phase: 'confirm' })

    const groups = screen.getAllByTestId('dev-folder-move-source')
    expect(groups).toHaveLength(2)
    expect(within(groups[0]).getByRole('heading')).toHaveTextContent(OLD)
    expect(within(groups[1]).getByRole('heading')).toHaveTextContent(OLDER)
    // Each project is under its own folder, in the plan's order.
    const idsIn = (group: HTMLElement): (string | null)[] =>
      Array.from(group.querySelectorAll('[data-testid^="dev-folder-move-row-"]')).map((row) =>
        row.getAttribute('data-testid')
      )
    expect(idsIn(groups[0])).toEqual([
      'dev-folder-move-row-api',
      'dev-folder-move-row-web',
      'dev-folder-move-row-docs'
    ])
    expect(idsIn(groups[1])).toEqual(['dev-folder-move-row-legacy'])
  })

  it('gives a project that can move a ticked checkbox and shows where it goes', () => {
    show({ phase: 'confirm' })

    const row = rowOf('legacy')
    expect(row).toHaveAttribute('data-status', 'pending')
    expect(row).toHaveTextContent('legacy')
    expect(row).toHaveTextContent(`${OLDER}/legacy`)
    expect(row).toHaveTextContent(`${NEW}/legacy`)
    const box = screen.getByTestId('dev-folder-move-check-legacy')
    expect(box).toHaveAttribute('role', 'checkbox')
    expect(box).toHaveAttribute('aria-checked', 'true')
    expect(box).toHaveAccessibleName('Move legacy')
  })

  it('shows why a project stays, with no checkbox', () => {
    show({ phase: 'confirm' })

    const row = rowOf('docs')
    expect(row).toHaveAttribute('data-status', 'skipped')
    expect(row).toHaveTextContent('The dev folder already has a folder named docs.')
    expect(screen.queryByTestId('dev-folder-move-check-docs')).not.toBeInTheDocument()
    expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument()
    // Where it would have gone is not shown for a project that does not go.
    expect(row).not.toHaveTextContent(`${NEW}/docs`)
  })

  it('sends a click on a checkbox, or on its row, to the flow', () => {
    show({ phase: 'confirm' })

    fireEvent.click(screen.getByTestId('dev-folder-move-check-api'))
    expect(actions.toggleDevFolderMoveRow).toHaveBeenCalledTimes(1)
    expect(actions.toggleDevFolderMoveRow).toHaveBeenLastCalledWith('api')

    fireEvent.click(within(rowOf('web')).getByText('web'))
    expect(actions.toggleDevFolderMoveRow).toHaveBeenCalledTimes(2)
    expect(actions.toggleDevFolderMoveRow).toHaveBeenLastCalledWith('web')
  })

  it('shows an unticked project as unticked', () => {
    show({ phase: 'confirm', rows: rowsWith({ web: { selected: false } }) })

    expect(screen.getByTestId('dev-folder-move-check-web')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('dev-folder-move-check-api')).toHaveAttribute('aria-checked', 'true')
  })

  it('names the number of projects on the button that moves them', () => {
    show({ phase: 'confirm' })
    const start = screen.getByTestId('dev-folder-move-start')
    expect(start).toHaveTextContent('Move 3 projects')
    expect(start).toBeEnabled()

    act(() =>
      useDevFolderMoveStore.setState({
        rows: rowsWith({ api: { selected: false }, legacy: { selected: false } })
      })
    )
    expect(start).toHaveTextContent('Move 1 project')
    expect(start).toBeEnabled()

    fireEvent.click(start)
    expect(actions.startDevFolderMove).toHaveBeenCalledTimes(1)
  })

  it('cannot start with nothing ticked', () => {
    show({
      phase: 'confirm',
      rows: rowsWith({
        api: { selected: false },
        legacy: { selected: false },
        web: { selected: false }
      })
    })

    const start = screen.getByTestId('dev-folder-move-start')
    expect(start).toBeDisabled()
    expect(start).toHaveTextContent('Move projects')

    fireEvent.click(start)
    expect(actions.startDevFolderMove).not.toHaveBeenCalled()
  })

  it('"Check again" asks the flow for a new plan and waits for it in place', () => {
    show({ phase: 'confirm' })

    fireEvent.click(screen.getByTestId('dev-folder-move-recheck'))
    expect(actions.recheckDevFolderMove).toHaveBeenCalledTimes(1)

    act(() => useDevFolderMoveStore.setState({ rechecking: true }))
    // The list stays on screen; nothing in it can be changed until the new one is there.
    expect(dialog()).toHaveAttribute('data-phase', 'confirm')
    expect(rowOf('api')).toBeInTheDocument()
    expect(screen.getByTestId('dev-folder-move-recheck')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-move-start')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-move-check-api')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-move-close')).toBeEnabled()
  })

  it('says so when no project is left to move', () => {
    show({ phase: 'confirm', plan: { devFolder: NEW, sources: [], candidates: [] }, rows: [] })

    expect(screen.getByTestId('dev-folder-move-empty')).toHaveTextContent(
      'No project is left in a folder used before.'
    )
    expect(screen.getByTestId('dev-folder-move-start')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-move-recheck')).toBeEnabled()
  })

  it('shows why there is no list when the plan could not be had', () => {
    show({
      phase: 'confirm',
      plan: null,
      rows: [],
      error: 'The projects could not be checked: connection closed.'
    })

    expect(screen.getByTestId('dev-folder-move-error')).toHaveTextContent(
      'The projects could not be checked: connection closed.'
    )
    expect(screen.queryByTestId('dev-folder-move-empty')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-folder-move-start')).toBeDisabled()
    expect(screen.getByTestId('dev-folder-move-recheck')).toBeEnabled()
  })

  it('can be left by Cancel, by its close button, by Escape and by a click outside', async () => {
    const user = userEvent.setup()
    show({ phase: 'confirm' })
    await afterOpening()

    fireEvent.click(screen.getByTestId('dev-folder-move-close'))
    expect(screen.getByTestId('dev-folder-move-close')).toHaveTextContent('Cancel')
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(2)

    await user.keyboard('{Escape}')
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(3)

    fireEvent.pointerDown(document.body)
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(4)

    expect(actions.startDevFolderMove).not.toHaveBeenCalled()
  })

  it('rests the focus on Cancel, so Enter moves nothing', async () => {
    const user = userEvent.setup()
    show({ phase: 'confirm' })

    expect(screen.getByTestId('dev-folder-move-close')).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(1)
    expect(actions.startDevFolderMove).not.toHaveBeenCalled()
  })
})

describe('DevFolderMoveDialog: unsaved edits', () => {
  const unsaved = (): HTMLElement | null => screen.queryByTestId('dev-folder-move-unsaved')

  it('warns when a file of a ticked project has edits that were not saved', () => {
    useFileViewerStore.setState({ dirtyFiles: new Set([`${OLD}/web/src/main.ts`]) })
    show({ phase: 'confirm' })

    expect(unsaved()).toHaveTextContent(
      'Unsaved edits in open files of these projects will be lost. Cancel, save them, then open this dialog again.'
    )
  })

  it('warns for a file of a worktree that sits next to the project and moves with it', () => {
    holdWorktrees({
      web: [
        worktreeRow('wt-web', 'web', `${OLD}/web`),
        worktreeRow('wt-web-hotfix', 'web', `${OLD}/web-hotfix`)
      ]
    })
    useFileViewerStore.setState({ dirtyFiles: new Set([`${OLD}/web-hotfix/src/main.ts`]) })
    show({ phase: 'confirm' })

    expect(unsaved()).not.toBeNull()

    // Not when its project is left where it is.
    act(() => useDevFolderMoveStore.setState({ rows: rowsWith({ web: { selected: false } }) }))
    expect(unsaved()).toBeNull()
  })

  it('warns for a file of a worktree inside the project', () => {
    holdWorktrees({
      web: [
        worktreeRow('wt-web', 'web', `${OLD}/web`),
        worktreeRow('wt-web-fix', 'web', `${OLD}/web/.worktrees/fix`)
      ]
    })
    useFileViewerStore.setState({ dirtyFiles: new Set([`${OLD}/web/.worktrees/fix/a.ts`]) })
    show({ phase: 'confirm' })

    expect(unsaved()).not.toBeNull()
  })

  it('does not warn for a worktree that is kept somewhere else and stays there', () => {
    holdWorktrees({
      web: [
        worktreeRow('wt-web', 'web', `${OLD}/web`),
        worktreeRow('wt-web-x', 'web', '/Users/me/.hive-worktrees/web/feature-x')
      ]
    })
    useFileViewerStore.setState({
      dirtyFiles: new Set(['/Users/me/.hive-worktrees/web/feature-x/src/main.ts'])
    })
    show({ phase: 'confirm' })

    expect(unsaved()).toBeNull()
  })

  it('follows the files as they are edited and saved', () => {
    show({ phase: 'confirm' })
    expect(unsaved()).toBeNull()

    act(() => useFileViewerStore.getState().markDirty(`${OLDER}/legacy/README.md`))
    expect(unsaved()).not.toBeNull()

    act(() => useFileViewerStore.getState().markClean(`${OLDER}/legacy/README.md`))
    expect(unsaved()).toBeNull()
  })

  it('does not warn for a project that is not ticked or cannot move', () => {
    useFileViewerStore.setState({
      dirtyFiles: new Set([`${OLD}/web/src/main.ts`, `${OLD}/docs/index.md`])
    })
    show({ phase: 'confirm', rows: rowsWith({ web: { selected: false } }) })

    expect(unsaved()).toBeNull()

    act(() => useDevFolderMoveStore.setState({ rows: rowsWith() }))
    expect(unsaved()).not.toBeNull()
  })

  it('does not take a folder whose name only starts the same for the project', () => {
    useFileViewerStore.setState({
      dirtyFiles: new Set([`${OLD}/web-admin/src/main.ts`, '/Users/me/elsewhere/notes.md'])
    })
    show({ phase: 'confirm' })

    expect(unsaved()).toBeNull()
  })

  it('is said before the run only', () => {
    useFileViewerStore.setState({ dirtyFiles: new Set([`${OLD}/web/src/main.ts`]) })
    show({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })
    expect(unsaved()).toBeNull()

    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))
    expect(unsaved()).toBeNull()
  })
})

describe('DevFolderMoveDialog: terminals that cannot be checked', () => {
  const notice = (): HTMLElement | null => screen.queryByTestId('dev-folder-move-terminals')
  const tab = (
    worktreeId: string
  ): Pick<ReturnType<typeof useTerminalTabStore.getState>, 'tabsByWorktree'> => ({
    tabsByWorktree: new Map([
      [
        worktreeId,
        [
          {
            id: `${worktreeId}::tab-1`,
            worktreeId,
            name: 'Terminal 1',
            status: 'running',
            createdAt: 0
          }
        ]
      ]
    ])
  })

  beforeEach(() => {
    holdWorktrees({
      web: [worktreeRow('wt-web', 'web', `${OLD}/web`)],
      docs: [worktreeRow('wt-docs', 'docs', `${OLD}/docs`)],
      elsewhere: [worktreeRow('wt-elsewhere', 'elsewhere', '/Users/me/elsewhere')]
    })
  })

  it('says so when the terminals are Ghostty ones and a ticked project has a terminal tab', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty' })
    useTerminalTabStore.setState(tab('wt-web'))
    show({ phase: 'confirm' })

    expect(notice()).toHaveTextContent(
      'Terminals of these projects are not checked for running commands. Stop what runs in them first.'
    )
  })

  it('says nothing with the built-in terminal, whose commands are checked', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'xterm' })
    useTerminalTabStore.setState(tab('wt-web'))
    show({ phase: 'confirm' })

    expect(notice()).toBeNull()
  })

  it('says nothing while no ticked project has a terminal', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty' })
    show({ phase: 'confirm' })
    expect(notice()).toBeNull()

    // A terminal of a project that is not in the list, and of one that cannot move.
    act(() => useTerminalTabStore.setState(tab('wt-elsewhere')))
    expect(notice()).toBeNull()
    act(() => useTerminalTabStore.setState(tab('wt-docs')))
    expect(notice()).toBeNull()

    act(() => useTerminalTabStore.setState(tab('wt-web')))
    expect(notice()).not.toBeNull()

    act(() => useDevFolderMoveStore.setState({ rows: rowsWith({ web: { selected: false } }) }))
    expect(notice()).toBeNull()
  })

  it('counts a terminal session of the project, and not an agent session', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty' })
    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt-web', [sessionRow('s-agent', 'claude-code')]]])
    })
    show({ phase: 'confirm' })
    expect(notice()).toBeNull()

    act(() =>
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-web', [sessionRow('s-agent', 'claude-code'), sessionRow('s-term', 'terminal')]]
        ])
      })
    )
    expect(notice()).not.toBeNull()
  })

  it('counts a terminal session of a connection that starts in the project', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty' })
    useConnectionStore.setState({
      connections: [
        { id: 'conn-1', members: [{ worktree_id: 'wt-web' }, { worktree_id: 'wt-elsewhere' }] },
        { id: 'conn-2', members: [{ worktree_id: 'wt-elsewhere' }, { worktree_id: 'wt-web' }] }
      ] as unknown as ConnectionRow[]
    })
    useSessionStore.setState({
      sessionsByConnection: new Map([['conn-2', [sessionRow('s-term', 'terminal')]]])
    })
    show({ phase: 'confirm' })
    // That one starts in the folder of another project.
    expect(notice()).toBeNull()

    act(() =>
      useSessionStore.setState({
        sessionsByConnection: new Map([['conn-1', [sessionRow('s-term', 'terminal')]]])
      })
    )
    expect(notice()).not.toBeNull()
  })

  it('is said before the run only', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty' })
    useTerminalTabStore.setState(tab('wt-web'))
    show({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })
    expect(notice()).toBeNull()

    act(() => useDevFolderMoveStore.setState({ phase: 'summary' }))
    expect(notice()).toBeNull()
  })
})

describe('DevFolderMoveDialog: while projects are being moved', () => {
  const running = (): Partial<DevFolderMoveState> => ({
    phase: 'running',
    rows: rowsWith({
      api: { status: 'moved', result: result('api') },
      legacy: { status: 'running' },
      web: { selected: false }
    })
  })

  it('marks the project being moved with a spinner, and each other one with how it stands', () => {
    show(running())

    expect(dialog()).toHaveAttribute('data-phase', 'running')
    expect(lead()).toBe(
      `Moving project 2 of 2 into ${NEW}. The dialog stays open until the project being moved is done.`
    )
    expect(rowOf('legacy')).toHaveAttribute('data-status', 'running')
    expect(rowOf('legacy').querySelector('.animate-spin')).not.toBeNull()
    expect(rowOf('legacy')).toHaveTextContent('Moving…')

    expect(rowOf('api')).toHaveAttribute('data-status', 'moved')
    expect(rowOf('api')).toHaveTextContent(`${NEW}/api`)
    expect(rowOf('api').querySelector('.animate-spin')).toBeNull()
    expect(rowOf('web')).toHaveAttribute('data-status', 'pending')
    expect(rowOf('web')).toHaveTextContent('Not selected.')
    expect(rowOf('docs')).toHaveAttribute('data-status', 'skipped')
    expect(rowOf('docs')).toHaveTextContent('The dev folder already has a folder named docs.')
    // Still under the folders they sit in, and with nothing left to tick.
    expect(screen.getAllByTestId('dev-folder-move-source')).toHaveLength(2)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('counts the projects as they get their answer', () => {
    const stays = 'The dialog stays open until the project being moved is done.'
    show({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })
    // "docs" cannot move and is no part of the run.
    expect(lead()).toBe(`Moving project 1 of 3 into ${NEW}. ${stays}`)

    act(() =>
      useDevFolderMoveStore.setState({
        rows: rowsWith({
          api: { status: 'moved', result: result('api') },
          legacy: { status: 'running' }
        })
      })
    )
    expect(lead()).toBe(`Moving project 2 of 3 into ${NEW}. ${stays}`)

    // A project that was skipped or failed has its answer too.
    act(() =>
      useDevFolderMoveStore.setState({
        rows: rowsWith({
          api: { status: 'moved', result: result('api') },
          legacy: { status: 'failed', result: result('legacy', { action: 'failed' }) },
          web: { status: 'running' }
        })
      })
    )
    expect(lead()).toBe(`Moving project 3 of 3 into ${NEW}. ${stays}`)

    // The last answer is in and the window is still reloading: no project 4 of 3.
    act(() =>
      useDevFolderMoveStore.setState({
        rows: rowsWith({
          api: { status: 'moved', result: result('api') },
          legacy: { status: 'failed', result: result('legacy', { action: 'failed' }) },
          web: { status: 'moved', result: result('web') }
        })
      })
    )
    expect(lead()).toBe(`Moving project 3 of 3 into ${NEW}. ${stays}`)
  })

  it('does not count a run of one project', () => {
    show({
      phase: 'running',
      rows: rowsWith({
        api: { status: 'running' },
        legacy: { selected: false },
        web: { selected: false }
      })
    })

    expect(lead()).toBe(
      `Moving 1 project into ${NEW}. The dialog stays open until the project being moved is done.`
    )
  })

  it('brings the project being moved into view, each one as its turn comes', () => {
    // The test DOM has no scrollIntoView; the app's has.
    const proto = Element.prototype as { scrollIntoView?: (options?: unknown) => void }
    const before = Object.getOwnPropertyDescriptor(proto, 'scrollIntoView')
    const scrolled: [string | null, unknown][] = []
    proto.scrollIntoView = function (this: Element, options?: unknown): void {
      scrolled.push([this.getAttribute('data-testid'), options])
    }
    try {
      show({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })
      expect(scrolled).toEqual([['dev-folder-move-row-api', { block: 'nearest' }]])

      act(() =>
        useDevFolderMoveStore.setState({
          rows: rowsWith({
            api: { status: 'moved', result: result('api') },
            legacy: { status: 'running' }
          })
        })
      )
      expect(scrolled.map(([row]) => row)).toEqual([
        'dev-folder-move-row-api',
        'dev-folder-move-row-legacy'
      ])

      // Nothing is being moved any more in the account of the run.
      act(() =>
        useDevFolderMoveStore.setState({
          phase: 'summary',
          rows: rowsWith({
            api: { status: 'moved', result: result('api') },
            legacy: { status: 'moved', result: result('legacy') }
          })
        })
      )
      expect(scrolled).toHaveLength(2)
    } finally {
      if (before) Object.defineProperty(proto, 'scrollIntoView', before)
      else delete proto.scrollIntoView
    }
  })

  it('says nothing yet under a project whose turn has not come', () => {
    show({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })

    expect(rowOf('web')).toHaveAttribute('data-status', 'pending')
    expect(rowOf('web')).not.toHaveTextContent('Its move was not started.')
    expect(rowOf('web')).not.toHaveTextContent('Not selected.')
  })

  it('cannot be left: no Cancel, and neither Escape, a click outside nor the close button ends it', async () => {
    const user = userEvent.setup()
    show(running())
    await afterOpening()

    expect(screen.queryByTestId('dev-folder-move-close')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-recheck')).not.toBeInTheDocument()
    // The close button of the dialog is taken off the screen.
    expect(dialog().className).toContain('[&>button:last-child]:hidden')
    expect(dialog().lastElementChild).toBe(screen.getByRole('button', { name: 'Close' }))

    await user.keyboard('{Escape}')
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await user.keyboard('{Enter}')

    expect(actions.closeDevFolderMove).not.toHaveBeenCalled()
    expect(actions.cancelRemainingDevFolderMove).not.toHaveBeenCalled()
    expect(dialog()).toHaveAttribute('data-phase', 'running')
  })

  it('"Cancel remaining" asks the flow to start no other project, once', () => {
    show(running())
    const cancel = screen.getByTestId('dev-folder-move-cancel-remaining')
    expect(cancel).toHaveTextContent('Cancel remaining')
    expect(cancel).toBeEnabled()

    fireEvent.click(cancel)
    expect(actions.cancelRemainingDevFolderMove).toHaveBeenCalledTimes(1)

    act(() => useDevFolderMoveStore.setState({ cancelRequested: true }))
    expect(cancel).toBeDisabled()
    expect(cancel).toHaveTextContent('Stopping after this project…')
  })
})

describe('DevFolderMoveDialog: the account of a run', () => {
  const summary = (): Partial<DevFolderMoveState> => ({
    phase: 'summary',
    rows: rowsWith({
      api: {
        status: 'moved',
        result: result('api', {
          warnings: [
            'The old copy is still at /Volumes/Old/api: it changed while the project was being moved, compare it with the new one before deleting it.',
            'Scripts of api mention its folder, and the new path has characters a shell treats specially: check them.'
          ]
        })
      },
      legacy: {
        status: 'failed',
        result: result('legacy', {
          action: 'failed',
          detail: 'This project was not moved: no space left. It is still in its old folder.',
          movedPaths: []
        })
      },
      web: { status: 'moved', result: result('web') }
    })
  })

  it('leads with what was not moved', () => {
    show(summary())

    expect(dialog()).toHaveAttribute('data-phase', 'summary')
    expect(lead()).toBe(`2 projects were not moved. 2 projects moved to ${NEW}.`)

    const list = screen.getByTestId('dev-folder-move-list')
    const sections = Array.from(list.children).map((section) => section.getAttribute('data-testid'))
    expect(sections).toEqual(['dev-folder-move-not-moved', 'dev-folder-move-moved'])

    const notMoved = screen.getByTestId('dev-folder-move-not-moved')
    expect(within(notMoved).getByRole('heading')).toHaveTextContent('Not moved')
    expect(notMoved).toContainElement(rowOf('legacy'))
    expect(notMoved).toContainElement(rowOf('docs'))
    expect(rowOf('legacy')).toHaveAttribute('data-status', 'failed')
    expect(rowOf('legacy')).toHaveTextContent(
      'This project was not moved: no space left. It is still in its old folder.'
    )
    expect(rowOf('docs')).toHaveTextContent('The dev folder already has a folder named docs.')

    const moved = screen.getByTestId('dev-folder-move-moved')
    expect(moved).toContainElement(rowOf('api'))
    expect(moved).toContainElement(rowOf('web'))
    expect(rowOf('web')).toHaveTextContent(`${NEW}/web`)
  })

  it('lists each warning under the project it is about', () => {
    show(summary())

    expect(rowOf('api')).toHaveTextContent('The old copy is still at /Volumes/Old/api')
    expect(rowOf('api')).toHaveTextContent('Scripts of api mention its folder')
    expect(rowOf('web')).not.toHaveTextContent('The old copy')
    expect(rowOf('legacy')).not.toHaveTextContent('Scripts of api')
  })

  it('says of each project that did not move why it did not', () => {
    show({
      phase: 'summary',
      error: 'The run stopped at "legacy": Hive did not get an answer for its move.',
      rows: rowsWith({
        api: {
          status: 'skipped',
          result: result('api', {
            action: 'skipped',
            skipReason: 'busy',
            detail: 'A terminal is open in this project. Close its terminal tab, then check again.',
            movedPaths: []
          })
        },
        legacy: { selected: false }
        // web: ticked, and never reached by the run.
      })
    })

    // "legacy" was unticked: it is no part of the run, and is counted apart from what the
    // run did not manage.
    expect(lead()).toBe('3 projects were not moved.')
    expect(screen.queryByTestId('dev-folder-move-moved')).not.toBeInTheDocument()
    expect(rowOf('api')).toHaveTextContent(
      'A terminal is open in this project. Close its terminal tab, then check again.'
    )
    expect(screen.queryByTestId('dev-folder-move-row-legacy')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-folder-move-left-out')).toHaveTextContent(
      '1 project was not selected and stays where it is.'
    )
    expect(rowOf('web')).toHaveTextContent('Its move was not started.')
    expect(screen.getByTestId('dev-folder-move-error')).toHaveTextContent(
      'The run stopped at "legacy": Hive did not get an answer for its move.'
    )
  })

  it('keeps the projects that were left unticked out of the account, however many', () => {
    const names = ['api', 'web', 'docs', 'legacy', 'tools', 'infra']
    const plan: DevFolderMovePlan = {
      devFolder: NEW,
      sources: [OLD],
      candidates: names.map((name) => candidate(name))
    }
    show({
      phase: 'summary',
      plan,
      rows: plan.candidates.map((entry, index) =>
        index === 0
          ? { candidate: entry, selected: true, status: 'moved', result: result('api') }
          : { candidate: entry, selected: false, status: 'pending', result: null }
      )
    })

    expect(lead()).toBe(`Moved 1 project to ${NEW}.`)
    expect(screen.queryByTestId('dev-folder-move-not-moved')).not.toBeInTheDocument()
    expect(screen.getByTestId('dev-folder-move-left-out')).toHaveTextContent(
      '5 projects were not selected and stay where they are.'
    )
    expect(screen.queryByTestId('dev-folder-move-row-web')).not.toBeInTheDocument()
  })

  it('says it plainly when everything moved', () => {
    const plan: DevFolderMovePlan = {
      devFolder: NEW,
      sources: [OLD],
      candidates: [candidate('api')]
    }
    show({
      phase: 'summary',
      plan,
      rows: [
        { candidate: plan.candidates[0], selected: true, status: 'moved', result: result('api') }
      ]
    })

    expect(lead()).toBe(`Moved 1 project to ${NEW}.`)
    expect(screen.queryByTestId('dev-folder-move-not-moved')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-error')).not.toBeInTheDocument()
  })

  it('counts one project that did not move in the singular', () => {
    const plan: DevFolderMovePlan = {
      devFolder: NEW,
      sources: [OLD],
      candidates: [candidate('api')]
    }
    show({
      phase: 'summary',
      plan,
      rows: [{ candidate: plan.candidates[0], selected: true, status: 'pending', result: null }]
    })

    expect(lead()).toBe('1 project was not moved.')
  })

  it('puts the focus on Close when the run is over, so Enter leaves', async () => {
    const user = userEvent.setup()
    show({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })
    expect(screen.queryByTestId('dev-folder-move-close')).not.toBeInTheDocument()

    act(() => useDevFolderMoveStore.setState(stateOf(summary())))

    expect(screen.getByTestId('dev-folder-move-close')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(1)
    expect(actions.recheckDevFolderMove).not.toHaveBeenCalled()
  })

  it('offers Close and "Check again", and nothing that moves', async () => {
    const user = userEvent.setup()
    show(summary())

    expect(screen.queryByTestId('dev-folder-move-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-cancel-remaining')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    const close = screen.getByTestId('dev-folder-move-close')
    expect(close).toHaveTextContent('Close')
    expect(close).toHaveFocus()

    fireEvent.click(screen.getByTestId('dev-folder-move-recheck'))
    expect(actions.recheckDevFolderMove).toHaveBeenCalledTimes(1)

    await user.keyboard('{Escape}')
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(1)
  })
})

describe('DevFolderMoveDialog: answers that are not what their type says', () => {
  it('draws rows whose texts are missing', () => {
    const odd = {
      projectId: 'odd',
      fromPath: `${OLD}/odd-folder`,
      toPath: `${NEW}/odd-folder`
    } as unknown as DevFolderMoveCandidate
    show({
      phase: 'summary',
      plan: { devFolder: NEW, sources: [], candidates: [odd] },
      rows: [
        {
          candidate: odd,
          selected: true,
          status: 'moved',
          result: {
            projectId: 'odd',
            action: 'moved',
            warnings: [7, 'Look at this.'],
            movedPaths: []
          } as unknown as DevFolderMoveResult
        }
      ]
    })

    // The folder's name stands in for a project name that did not come.
    expect(rowOf('odd')).toHaveTextContent('odd-folder')
    expect(rowOf('odd')).toHaveTextContent('Look at this.')
    expect(rowOf('odd')).not.toHaveTextContent('7')
  })
})

describe('DevFolderMoveDialog: stores that hold something else than their type says', () => {
  it('draws the list all the same', () => {
    useSettingsStore.setState({ embeddedTerminalBackend: 'ghostty' })
    useWorktreeStore.setState({
      worktreesByProject: new Map<string, unknown>([
        ['api', { ok: true }],
        ['web', [null, { id: 'wt-web' }]]
      ]) as never
    })
    useTerminalTabStore.setState({ tabsByWorktree: { ok: true } as never })
    useSessionStore.setState({
      sessionsByWorktree: { ok: true } as never,
      sessionsByConnection: new Map<string, unknown>([['conn-1', { ok: true }]]) as never
    })
    useConnectionStore.setState({ connections: { ok: true } as never })
    useFileViewerStore.setState({ dirtyFiles: new Set(['/Users/me/elsewhere/notes.md']) })

    show({ phase: 'confirm' })

    expect(dialog()).toHaveAttribute('data-phase', 'confirm')
    expect(rowOf('api')).toBeInTheDocument()
    expect(screen.queryByTestId('dev-folder-move-unsaved')).toBeNull()
    expect(screen.queryByTestId('dev-folder-move-terminals')).toBeNull()
  })
})

// Settings › General opens this dialog from inside the Settings dialog, which is built from
// the same primitives. The two then sit on top of each other.
describe('DevFolderMoveDialog: opened over another dialog', () => {
  const onSettingsOpenChange = vi.fn()

  function showOverSettings(change: Partial<DevFolderMoveState>): void {
    useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
    render(
      <>
        <Dialog open onOpenChange={onSettingsOpenChange}>
          <DialogContent data-testid="settings-stand-in">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>General</DialogDescription>
            <button type="button">Move projects…</button>
          </DialogContent>
        </Dialog>
        <DevFolderMoveHost />
      </>
    )
    act(() => useDevFolderMoveStore.setState(stateOf(change)))
  }

  it('the dialog under it closes on Escape while it is alone', async () => {
    const user = userEvent.setup()
    showOverSettings({ phase: 'closed' })
    await afterOpening()

    await user.keyboard('{Escape}')

    expect(onSettingsOpenChange).toHaveBeenCalledTimes(1)
    expect(onSettingsOpenChange).toHaveBeenCalledWith(false)
  })

  it('Escape and a click outside close the dialog on top only', async () => {
    const user = userEvent.setup()
    showOverSettings({ phase: 'confirm' })
    await afterOpening()

    // Later in the document than the dialog it was opened from, so it is drawn above it.
    const settings = screen.getByTestId('settings-stand-in')
    expect(
      settings.compareDocumentPosition(dialog()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(1)

    fireEvent.pointerDown(document.body)
    expect(actions.closeDevFolderMove).toHaveBeenCalledTimes(2)

    // A click in the dialog on top is not a click outside the one under it.
    fireEvent.pointerDown(screen.getByTestId('dev-folder-move-list'))
    expect(onSettingsOpenChange).not.toHaveBeenCalled()
  })

  it('while projects are being moved, Escape and a click outside close neither', async () => {
    const user = userEvent.setup()
    showOverSettings({ phase: 'running', rows: rowsWith({ api: { status: 'running' } }) })
    await afterOpening()

    await user.keyboard('{Escape}')
    fireEvent.pointerDown(document.body)
    fireEvent.pointerDown(screen.getByTestId('dev-folder-move-list'))

    expect(actions.closeDevFolderMove).not.toHaveBeenCalled()
    expect(onSettingsOpenChange).not.toHaveBeenCalled()
    expect(dialog()).toBeInTheDocument()
    expect(screen.getByTestId('settings-stand-in')).toBeInTheDocument()
  })
})
