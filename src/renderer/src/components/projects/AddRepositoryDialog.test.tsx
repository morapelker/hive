import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubCloneProgressEvent } from '@shared/github-events'
import { AddRepositoryDialog } from './AddRepositoryDialog'

const mocks = vi.hoisted(() => ({
  addProject: vi.fn()
}))

const projectApiMocks = vi.hoisted(() => ({
  openDirectoryDialog: vi.fn()
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
  })
}))

vi.mock('@/api/project-api', () => ({
  projectApi: projectApiMocks
}))

vi.mock('@/api/github-api', () => ({
  githubApi: githubApiMocks
}))

vi.mock('@/lib/toast', () => toastMocks)

const REPOS = [
  {
    nameWithOwner: 'me/alpha',
    description: 'First repo',
    isPrivate: false,
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    nameWithOwner: 'org/beta',
    description: null,
    isPrivate: true,
    updatedAt: '2026-02-01T00:00:00Z'
  }
]

let progressCallback: ((event: GithubCloneProgressEvent) => void) | null = null
const unsubscribe = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  progressCallback = null
  mocks.addProject.mockResolvedValue({ success: true })
  projectApiMocks.openDirectoryDialog.mockResolvedValue('/tmp/dest')
  githubApiMocks.listRepositories.mockResolvedValue({ success: true, repos: REPOS })
  githubApiMocks.cloneRepository.mockResolvedValue({ success: true, path: '/tmp/dest/alpha' })
  githubApiMocks.cancelClone.mockResolvedValue({ success: true })
  githubApiMocks.onCloneProgress.mockImplementation(
    (callback: (event: GithubCloneProgressEvent) => void) => {
      progressCallback = callback
      return unsubscribe
    }
  )
})

const emitProgress = (event: Omit<GithubCloneProgressEvent, 'operationId'>): void => {
  const operationId = githubApiMocks.cloneRepository.mock.calls[0][0].operationId as string
  act(() => {
    progressCallback?.({ operationId, ...event })
  })
}

describe('AddRepositoryDialog', () => {
  it('lists repositories and filters them by search', async () => {
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByTestId('repository-item-me/alpha')).toBeInTheDocument()
    expect(screen.getByTestId('repository-item-org/beta')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('repository-search-input'), 'beta')

    expect(screen.queryByTestId('repository-item-me/alpha')).not.toBeInTheDocument()
    expect(screen.getByTestId('repository-item-org/beta')).toBeInTheDocument()
  })

  it('shows the gh error with a retry option when listing fails', async () => {
    githubApiMocks.listRepositories.mockResolvedValue({
      success: false,
      repos: [],
      error: 'GitHub CLI (gh) is not installed'
    })
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText('GitHub CLI (gh) is not installed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('clones the selected repository, shows progress, and adds the project when done', async () => {
    const onOpenChange = vi.fn()
    render(<AddRepositoryDialog open onOpenChange={onOpenChange} />)

    expect(screen.getByTestId('clone-repository')).toBeDisabled()

    await userEvent.click(await screen.findByTestId('repository-item-me/alpha'))
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('clone-repository')).toBeEnabled()
    })

    await userEvent.click(screen.getByTestId('clone-repository'))

    await waitFor(() => {
      expect(githubApiMocks.cloneRepository).toHaveBeenCalledWith({
        nameWithOwner: 'me/alpha',
        parentPath: '/tmp/dest',
        operationId: expect.any(String)
      })
    })
    expect(screen.getByTestId('clone-progress')).toBeInTheDocument()

    emitProgress({ type: 'progress', stage: 'Receiving objects', percent: 50 })
    expect(screen.getByText(/Receiving objects/)).toBeInTheDocument()

    emitProgress({ type: 'done', path: '/tmp/dest/alpha' })

    await waitFor(() => {
      expect(mocks.addProject).toHaveBeenCalledWith('/tmp/dest/alpha')
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(toastMocks.projectToast.added).toHaveBeenCalledWith('alpha')
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('shows the clone error and returns to selection on failure', async () => {
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('repository-item-me/alpha'))
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(screen.getByTestId('clone-repository')).toBeEnabled())
    await userEvent.click(screen.getByTestId('clone-repository'))

    await waitFor(() => expect(githubApiMocks.cloneRepository).toHaveBeenCalled())
    emitProgress({ type: 'error', error: 'fatal: repository not found' })

    expect(await screen.findByTestId('clone-error')).toHaveTextContent('repository not found')
    expect(screen.getByTestId('clone-repository')).toBeInTheDocument()
    expect(mocks.addProject).not.toHaveBeenCalled()
  })

  it('cancels an in-flight clone', async () => {
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('repository-item-me/alpha'))
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(screen.getByTestId('clone-repository')).toBeEnabled())
    await userEvent.click(screen.getByTestId('clone-repository'))
    await waitFor(() => expect(githubApiMocks.cloneRepository).toHaveBeenCalled())

    const operationId = githubApiMocks.cloneRepository.mock.calls[0][0].operationId as string
    await userEvent.click(screen.getByTestId('cancel-clone'))

    expect(githubApiMocks.cancelClone).toHaveBeenCalledWith(operationId)
    expect(screen.getByTestId('clone-repository')).toBeInTheDocument()
  })
})
