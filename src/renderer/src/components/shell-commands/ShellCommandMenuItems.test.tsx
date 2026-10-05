import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ProjectShellCommand } from '@shared/lib/shell-commands'

const mocks = vi.hoisted(() => ({
  runProjectShellCommand: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  isWindows: vi.fn(() => false)
}))

vi.mock('@/lib/shell-command-launch', () => ({
  runProjectShellCommand: mocks.runProjectShellCommand
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess, info: vi.fn() }
}))

vi.mock('@/lib/platform', () => ({
  isWindows: mocks.isWindows
}))

import {
  SHELL_COMMAND_FLAT_LIMIT,
  getRunnableShellCommands,
  renderShellCommandMenuItems,
  runShellCommandFromMenu
} from './ShellCommandMenuItems'

const makeCommands = (count: number): ProjectShellCommand[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `cmd-${index + 1}`,
    name: `Command ${index + 1}`,
    commands: `echo ${index + 1}`
  }))

// Stand-ins for the injected Radix primitives: plain elements with stable test ids
const primitives = {
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" data-testid="item" onClick={onClick}>
      {children}
    </button>
  ),
  MenuSeparator: () => <hr data-testid="separator" />,
  MenuSub: ({ children }: { children: React.ReactNode }) => <div data-testid="sub">{children}</div>,
  MenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sub-trigger">{children}</div>
  ),
  MenuSubContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="sub-content" className={className}>
      {children}
    </div>
  )
}

function renderItems(
  commands: ProjectShellCommand[],
  options: { onRun?: (command: ProjectShellCommand) => void; trailingSeparator?: boolean } = {}
): ReturnType<typeof render> {
  return render(
    <div data-testid="menu">
      {renderShellCommandMenuItems({
        commands,
        onRun: options.onRun ?? vi.fn(),
        ...primitives,
        trailingSeparator: options.trailingSeparator
      })}
    </div>
  )
}

describe('renderShellCommandMenuItems', () => {
  it('returns null for an empty list', () => {
    expect(renderShellCommandMenuItems({ commands: [], onRun: vi.fn(), ...primitives })).toBeNull()
    expect(
      renderShellCommandMenuItems({
        commands: [],
        onRun: vi.fn(),
        ...primitives,
        trailingSeparator: true
      })
    ).toBeNull()
  })

  it('renders up to the flat limit as plain items after a leading separator', () => {
    expect(SHELL_COMMAND_FLAT_LIMIT).toBe(5)
    const onRun = vi.fn()
    const commands = makeCommands(5)
    renderItems(commands, { onRun })

    const menu = screen.getByTestId('menu')
    expect(menu.firstElementChild).toBe(screen.getByTestId('separator'))
    expect(screen.getAllByTestId('separator')).toHaveLength(1)
    expect(screen.getAllByTestId('item').map((item) => item.textContent)).toEqual([
      'Command 1',
      'Command 2',
      'Command 3',
      'Command 4',
      'Command 5'
    ])
    expect(screen.queryByTestId('sub')).toBeNull()

    fireEvent.click(screen.getByText('Command 3'))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledWith(commands[2])
  })

  it('collapses more than the flat limit into a "Run Command" submenu', () => {
    const onRun = vi.fn()
    const commands = makeCommands(6)
    renderItems(commands, { onRun })

    expect(screen.getByTestId('menu').firstElementChild).toBe(screen.getByTestId('separator'))
    expect(screen.getByTestId('sub-trigger').textContent).toBe('Run Command')
    const content = screen.getByTestId('sub-content')
    expect(content).toHaveClass('w-52')
    expect(content.querySelectorAll('[data-testid="item"]')).toHaveLength(6)
    // Nothing is rendered flat next to the submenu
    expect(screen.getAllByTestId('item')).toHaveLength(6)

    fireEvent.click(screen.getByText('Command 6'))
    expect(onRun).toHaveBeenCalledWith(commands[5])
  })

  it('adds a trailing separator only when asked to', () => {
    const view = renderItems(makeCommands(2), { trailingSeparator: true })
    expect(screen.getAllByTestId('separator')).toHaveLength(2)
    expect(screen.getByTestId('menu').lastElementChild).toBe(screen.getAllByTestId('separator')[1])
    view.unmount()

    renderItems(makeCommands(2), { trailingSeparator: false })
    expect(screen.getAllByTestId('separator')).toHaveLength(1)
  })
})

describe('getRunnableShellCommands', () => {
  beforeEach(() => {
    mocks.isWindows.mockReturnValue(false)
  })

  it('returns the valid commands of a git project', () => {
    const commands = makeCommands(2)
    expect(getRunnableShellCommands({ shell_commands: commands })).toEqual(commands)
    expect(getRunnableShellCommands({ kind: 'git', shell_commands: commands })).toEqual(commands)
  })

  it('returns [] for a missing project or a project without commands', () => {
    expect(getRunnableShellCommands(null)).toEqual([])
    expect(getRunnableShellCommands(undefined)).toEqual([])
    expect(getRunnableShellCommands({})).toEqual([])
    expect(getRunnableShellCommands({ shell_commands: null })).toEqual([])
  })

  it('returns [] for connection projects', () => {
    expect(
      getRunnableShellCommands({ kind: 'connection', shell_commands: makeCommands(2) })
    ).toEqual([])
  })

  it('returns [] on Windows', () => {
    mocks.isWindows.mockReturnValue(true)
    expect(getRunnableShellCommands({ shell_commands: makeCommands(2) })).toEqual([])
  })

  it('drops blank and invalid entries', () => {
    const valid = makeCommands(1)[0]
    const result = getRunnableShellCommands({
      shell_commands: [
        { id: 'blank-name', name: '   ', commands: 'echo hi' },
        { id: 'blank-script', name: 'Blank', commands: '  \n ' },
        { id: 'comment-only', name: 'Comment', commands: '# nothing to run' },
        { id: 'bad id!', name: 'Bad id', commands: 'echo hi' },
        valid
      ]
    })
    expect(result).toEqual([valid])
  })
})

describe('runShellCommandFromMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isWindows.mockReturnValue(false)
  })

  it('forwards the project, command and worktree ids and stays silent on success', async () => {
    mocks.runProjectShellCommand.mockResolvedValue({ success: true, sessionId: 's1' })

    await runShellCommandFromMenu({
      projectId: 'p1',
      commandId: 'cmd-1',
      commandName: 'Build',
      worktreeId: 'wt-1'
    })

    expect(mocks.runProjectShellCommand).toHaveBeenCalledTimes(1)
    expect(mocks.runProjectShellCommand).toHaveBeenCalledWith({
      projectId: 'p1',
      commandId: 'cmd-1',
      worktreeId: 'wt-1'
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('passes no worktree for a project-level launch', async () => {
    mocks.runProjectShellCommand.mockResolvedValue({ success: true })

    await runShellCommandFromMenu({ projectId: 'p1', commandId: 'cmd-1', commandName: 'Build' })

    expect(mocks.runProjectShellCommand.mock.calls[0][0].worktreeId).toBeUndefined()
  })

  it("toasts the launcher's error", async () => {
    mocks.runProjectShellCommand.mockResolvedValue({ success: false, error: 'Worktree not found' })

    await runShellCommandFromMenu({ projectId: 'p1', commandId: 'cmd-1', commandName: 'Build' })

    expect(mocks.toastError).toHaveBeenCalledWith('Worktree not found')
  })

  it('falls back to a generic message when the launcher gives no error text', async () => {
    mocks.runProjectShellCommand.mockResolvedValue({ success: false })

    await runShellCommandFromMenu({ projectId: 'p1', commandId: 'cmd-1', commandName: 'Build' })

    expect(mocks.toastError).toHaveBeenCalledWith('Failed to run command')
  })
})
