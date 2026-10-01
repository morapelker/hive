import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSkillsListing } from '@shared/types/skills'
import type { CliToolOutputEvent, CliToolStatus } from '@shared/types/cli-tools'
import { ManageSkillsDialog } from './ManageSkillsDialog'

const projectApiMocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  setDisabledSkills: vi.fn(),
  copyToClipboard: vi.fn()
}))

const cliToolsApiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  installSkill: vi.fn(),
  onOutput: vi.fn()
}))

vi.mock('@/api/cli-tools-api', () => ({
  cliToolsApi: cliToolsApiMocks
}))

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/api/project-api', () => ({
  projectApi: projectApiMocks
}))

vi.mock('@/lib/toast', () => ({
  toast: toastMocks
}))

const project = { id: 'project-1', name: 'Hive', path: '/tmp/hive' }

const playwrightTool: CliToolStatus = {
  id: 'playwright-cli',
  name: 'Playwright CLI',
  description: 'Drive a browser from the terminal.',
  skillId: 'playwright-cli',
  latestVersion: '0.1.22',
  platformSupported: true,
  binaryPath: '/opt/homebrew/bin/playwright-cli',
  installedVersion: '0.1.19',
  upToDate: false,
  skill: { inProject: false, inGlobal: false, projectOutdated: false, globalOutdated: false },
  manualInstallCommand: 'npm install -g @playwright/cli@latest',
  canAutoInstall: true
}

const tcuTool: CliToolStatus = {
  id: 'tcu',
  name: 'Tedooo Computer Use (tcu)',
  description: 'Control macOS apps in the background.',
  skillId: 'tedooo-computer-use',
  latestVersion: '0.2.1',
  platformSupported: true,
  binaryPath: null,
  installedVersion: null,
  upToDate: false,
  skill: { inProject: false, inGlobal: false, projectOutdated: false, globalOutdated: false },
  manualInstallCommand: 'curl -fsSL https://example.test/install.sh | bash',
  canAutoInstall: true
}

const listing: ProjectSkillsListing = {
  globalSkills: [
    { id: 'pdf', name: 'pdf', description: 'Work with PDF files' },
    { id: 'docx', name: 'Word Documents', description: null }
  ],
  projectSkills: [
    { id: 'deploy', name: 'deploy', description: 'Deploy the app', enabled: true },
    { id: 'release', name: 'Release Notes', description: null, enabled: true },
    { id: 'verify', name: 'verify', description: 'Verify a change end-to-end', enabled: false }
  ]
}

function renderDialog(onOpenChange = vi.fn()) {
  return render(<ManageSkillsDialog project={project} open={true} onOpenChange={onOpenChange} />)
}

/** The toast and api mocks for one row's install, with the output callback captured. */
function captureOutput(): {
  emit: (event: CliToolOutputEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const handle: {
    emit: (event: CliToolOutputEvent) => void
    unsubscribe: ReturnType<typeof vi.fn>
  } = {
    emit: () => {},
    unsubscribe: vi.fn()
  }
  cliToolsApiMocks.onOutput.mockImplementation(
    (_id: string, cb: (event: CliToolOutputEvent) => void) => {
      handle.emit = cb
      return handle.unsubscribe
    }
  )
  return handle
}

const checkbox = (id: string): HTMLElement => screen.getByTestId(`manage-skills-checkbox-${id}`)

describe('ManageSkillsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectApiMocks.listSkills.mockResolvedValue(listing)
    projectApiMocks.setDisabledSkills.mockResolvedValue({ success: true })
    projectApiMocks.copyToClipboard.mockResolvedValue(undefined)
    cliToolsApiMocks.list.mockResolvedValue({ tools: [playwrightTool, tcuTool] })
    cliToolsApiMocks.onOutput.mockReturnValue(() => {})
  })

  it('renders the global and project skills from the listing', async () => {
    renderDialog()

    expect(await screen.findByTestId('manage-skills-global-pdf')).toHaveTextContent('pdf')
    expect(projectApiMocks.listSkills).toHaveBeenCalledWith('/tmp/hive')
    expect(screen.getByTestId('manage-skills-dialog')).toHaveTextContent('Manage Skills')
    expect(screen.getByText('Global skills')).toBeInTheDocument()
    expect(screen.getByText('Project skills')).toBeInTheDocument()
    expect(screen.getByText('Work with PDF files')).toHaveAttribute('title', 'Work with PDF files')
    expect(screen.getByTestId('manage-skills-project-deploy')).toHaveTextContent('Deploy the app')
    expect(screen.getByText('2 of 3 project skills enabled')).toBeInTheDocument()
    expect(
      screen.getByText('Disabled skills are hidden from Claude Code sessions in this project.')
    ).toBeInTheDocument()
  })

  it('shows the directory name first and the frontmatter name as secondary text', async () => {
    renderDialog()

    const projectRow = await screen.findByTestId('manage-skills-project-release')
    expect(projectRow).toHaveTextContent(/^release\s*Release Notes$/)
    expect(screen.getByTestId('manage-skills-global-docx')).toHaveTextContent(
      /^docx\s*Word Documents$/
    )
    // No alias when the frontmatter name matches the directory
    expect(screen.getByTestId('manage-skills-global-pdf')).toHaveTextContent(
      /^pdf\s*Work with PDF files$/
    )
  })

  it('lists global skills read-only, without a checkbox', async () => {
    const user = userEvent.setup()
    renderDialog()

    const globalRow = await screen.findByTestId('manage-skills-global-pdf')
    expect(within(globalRow).queryByRole('checkbox')).toBeNull()
    expect(screen.queryByTestId('manage-skills-checkbox-pdf')).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)

    await user.click(globalRow)

    expect(screen.getByTestId('manage-skills-save')).toBeDisabled()
  })

  it('renders a disabled project skill unchecked', async () => {
    renderDialog()

    await screen.findByTestId('manage-skills-project-verify')
    expect(checkbox('verify')).toHaveAttribute('aria-checked', 'false')
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'true')
    expect(checkbox('release')).toHaveAttribute('aria-checked', 'true')
  })

  it('keeps Save disabled until the selection differs from what was loaded', async () => {
    const user = userEvent.setup()
    renderDialog()

    await screen.findByTestId('manage-skills-project-deploy')
    const save = screen.getByTestId('manage-skills-save')
    expect(save).toBeDisabled()

    await user.click(checkbox('deploy'))
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'false')
    expect(save).toBeEnabled()
    expect(screen.getByText('1 of 3 project skills enabled')).toBeInTheDocument()

    await user.click(checkbox('deploy'))
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'true')
    expect(save).toBeDisabled()
  })

  it('toggles exactly once when the row text is clicked', async () => {
    const user = userEvent.setup()
    renderDialog()

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(screen.getByText('Deploy the app'))
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'false')

    await user.click(screen.getByText('Deploy the app'))
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'true')
  })

  it('saves exactly the unchecked skill ids and closes on success', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    // Disable one skill and re-enable the one that was loaded disabled
    await user.click(checkbox('release'))
    await user.click(checkbox('verify'))
    await user.click(screen.getByTestId('manage-skills-save'))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(projectApiMocks.setDisabledSkills).toHaveBeenCalledTimes(1)
    expect(projectApiMocks.setDisabledSkills).toHaveBeenCalledWith('/tmp/hive', ['release'])
    expect(toastMocks.success).toHaveBeenCalledWith('Skills updated')
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('sends an empty list when every project skill is enabled', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-verify')
    await user.click(checkbox('verify'))
    await user.click(screen.getByTestId('manage-skills-save'))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(projectApiMocks.setDisabledSkills).toHaveBeenCalledWith('/tmp/hive', [])
  })

  it('keeps the dialog open with the selection intact when the save is rejected', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    projectApiMocks.setDisabledSkills.mockResolvedValue({
      success: false,
      error: '.claude/settings.local.json is not valid JSON'
    })
    renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(checkbox('deploy'))
    await user.click(screen.getByTestId('manage-skills-save'))

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('.claude/settings.local.json is not valid JSON')
    )
    expect(projectApiMocks.setDisabledSkills).toHaveBeenCalledWith('/tmp/hive', [
      'deploy',
      'verify'
    ])
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(toastMocks.success).not.toHaveBeenCalled()
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(screen.getByTestId('manage-skills-save')).toBeEnabled())
  })

  it('toasts a fallback message when the save fails without an error', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    projectApiMocks.setDisabledSkills.mockResolvedValue({ success: false })
    renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(checkbox('deploy'))
    await user.click(screen.getByTestId('manage-skills-save'))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Failed to update skills'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('toasts the thrown error and stays open when the save request throws', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    projectApiMocks.setDisabledSkills.mockRejectedValue(new Error('RPC disconnected'))
    renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(checkbox('deploy'))
    await user.click(screen.getByTestId('manage-skills-save'))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('RPC disconnected'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'false')
    await waitFor(() => expect(screen.getByTestId('manage-skills-save')).toBeEnabled())
  })

  it('shows an inline error and keeps Save disabled when the skills fail to load', async () => {
    projectApiMocks.listSkills.mockRejectedValue(new Error('EACCES: permission denied'))
    renderDialog()

    const errorBox = await screen.findByTestId('manage-skills-load-error')
    expect(errorBox).toHaveTextContent('Failed to load skills')
    expect(errorBox).toHaveTextContent('EACCES: permission denied')
    expect(screen.getByTestId('manage-skills-save')).toBeDisabled()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('shows a loading state with Save disabled until the listing arrives', async () => {
    let resolveListing: (value: ProjectSkillsListing) => void = () => {}
    projectApiMocks.listSkills.mockReturnValue(
      new Promise<ProjectSkillsListing>((resolve) => {
        resolveListing = resolve
      })
    )
    renderDialog()

    expect(screen.getByTestId('manage-skills-loading')).toBeInTheDocument()
    expect(screen.getByTestId('manage-skills-save')).toBeDisabled()

    resolveListing(listing)

    expect(await screen.findByTestId('manage-skills-project-deploy')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-skills-loading')).toBeNull()
  })

  it('shows empty states when there are no global or project skills', async () => {
    projectApiMocks.listSkills.mockResolvedValue({ globalSkills: [], projectSkills: [] })
    renderDialog()

    expect(await screen.findByText('No global skills installed.')).toBeInTheDocument()
    expect(screen.getByText('This project has no skills in .claude/skills.')).toBeInTheDocument()
    expect(screen.getByText('No project skills')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByTestId('manage-skills-save')).toBeDisabled()
  })

  it('closes without saving when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(checkbox('deploy'))
    await user.click(screen.getByTestId('manage-skills-cancel'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(projectApiMocks.setDisabledSkills).not.toHaveBeenCalled()
  })

  it('reloads and drops unsaved changes when the dialog is reopened', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const view = renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(checkbox('deploy'))
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'false')

    view.rerender(<ManageSkillsDialog project={project} open={false} onOpenChange={onOpenChange} />)
    view.rerender(<ManageSkillsDialog project={project} open={true} onOpenChange={onOpenChange} />)

    await waitFor(() => expect(projectApiMocks.listSkills).toHaveBeenCalledTimes(2))
    await screen.findByTestId('manage-skills-project-deploy')
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('manage-skills-save')).toBeDisabled()
  })

  it('does not close a reopened dialog when an earlier save finishes late', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    let resolveSave: (value: { success: boolean }) => void = () => {}
    projectApiMocks.setDisabledSkills.mockReturnValue(
      new Promise<{ success: boolean }>((resolve) => {
        resolveSave = resolve
      })
    )
    const view = renderDialog(onOpenChange)

    await screen.findByTestId('manage-skills-project-deploy')
    await user.click(checkbox('deploy'))
    await user.click(screen.getByTestId('manage-skills-save'))

    view.rerender(<ManageSkillsDialog project={project} open={false} onOpenChange={onOpenChange} />)
    view.rerender(<ManageSkillsDialog project={project} open={true} onOpenChange={onOpenChange} />)
    await screen.findByTestId('manage-skills-project-deploy')

    resolveSave({ success: true })

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Skills updated'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('ignores a stale listing after the project changes', async () => {
    const resolvers = new Map<string, (value: ProjectSkillsListing) => void>()
    projectApiMocks.listSkills.mockImplementation(
      (path: string) =>
        new Promise<ProjectSkillsListing>((resolve) => {
          resolvers.set(path, resolve)
        })
    )
    const onOpenChange = vi.fn()
    const view = renderDialog(onOpenChange)

    view.rerender(
      <ManageSkillsDialog
        project={{ id: 'project-2', name: 'Other', path: '/tmp/other' }}
        open={true}
        onOpenChange={onOpenChange}
      />
    )
    await waitFor(() => expect(resolvers.has('/tmp/other')).toBe(true))

    resolvers.get('/tmp/other')?.({
      globalSkills: [],
      projectSkills: [{ id: 'other-skill', name: 'other-skill', description: null, enabled: true }]
    })
    await screen.findByTestId('manage-skills-project-other-skill')

    // The first project's response lands late and must not replace the current listing
    await act(async () => {
      resolvers.get('/tmp/hive')?.(listing)
    })

    expect(screen.getByTestId('manage-skills-project-other-skill')).toBeInTheDocument()
    expect(screen.queryByTestId('manage-skills-project-deploy')).toBeNull()
  })
})

describe('ManageSkillsDialog tools section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectApiMocks.listSkills.mockResolvedValue(listing)
    projectApiMocks.setDisabledSkills.mockResolvedValue({ success: true })
    projectApiMocks.copyToClipboard.mockResolvedValue(undefined)
    cliToolsApiMocks.list.mockResolvedValue({ tools: [playwrightTool, tcuTool] })
    cliToolsApiMocks.onOutput.mockReturnValue(() => {})
  })

  const row = (id: string): HTMLElement => screen.getByTestId(`manage-skills-tool-${id}`)

  it('lists the tools with their status, install and skill actions', async () => {
    renderDialog()

    expect(await screen.findByTestId('manage-skills-tool-playwright-cli')).toBeInTheDocument()
    expect(screen.getByTestId('manage-skills-tools-list')).toBeInTheDocument()
    expect(cliToolsApiMocks.list).toHaveBeenCalledWith('/tmp/hive')
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-status')).toHaveTextContent(
      'v0.1.19 · update to 0.1.22'
    )
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-install')).toHaveTextContent(
      'Update'
    )
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-skill')).toBeEnabled()
    expect(screen.getByTestId('manage-skills-tool-tcu-status')).toHaveTextContent('Not installed')
    expect(screen.getByTestId('manage-skills-tool-tcu-install')).toHaveTextContent('Install')
    // The skill can't be added before the CLI exists
    expect(screen.getByTestId('manage-skills-tool-tcu-skill')).toBeDisabled()
    // The skills lists are unaffected
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  })

  it('shows the up-to-date state without an install button', async () => {
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [{ ...playwrightTool, installedVersion: '0.1.22', upToDate: true }]
    })
    renderDialog()

    expect(await screen.findByTestId('manage-skills-tool-playwright-cli-status')).toHaveTextContent(
      'Up to date · v0.1.22'
    )
    expect(screen.queryByTestId('manage-skills-tool-playwright-cli-install')).toBeNull()
  })

  it('shows the platform note for a tool that cannot run here', async () => {
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [{ ...tcuTool, platformSupported: false, canAutoInstall: false }]
    })
    renderDialog()

    expect(await screen.findByTestId('manage-skills-tool-tcu-status')).toHaveTextContent(
      'Not available on this platform'
    )
    expect(screen.queryByTestId('manage-skills-tool-tcu-install')).toBeNull()
    expect(screen.queryByTestId('manage-skills-tool-tcu-manual')).toBeNull()
    // No skill button either: the row would tell the user to install a tool it just said is unavailable
    expect(screen.queryByTestId('manage-skills-tool-tcu-skill')).toBeNull()
  })

  it('flags a stale global skill without offering a project install', async () => {
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [
        {
          ...playwrightTool,
          skill: { inProject: false, inGlobal: true, projectOutdated: false, globalOutdated: true }
        }
      ]
    })
    renderDialog()

    const note = await screen.findByTestId('manage-skills-tool-playwright-cli-global-outdated')
    expect(note).toHaveTextContent('Skill installed globally · outdated')
    expect(note).toHaveAttribute(
      'title',
      expect.stringContaining('playwright-cli install --skills --global')
    )
    expect(screen.queryByTestId('manage-skills-tool-playwright-cli-skill')).toBeNull()
  })

  it('shows a copyable manual command when the app cannot install itself', async () => {
    const user = userEvent.setup()
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [{ ...playwrightTool, canAutoInstall: false }]
    })
    renderDialog()

    const manual = await screen.findByTestId('manage-skills-tool-playwright-cli-manual')
    expect(manual).toHaveTextContent('npm install -g @playwright/cli@latest')
    expect(screen.queryByTestId('manage-skills-tool-playwright-cli-install')).toBeNull()

    await user.click(within(manual).getByRole('button', { name: 'Copy command' }))
    expect(projectApiMocks.copyToClipboard).toHaveBeenCalledWith(
      'npm install -g @playwright/cli@latest'
    )
  })

  it('shows "installed globally" without a project button, and "installed in project"', async () => {
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [
        {
          ...playwrightTool,
          skill: { inProject: false, inGlobal: true, projectOutdated: false, globalOutdated: false }
        },
        {
          ...tcuTool,
          binaryPath: '/x/tcu',
          installedVersion: '0.2.1',
          upToDate: true,
          skill: { inProject: true, inGlobal: false, projectOutdated: false, globalOutdated: false }
        }
      ]
    })
    renderDialog()

    await screen.findByTestId('manage-skills-tool-playwright-cli')
    expect(row('playwright-cli')).toHaveTextContent('Skill installed globally')
    expect(screen.queryByTestId('manage-skills-tool-playwright-cli-global-outdated')).toBeNull()
    expect(screen.queryByTestId('manage-skills-tool-playwright-cli-skill')).toBeNull()
    expect(row('tcu')).toHaveTextContent('Skill installed in project')
    expect(screen.queryByTestId('manage-skills-tool-tcu-skill')).toBeNull()
  })

  it('offers "Update skill" when the project copy is outdated', async () => {
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [
        {
          ...playwrightTool,
          skill: { inProject: true, inGlobal: false, projectOutdated: true, globalOutdated: false }
        }
      ]
    })
    renderDialog()

    expect(await screen.findByTestId('manage-skills-tool-playwright-cli-skill')).toHaveTextContent(
      'Update skill'
    )
  })

  it('installs a tool, streams its output, and re-renders the row from the result', async () => {
    const user = userEvent.setup()
    let emit: ((event: CliToolOutputEvent) => void) | null = null
    const unsubscribe = vi.fn()
    cliToolsApiMocks.onOutput.mockImplementation(
      (_id: string, cb: (event: CliToolOutputEvent) => void) => {
        emit = cb
        return unsubscribe
      }
    )
    let resolveInstall: (value: unknown) => void = () => {}
    cliToolsApiMocks.install.mockReturnValue(new Promise((resolve) => (resolveInstall = resolve)))
    renderDialog()

    await user.click(await screen.findByTestId('manage-skills-tool-playwright-cli-install'))

    expect(cliToolsApiMocks.install).toHaveBeenCalledWith('playwright-cli', '/tmp/hive')
    expect(cliToolsApiMocks.onOutput).toHaveBeenCalledWith('playwright-cli', expect.any(Function))
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-install')).toHaveTextContent(
      'Updating...'
    )
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-install')).toBeDisabled()
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-skill')).toBeDisabled()

    act(() => {
      emit?.({ type: 'output', data: 'added 1 package\n' })
    })
    expect(screen.getByTestId('manage-skills-tool-log')).toHaveTextContent('added 1 package')

    await act(async () => {
      resolveInstall({
        success: true,
        status: { ...playwrightTool, installedVersion: '0.1.22', upToDate: true }
      })
    })

    expect(unsubscribe).toHaveBeenCalled()
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-status')).toHaveTextContent(
      'Up to date · v0.1.22'
    )
    expect(screen.queryByTestId('manage-skills-tool-playwright-cli-install')).toBeNull()
    expect(screen.queryByTestId('manage-skills-tool-log')).toBeNull()
    expect(toastMocks.success).toHaveBeenCalledWith('Playwright CLI installed')
    expect(projectApiMocks.listSkills).toHaveBeenCalledTimes(1)
  })

  it('shows the error inline with the log when an install fails', async () => {
    const user = userEvent.setup()
    const output = captureOutput()
    let resolveInstall: (value: unknown) => void = () => {}
    cliToolsApiMocks.install.mockReturnValue(new Promise((resolve) => (resolveInstall = resolve)))
    renderDialog()

    await user.click(await screen.findByTestId('manage-skills-tool-playwright-cli-install'))
    act(() => {
      output.emit({ type: 'output', data: 'npm ERR! EACCES\n' })
    })
    await act(async () => {
      resolveInstall({ success: false, error: 'npm install exited with code 1:\nnpm ERR! EACCES' })
    })

    const error = screen.getByTestId('manage-skills-tool-playwright-cli-error')
    expect(error).toHaveTextContent('npm ERR! EACCES')
    // The streamed output stays visible under the error
    expect(screen.getByTestId('manage-skills-tool-log')).toHaveTextContent('npm ERR! EACCES')
    expect(toastMocks.error).toHaveBeenCalledWith('npm install exited with code 1:')
    expect(screen.getByTestId('manage-skills-tool-playwright-cli-install')).toBeEnabled()
  })

  it('still toasts the result when the dialog was closed while the install ran', async () => {
    const user = userEvent.setup()
    let resolveInstall: (value: unknown) => void = () => {}
    cliToolsApiMocks.install.mockReturnValue(new Promise((resolve) => (resolveInstall = resolve)))
    const onOpenChange = vi.fn()
    const view = render(
      <ManageSkillsDialog project={project} open={true} onOpenChange={onOpenChange} />
    )

    await user.click(await screen.findByTestId('manage-skills-tool-playwright-cli-install'))
    view.rerender(<ManageSkillsDialog project={project} open={false} onOpenChange={onOpenChange} />)
    expect(screen.queryByTestId('manage-skills-dialog')).toBeNull()

    await act(async () => {
      resolveInstall({ success: true, status: { ...playwrightTool, upToDate: true } })
    })

    expect(toastMocks.success).toHaveBeenCalledWith('Playwright CLI installed')
  })

  it('shows the server\'s "already being installed" refusal inline', async () => {
    const user = userEvent.setup()
    cliToolsApiMocks.install.mockResolvedValue({
      success: false,
      error: 'Playwright CLI is already being installed'
    })
    renderDialog()

    await user.click(await screen.findByTestId('manage-skills-tool-playwright-cli-install'))

    expect(await screen.findByTestId('manage-skills-tool-playwright-cli-error')).toHaveTextContent(
      'already being installed'
    )
  })

  it('adds the skill to the project and re-lists project skills keeping unsaved toggles', async () => {
    const user = userEvent.setup()
    cliToolsApiMocks.installSkill.mockResolvedValue({
      success: true,
      status: {
        ...playwrightTool,
        skill: { inProject: true, inGlobal: false, projectOutdated: false, globalOutdated: false }
      }
    })
    renderDialog()

    await screen.findByTestId('manage-skills-project-deploy')
    // An unsaved change the reload must keep
    await user.click(checkbox('deploy'))
    projectApiMocks.listSkills.mockResolvedValue({
      ...listing,
      projectSkills: [
        ...listing.projectSkills,
        { id: 'playwright-cli', name: 'playwright-cli', description: 'Browser', enabled: true }
      ]
    })

    await user.click(screen.getByTestId('manage-skills-tool-playwright-cli-skill'))

    expect(cliToolsApiMocks.installSkill).toHaveBeenCalledWith('playwright-cli', '/tmp/hive')
    expect(await screen.findByTestId('manage-skills-project-playwright-cli')).toBeInTheDocument()
    expect(checkbox('playwright-cli')).toHaveAttribute('aria-checked', 'true')
    expect(checkbox('deploy')).toHaveAttribute('aria-checked', 'false')
    expect(row('playwright-cli')).toHaveTextContent('Skill installed in project')
    expect(toastMocks.success).toHaveBeenCalledWith('Playwright CLI skill added to the project')
    expect(projectApiMocks.listSkills).toHaveBeenCalledTimes(2)
  })

  it('takes the on-disk enabled state for a skill the update just re-enabled', async () => {
    const user = userEvent.setup()
    const disabledListing: ProjectSkillsListing = {
      ...listing,
      projectSkills: [
        ...listing.projectSkills,
        { id: 'playwright-cli', name: 'playwright-cli', description: 'Browser', enabled: false }
      ]
    }
    projectApiMocks.listSkills.mockResolvedValue(disabledListing)
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [
        {
          ...playwrightTool,
          skill: { inProject: true, inGlobal: false, projectOutdated: true, globalOutdated: false }
        }
      ]
    })
    cliToolsApiMocks.installSkill.mockResolvedValue({
      success: true,
      status: {
        ...playwrightTool,
        skill: { inProject: true, inGlobal: false, projectOutdated: false, globalOutdated: false }
      }
    })
    renderDialog()

    await screen.findByTestId('manage-skills-project-playwright-cli')
    expect(checkbox('playwright-cli')).toHaveAttribute('aria-checked', 'false')
    // The server re-enables the skill as part of the update
    projectApiMocks.listSkills.mockResolvedValue({
      ...disabledListing,
      projectSkills: disabledListing.projectSkills.map((skill) =>
        skill.id === 'playwright-cli' ? { ...skill, enabled: true } : skill
      )
    })

    await user.click(await screen.findByTestId('manage-skills-tool-playwright-cli-skill'))

    await waitFor(() => expect(checkbox('playwright-cli')).toHaveAttribute('aria-checked', 'true'))
    // Nothing differs from disk, so there is nothing to save (and nothing to re-disable)
    expect(screen.getByTestId('manage-skills-save')).toBeDisabled()
  })

  it('shows the install hint returned with a status', async () => {
    cliToolsApiMocks.list.mockResolvedValue({
      tools: [
        {
          ...tcuTool,
          installedVersion: '0.2.1',
          binaryPath: '/x',
          upToDate: true,
          installHint: 'Grant Accessibility'
        }
      ]
    })
    renderDialog()

    expect(await screen.findByTestId('manage-skills-tool-tcu-hint')).toHaveTextContent(
      'Grant Accessibility'
    )
  })

  it('keeps the skills lists when the tools fail to load', async () => {
    cliToolsApiMocks.list.mockRejectedValue(new Error('backend down'))
    renderDialog()

    expect(await screen.findByTestId('manage-skills-tools-error')).toHaveTextContent('backend down')
    expect(screen.getByTestId('manage-skills-project-deploy')).toBeInTheDocument()
    expect(screen.getByTestId('manage-skills-global-pdf')).toBeInTheDocument()
    expect(toastMocks.error).not.toHaveBeenCalled()
  })
})
