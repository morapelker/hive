import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateProjectDialog } from './CreateProjectDialog'

const mocks = vi.hoisted(() => ({
  addProject: vi.fn()
}))

const projectApiMocks = vi.hoisted(() => ({
  openDirectoryDialog: vi.fn(),
  createProjectFolder: vi.fn()
}))

const toastMocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  projectToast: { added: vi.fn() }
}))

vi.mock('@/stores', () => ({
  useProjectStore: () => ({
    addProject: mocks.addProject
  })
}))

vi.mock('@/api/project-api', () => ({
  projectApi: projectApiMocks
}))

vi.mock('@/lib/toast', () => toastMocks)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.addProject.mockResolvedValue({ success: true })
  projectApiMocks.openDirectoryDialog.mockResolvedValue('/tmp/parent')
  projectApiMocks.createProjectFolder.mockResolvedValue({
    success: true,
    path: '/tmp/parent/my-app'
  })
})

describe('CreateProjectDialog', () => {
  it('creates the folder and adds the project to Hive', async () => {
    const onOpenChange = vi.fn()
    render(<CreateProjectDialog open onOpenChange={onOpenChange} />)

    expect(screen.getByTestId('create-project-confirm')).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/parent')
    })

    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    expect(screen.getByText('/tmp/parent/my-app')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('create-project-confirm'))

    await waitFor(() => {
      expect(projectApiMocks.createProjectFolder).toHaveBeenCalledWith('/tmp/parent', 'my-app')
      expect(mocks.addProject).toHaveBeenCalledWith('/tmp/parent/my-app')
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(toastMocks.projectToast.added).toHaveBeenCalledWith('my-app')
  })

  it('shows the error and stays open when folder creation fails', async () => {
    projectApiMocks.createProjectFolder.mockResolvedValue({
      success: false,
      error: 'A folder named "my-app" already exists in the selected location.'
    })
    const onOpenChange = vi.fn()
    render(<CreateProjectDialog open onOpenChange={onOpenChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    await userEvent.click(screen.getByTestId('create-project-confirm'))

    expect(await screen.findByTestId('create-project-error')).toHaveTextContent('already exists')
    expect(mocks.addProject).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('disables Create until both location and name are set', async () => {
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    expect(screen.getByTestId('create-project-confirm')).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('create-project-confirm')).toBeEnabled()
    })
  })
})
