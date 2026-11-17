import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import type { GithubCloneProgressEvent } from '@shared/github-events'
import { DEV_FOLDER_RPC, type DevFolderState } from '@shared/types/dev-folder'
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

// The dialog asks the server for the dev folder when it opens. The cases above run under the
// client test/setup.ts installs, which answers undefined: no dev folder, nothing prefilled.
describe('AddRepositoryDialog destination', () => {
  const defaultClient = getRendererRpcClient()

  const devFolderState = (overrides: Partial<DevFolderState> = {}): DevFolderState => ({
    path: '/Users/me/code',
    isDefault: false,
    defaultPath: '/Users/me/hive-projects',
    exists: true,
    previousPaths: [],
    leftBehind: { count: 0, folders: [] },
    ...overrides
  })

  /** `answer` is what `settingsOps.getDevFolder` answers: a value, or a promise still pending. */
  const answerDevFolder = (answer: unknown): ReturnType<typeof vi.fn> => {
    const request: ReturnType<typeof vi.fn> = vi.fn(async (method: string, params?: unknown) =>
      method === DEV_FOLDER_RPC.get ? answer : defaultClient.request(method, params)
    )
    setRendererRpcClient({ request, subscribe: vi.fn(() => () => {}) })
    return request
  }

  const devFolderCalls = (request: ReturnType<typeof vi.fn>): number =>
    request.mock.calls.filter(([method]) => method === DEV_FOLDER_RPC.get).length

  afterEach(() => {
    setRendererRpcClient(defaultClient)
  })

  it('starts from the dev folder, and clones into it without a folder being picked', async () => {
    answerDevFolder(devFolderState())
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('repository-destination')).toHaveValue('/Users/me/code')
    })

    await userEvent.click(await screen.findByTestId('repository-item-me/alpha'))
    expect(screen.getByText('/Users/me/code/alpha')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('clone-repository'))

    await waitFor(() => {
      expect(githubApiMocks.cloneRepository).toHaveBeenCalledWith({
        nameWithOwner: 'me/alpha',
        parentPath: '/Users/me/code',
        operationId: expect.any(String)
      })
    })
    expect(projectApiMocks.openDirectoryDialog).not.toHaveBeenCalled()
  })

  it('stays empty when the dev folder is not on disk', async () => {
    const request = answerDevFolder(devFolderState({ exists: false }))
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('repository-item-me/alpha'))
    await waitFor(() => expect(devFolderCalls(request)).toBe(1))

    expect(screen.getByTestId('repository-destination')).toHaveValue('')
    expect(screen.getByTestId('clone-repository')).toBeDisabled()
  })

  it('stays empty when the answer is not a dev folder', async () => {
    const request = answerDevFolder({ ok: true })
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(await screen.findByTestId('repository-item-me/alpha'))
    await waitFor(() => expect(devFolderCalls(request)).toBe(1))

    expect(screen.getByTestId('repository-destination')).toHaveValue('')
    expect(screen.getByTestId('clone-repository')).toBeDisabled()
  })

  it('keeps the folder the person picked when the dev folder answers late', async () => {
    let answer: (state: DevFolderState) => void = () => {}
    answerDevFolder(
      new Promise<DevFolderState>((resolve) => {
        answer = resolve
      })
    )
    render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('repository-destination')).toHaveValue('/tmp/dest')
    })

    await act(async () => {
      answer(devFolderState())
    })

    expect(screen.getByTestId('repository-destination')).toHaveValue('/tmp/dest')
  })

  it('keeps a folder picked earlier when it is opened again', async () => {
    const request = answerDevFolder(devFolderState({ exists: false }))
    const { rerender } = render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('repository-destination')).toHaveValue('/tmp/dest')
    })

    rerender(<AddRepositoryDialog open={false} onOpenChange={vi.fn()} />)
    request.mockImplementation(async () => devFolderState())
    rerender(<AddRepositoryDialog open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(devFolderCalls(request)).toBe(2))
    await act(async () => {})

    expect(screen.getByTestId('repository-destination')).toHaveValue('/tmp/dest')
  })

  it('ignores an answer that arrives after it was closed', async () => {
    let answer: (state: DevFolderState) => void = () => {}
    const request = answerDevFolder(
      new Promise<DevFolderState>((resolve) => {
        answer = resolve
      })
    )
    const { rerender } = render(<AddRepositoryDialog open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(devFolderCalls(request)).toBe(1))

    rerender(<AddRepositoryDialog open={false} onOpenChange={vi.fn()} />)
    await act(async () => {
      answer(devFolderState())
    })

    // Opened again while the folder is gone: the answer from before must not show up.
    request.mockImplementation(async () => devFolderState({ exists: false }))
    rerender(<AddRepositoryDialog open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(devFolderCalls(request)).toBe(2))
    await act(async () => {})

    expect(screen.getByTestId('repository-destination')).toHaveValue('')
  })

  it('does not ask while it is closed', async () => {
    const request = answerDevFolder(devFolderState())
    render(<AddRepositoryDialog open={false} onOpenChange={vi.fn()} />)
    await act(async () => {})

    expect(devFolderCalls(request)).toBe(0)
  })
})
