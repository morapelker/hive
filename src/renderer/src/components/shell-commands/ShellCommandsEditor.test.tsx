import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { validateShellCommand, type ProjectShellCommand } from '@shared/lib/shell-commands'
import { ShellCommandsEditor } from './ShellCommandsEditor'

const build: ProjectShellCommand = { id: 'build', name: 'Build', commands: 'pnpm build' }
const deploy: ProjectShellCommand = { id: 'deploy', name: 'Deploy', commands: 'pnpm deploy' }
const lint: ProjectShellCommand = { id: 'lint', name: 'Lint', commands: 'pnpm lint' }

/** Controlled wrapper so edits round-trip like they do in the settings dialog. */
function Harness({
  initial,
  onChange
}: {
  initial: ProjectShellCommand[]
  onChange: (next: ProjectShellCommand[]) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <ShellCommandsEditor
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function renderEditor(initial: ProjectShellCommand[]): {
  onChange: ReturnType<typeof vi.fn>
  latest: () => ProjectShellCommand[]
} {
  const onChange = vi.fn()
  render(<Harness initial={initial} onChange={onChange} />)
  return {
    onChange,
    latest: () => onChange.mock.calls[onChange.mock.calls.length - 1][0] as ProjectShellCommand[]
  }
}

describe('ShellCommandsEditor', () => {
  it('renders the step rules once and one card per command', () => {
    renderEditor([build, deploy])

    expect(screen.getByTestId('shell-commands-editor')).toBeInTheDocument()
    expect(screen.getAllByText(/Each line is one step and runs in your login shell/)).toHaveLength(
      1
    )
    expect(screen.getByTestId('shell-command-name-build')).toHaveValue('Build')
    expect(screen.getByTestId('shell-command-script-build')).toHaveValue('pnpm build')
    expect(screen.getByTestId('shell-command-name-deploy')).toHaveValue('Deploy')
    expect(screen.getAllByText('Keep running if the app quits')).toHaveLength(2)
  })

  it('adds an empty command with an id the validator accepts', () => {
    const { latest } = renderEditor([build])

    fireEvent.click(screen.getByTestId('shell-command-add'))

    const next = latest()
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(build)
    expect(next[1]).toMatchObject({ name: '', commands: '' })
    expect(next[1]).not.toHaveProperty('keepRunningOnQuit')
    expect(next[1].id).not.toBe(build.id)
    expect(validateShellCommand({ ...next[1], name: 'Filled', commands: 'echo hi' })).toMatchObject(
      { valid: true }
    )
  })

  it('renames a command and edits its script', () => {
    const { latest } = renderEditor([build, deploy])

    fireEvent.change(screen.getByTestId('shell-command-name-build'), {
      target: { value: 'Build all' }
    })
    expect(latest()).toEqual([{ ...build, name: 'Build all' }, deploy])

    fireEvent.change(screen.getByTestId('shell-command-script-deploy'), {
      target: { value: 'pnpm build\npnpm deploy' }
    })
    expect(latest()).toEqual([
      { ...build, name: 'Build all' },
      { ...deploy, commands: 'pnpm build\npnpm deploy' }
    ])
  })

  it('reorders commands and disables the buttons at the ends', () => {
    const { latest } = renderEditor([build, deploy, lint])

    const up = screen.getAllByRole('button', { name: 'Move command up' })
    const down = screen.getAllByRole('button', { name: 'Move command down' })
    expect(up[0]).toBeDisabled()
    expect(down[2]).toBeDisabled()

    fireEvent.click(down[0])
    expect(latest().map((command) => command.id)).toEqual(['deploy', 'build', 'lint'])

    fireEvent.click(screen.getAllByRole('button', { name: 'Move command up' })[2])
    expect(latest().map((command) => command.id)).toEqual(['deploy', 'lint', 'build'])
  })

  it('deletes a command', () => {
    const { latest } = renderEditor([build, deploy])

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete command' })[0])

    expect(latest()).toEqual([deploy])
    expect(screen.queryByTestId('shell-command-name-build')).toBeNull()
  })

  it('emits keepRunningOnQuit true when ticked and false when unticked', () => {
    const { latest } = renderEditor([build, deploy])

    const checkbox = screen.getByTestId('shell-command-keep-running-build')
    expect(checkbox).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(checkbox)
    expect(latest()).toEqual([{ ...build, keepRunningOnQuit: true }, deploy])
    expect(screen.getByTestId('shell-command-keep-running-build')).toHaveAttribute(
      'aria-checked',
      'true'
    )

    fireEvent.click(screen.getByTestId('shell-command-keep-running-build'))
    expect(latest()).toEqual([{ ...build, keepRunningOnQuit: false }, deploy])
    expect(screen.getByTestId('shell-command-keep-running-deploy')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  it('labels each checkbox so the label text names it', () => {
    renderEditor([build])

    expect(screen.getByLabelText('Keep running if the app quits')).toBe(
      screen.getByTestId('shell-command-keep-running-build')
    )
  })

  it('shows a validation hint for a comment-only script', () => {
    renderEditor([{ id: 'notes', name: 'Notes', commands: '# nothing runs here' }, build])

    expect(screen.getAllByText('commands must contain at least one runnable line')).toHaveLength(1)
  })

  it('shows no hint for a valid command or a half-typed row', () => {
    renderEditor([build, { id: 'draft', name: 'Draft', commands: '' }])

    expect(screen.queryByText(/commands must/)).toBeNull()
    expect(screen.queryByText(/name must/)).toBeNull()
  })
})
