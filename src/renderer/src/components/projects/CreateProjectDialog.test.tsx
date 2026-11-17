import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import { DEV_FOLDER_RPC, type DevFolderState } from '@shared/types/dev-folder'
import { CreateProjectDialog } from './CreateProjectDialog'

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
  createProjectFolder: vi.fn()
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

vi.mock('@/lib/toast', () => toastMocks)

beforeEach(() => {
  vi.clearAllMocks()
  settingsMocks.state.lastProjectDirectory = null
  settingsMocks.state.updateSetting.mockResolvedValue(undefined)
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

  it('prefills the location from the last remembered directory', async () => {
    settingsMocks.state.lastProjectDirectory = '/tmp/remembered'
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/remembered')
    })

    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    await waitFor(() => {
      expect(screen.getByTestId('create-project-confirm')).toBeEnabled()
    })
    await userEvent.click(screen.getByTestId('create-project-confirm'))

    await waitFor(() => {
      expect(projectApiMocks.createProjectFolder).toHaveBeenCalledWith('/tmp/remembered', 'my-app')
    })
    expect(projectApiMocks.openDirectoryDialog).not.toHaveBeenCalled()
  })

  it('lets browsing override the remembered directory', async () => {
    settingsMocks.state.lastProjectDirectory = '/tmp/remembered'
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/parent')
    })
  })

  it('remembers the selected directory after a successful create', async () => {
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    await userEvent.click(screen.getByTestId('create-project-confirm'))

    await waitFor(() => {
      expect(settingsMocks.state.updateSetting).toHaveBeenCalledWith(
        'lastProjectDirectory',
        '/tmp/parent'
      )
    })
  })

  it('does not remember the directory when creation fails', async () => {
    projectApiMocks.createProjectFolder.mockResolvedValue({
      success: false,
      error: 'nope'
    })
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    await userEvent.click(screen.getByTestId('create-project-confirm'))

    await screen.findByTestId('create-project-error')
    expect(settingsMocks.state.updateSetting).not.toHaveBeenCalled()
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

// The dialog asks the server for the dev folder when it opens with no directory remembered.
// The cases above run under the client test/setup.ts installs, which answers undefined: no
// dev folder, so the location stays empty until a folder is picked.
describe('CreateProjectDialog location', () => {
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

  it('starts from the dev folder when no directory is remembered', async () => {
    answerDevFolder(devFolderState())
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('create-project-location')).toHaveValue('/Users/me/code')
    })

    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    await userEvent.click(screen.getByTestId('create-project-confirm'))

    await waitFor(() => {
      expect(projectApiMocks.createProjectFolder).toHaveBeenCalledWith('/Users/me/code', 'my-app')
    })
    expect(projectApiMocks.openDirectoryDialog).not.toHaveBeenCalled()
  })

  it('prefers the remembered directory, and does not ask for the dev folder then', async () => {
    settingsMocks.state.lastProjectDirectory = '/tmp/remembered'
    const request = answerDevFolder(devFolderState())
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/remembered')
    })
    await act(async () => {})

    expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/remembered')
    expect(devFolderCalls(request)).toBe(0)
  })

  it('stays empty when the dev folder is not on disk', async () => {
    const request = answerDevFolder(devFolderState({ exists: false }))
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await userEvent.type(screen.getByTestId('create-project-name-input'), 'my-app')
    await waitFor(() => expect(devFolderCalls(request)).toBe(1))

    expect(screen.getByTestId('create-project-location')).toHaveValue('')
    expect(screen.getByTestId('create-project-confirm')).toBeDisabled()
  })

  it('keeps the folder the person picked when the dev folder answers late', async () => {
    let answer: (state: DevFolderState) => void = () => {}
    answerDevFolder(
      new Promise<DevFolderState>((resolve) => {
        answer = resolve
      })
    )
    render(<CreateProjectDialog open onOpenChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => {
      expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/parent')
    })

    await act(async () => {
      answer(devFolderState())
    })

    expect(screen.getByTestId('create-project-location')).toHaveValue('/tmp/parent')
  })

  it('ignores an answer that arrives after it was closed', async () => {
    let answer: (state: DevFolderState) => void = () => {}
    const request = answerDevFolder(
      new Promise<DevFolderState>((resolve) => {
        answer = resolve
      })
    )
    const { rerender } = render(<CreateProjectDialog open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(devFolderCalls(request)).toBe(1))

    rerender(<CreateProjectDialog open={false} onOpenChange={vi.fn()} />)
    await act(async () => {
      answer(devFolderState())
    })

    // Opened again while the folder is gone: the answer from before must not show up.
    request.mockImplementation(async () => devFolderState({ exists: false }))
    rerender(<CreateProjectDialog open onOpenChange={vi.fn()} />)
    await waitFor(() => expect(devFolderCalls(request)).toBe(2))
    await act(async () => {})

    expect(screen.getByTestId('create-project-location')).toHaveValue('')
  })

  it('does not ask while it is closed', async () => {
    const request = answerDevFolder(devFolderState())
    render(<CreateProjectDialog open={false} onOpenChange={vi.fn()} />)
    await act(async () => {})

    expect(devFolderCalls(request)).toBe(0)
  })
})
