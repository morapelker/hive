import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddProjectButton } from './AddProjectButton'

const mocks = vi.hoisted(() => ({
  addProject: vi.fn()
}))

const settingsMocks = vi.hoisted(() => {
  const state = {
    lastProjectDirectory: null as string | null,
    updateSetting: vi.fn()
  }
  const useSettingsStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useSettingsStore.getState = () => state
  return { state, useSettingsStore }
})

const projectApiMocks = vi.hoisted(() => ({
  openDirectoryDialog: vi.fn(),
  initRepository: vi.fn(),
  createProjectFolder: vi.fn()
}))

const githubApiMocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
  cloneRepository: vi.fn(),
  cancelClone: vi.fn(),
  onCloneProgress: vi.fn()
}))

const toastMocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  projectToast: { added: vi.fn() }
}))

vi.mock('@/stores', () => ({
  useProjectStore: () => ({
    addProject: mocks.addProject
  }),
  useSettingsStore: settingsMocks.useSettingsStore
}))

vi.mock('@/api/project-api', () => ({
  projectApi: projectApiMocks
}))

vi.mock('@/api/github-api', () => ({
  githubApi: githubApiMocks
}))

vi.mock('@/lib/toast', () => toastMocks)

beforeAll(() => {
  // Radix DropdownMenu relies on these in a real browser; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.addProject.mockResolvedValue({ success: true })
  projectApiMocks.openDirectoryDialog.mockResolvedValue('/tmp/existing-repo')
  githubApiMocks.listRepositories.mockResolvedValue({ success: true, repos: [] })
  githubApiMocks.onCloneProgress.mockReturnValue(() => undefined)
})

describe('AddProjectButton', () => {
  it('shows a menu with New project, Add existing project, and Add repository', async () => {
    render(<AddProjectButton />)

    await userEvent.click(screen.getByTestId('add-project-button'))

    expect(await screen.findByTestId('add-project-menu-new')).toBeInTheDocument()
    expect(screen.getByTestId('add-project-menu-existing')).toBeInTheDocument()
    expect(screen.getByTestId('add-project-menu-repository')).toBeInTheDocument()
  })

  it('adds an existing project via the folder picker', async () => {
    render(<AddProjectButton />)

    await userEvent.click(screen.getByTestId('add-project-button'))
    await userEvent.click(await screen.findByTestId('add-project-menu-existing'))

    await waitFor(() => {
      expect(projectApiMocks.openDirectoryDialog).toHaveBeenCalled()
      expect(mocks.addProject).toHaveBeenCalledWith('/tmp/existing-repo')
    })
    expect(toastMocks.projectToast.added).toHaveBeenCalledWith('existing-repo')
  })

  it('opens the git init dialog when the folder is not a git repository', async () => {
    mocks.addProject.mockResolvedValue({
      success: false,
      error:
        'The selected folder is not a Git repository. Please select a folder containing a .git directory.'
    })
    render(<AddProjectButton />)

    await userEvent.click(screen.getByTestId('add-project-button'))
    await userEvent.click(await screen.findByTestId('add-project-menu-existing'))

    expect(await screen.findByText('Not a Git Repository')).toBeInTheDocument()
  })

  it('still adds an existing project on the hive:add-project window event', async () => {
    render(<AddProjectButton />)

    act(() => {
      window.dispatchEvent(new CustomEvent('hive:add-project'))
    })

    await waitFor(() => {
      expect(projectApiMocks.openDirectoryDialog).toHaveBeenCalled()
      expect(mocks.addProject).toHaveBeenCalledWith('/tmp/existing-repo')
    })
  })

  it('opens the Create Project dialog from the menu', async () => {
    render(<AddProjectButton />)

    await userEvent.click(screen.getByTestId('add-project-button'))
    await userEvent.click(await screen.findByTestId('add-project-menu-new'))

    expect(await screen.findByTestId('create-project-dialog')).toBeInTheDocument()
  })

  it('opens the Add Repository dialog from the menu', async () => {
    render(<AddProjectButton />)

    await userEvent.click(screen.getByTestId('add-project-button'))
    await userEvent.click(await screen.findByTestId('add-project-menu-repository'))

    expect(await screen.findByTestId('add-repository-dialog')).toBeInTheDocument()
    expect(githubApiMocks.listRepositories).toHaveBeenCalled()
  })
})
