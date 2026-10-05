import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ImplementDocumentWizard } from './ImplementDocumentWizard'
import { TEST_PROJECT, makeDetail } from './test-fixtures'

const api = vi.hoisted(() => ({
  createRun: vi.fn(),
  retryExtraction: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  suggestVerifyCommand: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSettingsState = useSettingsStore.getState()

const GENERATION = { provider: 'claude-code', model: 'haiku' }

function openWizard(runId: string | null = null, projectId: string = TEST_PROJECT.id): void {
  useDocumentFlowStore.setState({ wizard: { open: true, projectId, runId } })
}

function seedRuns(...details: ReturnType<typeof makeDetail>[]): void {
  useDocumentFlowStore.setState({
    runsById: Object.fromEntries(details.map((detail) => [detail.run.id, detail])),
    loadedProjects: { [TEST_PROJECT.id]: true }
  })
  api.list.mockResolvedValue(details)
}

function enableFilePicking(path: string): void {
  window.desktopBridge = { getPathForFile: vi.fn(() => path) } as never
}

const specFile = (): File => new File(['<h1>Spec</h1>'], 'spec.html', { type: 'text/html' })

/** Render and let the run list (and anything else fetched on mount) land. */
async function renderWizard(): Promise<void> {
  await act(async () => {
    render(<ImplementDocumentWizard />)
  })
}

beforeEach(() => {
  api.list.mockResolvedValue([])
  api.get.mockResolvedValue(null)
  api.suggestVerifyCommand.mockResolvedValue(null)
  api.createRun.mockImplementation(async ({ documentPath }: { documentPath: string }) =>
    makeDetail({ id: 'run-new', status: 'extracting', source_path: documentPath }, [])
  )
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
  useSettingsStore.setState({
    prContentModel: { agentSdk: 'claude-code', providerID: 'anthropic', modelID: 'haiku' },
    defaultAgentSdk: 'claude-code',
    availableAgentSdks: { opencode: true, claude: true, codex: true }
  })
})

afterEach(async () => {
  // Let fetches a test did not wait for settle inside act before the tree goes away.
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  delete (window as { desktopBridge?: unknown }).desktopBridge
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('ImplementDocumentWizard — pick step', () => {
  it('renders nothing while closed', async () => {
    await renderWizard()
    expect(screen.queryByTestId('docflow-wizard')).toBeNull()
  })

  it('extracts the file chosen with the file input', async () => {
    enableFilePicking('/docs/spec.html')
    openWizard()
    await renderWizard()

    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'pick')
    expect(screen.getByTestId('docflow-extract-btn')).toBeDisabled()
    fireEvent.change(screen.getByTestId('docflow-file-input'), {
      target: { files: [specFile()] }
    })
    expect(screen.getByTestId('docflow-path-input')).toHaveValue('/docs/spec.html')
    // Picking a file does not start the (paid) extraction by itself.
    expect(api.createRun).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('docflow-extract-btn'))

    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith({
        projectId: TEST_PROJECT.id,
        documentPath: '/docs/spec.html',
        generation: GENERATION
      })
    )
    // The wizard follows the new run into its extracting step.
    await waitFor(() =>
      expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'extracting')
    )
    expect(useDocumentFlowStore.getState().wizard.runId).toBe('run-new')
  })

  it('takes a dropped file and keeps the drop away from the window drop zone', async () => {
    enableFilePicking('/docs/dropped.md')
    const windowDrop = vi.fn()
    window.addEventListener('drop', windowDrop)
    openWizard()
    await renderWizard()

    const dataTransfer = { files: [specFile()], types: ['Files'], dropEffect: 'none' }
    fireEvent.dragOver(screen.getByTestId('docflow-drop-zone'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('docflow-drop-zone'), { dataTransfer })
    expect(screen.getByTestId('docflow-path-input')).toHaveValue('/docs/dropped.md')

    // A drop that misses the zone must not attach the file to the session behind the dialog.
    fireEvent.drop(screen.getByTestId('docflow-wizard'), { dataTransfer })

    expect(windowDrop).not.toHaveBeenCalled()
    window.removeEventListener('drop', windowDrop)
  })

  it('accepts a typed file:// URL and submits on Enter', async () => {
    openWizard()
    await renderWizard()

    const input = screen.getByTestId('docflow-path-input')
    fireEvent.change(input, { target: { value: 'file:///Users/me/My%20Spec.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ documentPath: '/Users/me/My Spec.md' })
      )
    )
  })

  it('sends the notes typed next to the document with the extraction', async () => {
    openWizard()
    await renderWizard()

    fireEvent.change(screen.getByTestId('docflow-path-input'), {
      target: { value: '/docs/spec.html' }
    })
    fireEvent.change(screen.getByTestId('docflow-notes-input'), {
      target: { value: ' only tasks 7, 8 and 9 ' }
    })
    fireEvent.click(screen.getByTestId('docflow-extract-btn'))

    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith({
        projectId: TEST_PROJECT.id,
        documentPath: '/docs/spec.html',
        generation: GENERATION,
        notes: 'only tasks 7, 8 and 9'
      })
    )
  })

  it('accepts a home-relative path and leaves its expansion to the server', async () => {
    openWizard()
    await renderWizard()

    const input = screen.getByTestId('docflow-path-input')
    fireEvent.change(input, { target: { value: '~/Documents/spec.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(api.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ documentPath: '~/Documents/spec.md' })
      )
    )
    expect(screen.queryByTestId('docflow-pick-error')).toBeNull()
  })

  it('refuses relative paths and unsupported files without creating a run', async () => {
    openWizard()
    await renderWizard()
    const input = screen.getByTestId('docflow-path-input')

    fireEvent.change(input, { target: { value: 'docs/spec.html' } })
    fireEvent.click(screen.getByTestId('docflow-extract-btn'))
    expect(screen.getByTestId('docflow-pick-error')).toHaveTextContent(/absolute path/)

    fireEvent.change(input, { target: { value: '/docs/spec.pdf' } })
    expect(screen.queryByTestId('docflow-pick-error')).toBeNull()
    fireEvent.click(screen.getByTestId('docflow-extract-btn'))
    expect(screen.getByTestId('docflow-pick-error')).toHaveTextContent(/HTML, Markdown or text/)

    expect(api.createRun).not.toHaveBeenCalled()
  })

  it('shows why the run could not be created and stays on the pick step', async () => {
    api.createRun.mockRejectedValue(new Error('The document is empty'))
    openWizard()
    await renderWizard()

    fireEvent.change(screen.getByTestId('docflow-path-input'), {
      target: { value: '/docs/spec.html' }
    })
    fireEvent.click(screen.getByTestId('docflow-extract-btn'))

    expect(await screen.findByTestId('docflow-pick-error')).toHaveTextContent(
      'The document is empty'
    )
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'pick')
    expect(screen.getByTestId('docflow-extract-btn')).not.toBeDisabled()
  })

  it('offers only the path field where file paths cannot be resolved (web UI)', async () => {
    openWizard()
    await renderWizard()

    expect(screen.getByTestId('docflow-path-input')).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-drop-zone')).toBeNull()
    expect(screen.queryByTestId('docflow-file-input')).toBeNull()
  })

  it('reports a file whose path cannot be read instead of extracting nothing', async () => {
    enableFilePicking('')
    openWizard()
    await renderWizard()

    fireEvent.change(screen.getByTestId('docflow-file-input'), {
      target: { files: [specFile()] }
    })

    expect(screen.getByTestId('docflow-pick-error')).toHaveTextContent(/Type its path instead/)
    expect(screen.getByTestId('docflow-path-input')).toHaveValue('')
  })

  it('explains that connection projects are not supported', async () => {
    useProjectStore.setState({
      projects: [{ ...TEST_PROJECT, id: 'project-conn', kind: 'connection' }]
    } as never)
    openWizard(null, 'project-conn')
    await renderWizard()

    expect(screen.getByTestId('docflow-wizard-unsupported')).toHaveTextContent(/git projects only/)
    expect(screen.queryByTestId('docflow-path-input')).toBeNull()
  })
})

describe('ImplementDocumentWizard — previous runs', () => {
  it('loads the runs of the project and lists them with status and counts', async () => {
    const preview = makeDetail({ id: 'run-preview', title: 'Checkout redesign' })
    api.list.mockResolvedValue([preview])
    openWizard()
    await renderWizard()

    const row = await screen.findByTestId('docflow-run-row-run-preview')
    expect(api.list).toHaveBeenCalledWith(TEST_PROJECT.id)
    expect(row).toHaveTextContent('Checkout redesign')
    expect(row).toHaveTextContent('Ready to review')
    expect(row).toHaveTextContent('3 tickets · 3 selected')
  })

  it('reopens a failed run in the wizard', async () => {
    seedRuns(makeDetail({ id: 'run-failed', status: 'extract_failed', error: 'Timed out' }, []))
    openWizard()
    await renderWizard()

    fireEvent.click(screen.getByTestId('docflow-run-row-run-failed'))

    expect(useDocumentFlowStore.getState().wizard).toMatchObject({
      open: true,
      runId: 'run-failed'
    })
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'failed')
  })

  it('opens a launched run in the dashboard and closes the wizard', async () => {
    const running = makeDetail({ id: 'run-live', status: 'running' }, [
      { key: 'A1', status: 'merged' },
      { key: 'A2', status: 'needs_input' }
    ])
    seedRuns(running)
    api.get.mockResolvedValue(running)
    openWizard()
    await renderWizard()

    const row = screen.getByTestId('docflow-run-row-run-live')
    expect(row).toHaveTextContent('1/2 merged · 1 need you')
    fireEvent.click(row)

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-live')
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })

  it('deletes a run only after confirmation, and never offers it for a live run', async () => {
    api.delete.mockResolvedValue(true)
    seedRuns(
      makeDetail(
        {
          id: 'run-old',
          title: 'Checkout redesign',
          status: 'completed',
          created_at: '2026-05-01T10:00:00.000Z'
        },
        [{ key: 'A1', status: 'merged', ticket_id: 'ticket-A1' }]
      ),
      makeDetail({ id: 'run-live', status: 'running' }),
      makeDetail({ id: 'run-paused', status: 'paused' })
    )
    openWizard()
    await renderWizard()

    expect(screen.queryByTestId('docflow-run-delete-run-live')).toBeNull()
    expect(screen.queryByTestId('docflow-run-delete-run-paused')).toBeNull()

    fireEvent.click(screen.getByTestId('docflow-run-delete-run-old'))
    // A launched run's tickets attach its spec text and figures by path, so those files stay.
    expect(
      screen.getByText(
        /Checkout redesign and its extracted tickets are removed from the list\. The run's own ticket is removed from the board\. Branches, worktrees and the tickets of its tasks are not touched, and the spec text and figures those tickets attach stay on disk\./
      )
    ).toBeInTheDocument()
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('docflow-run-delete-confirm'))

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('run-old'))
    await waitFor(() => expect(screen.queryByTestId('docflow-run-row-run-old')).toBeNull())
    expect(screen.getByTestId('docflow-run-row-run-live')).toBeInTheDocument()
  })

  it('says that deleting a run that never launched removes its files too', async () => {
    seedRuns(makeDetail({ id: 'run-draft', title: 'Checkout redesign' }))
    openWizard()
    await renderWizard()

    fireEvent.click(screen.getByTestId('docflow-run-delete-run-draft'))
    expect(
      screen.getByText(
        /Checkout redesign and its extracted tickets are removed from the list\. Its spec text and figures are removed from disk as well\./
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('docflow-run-delete-cancel'))
    expect(api.delete).not.toHaveBeenCalled()
  })
})

describe('ImplementDocumentWizard — extracting and failed steps', () => {
  it('shows the document and the model that is extracting', async () => {
    seedRuns(
      makeDetail(
        {
          status: 'extracting',
          source_path: '/docs/checkout-redesign.html',
          config: { ...makeDetail().run.config, generation: { provider: 'codex', model: 'gpt-5' } }
        },
        []
      )
    )
    openWizard('run-1')
    await renderWizard()

    const step = screen.getByTestId('docflow-extracting')
    expect(step).toHaveTextContent('checkout-redesign.html')
    expect(screen.getByTestId('docflow-extracting-model')).toHaveTextContent('codex · gpt-5')
    expect(step).toHaveTextContent(/PR content model/)
    expect(step).toHaveTextContent(/Settings › Models/)
    expect(step).toHaveTextContent(/Extraction continues/)
  })

  it('says the provider default is used when no model is configured', async () => {
    useSettingsStore.setState({ prContentModel: null })
    seedRuns(makeDetail({ status: 'extracting' }, []))
    openWizard('run-1')
    await renderWizard()

    expect(screen.getByTestId('docflow-extracting-model')).toHaveTextContent(
      "claude-code · the provider's default model"
    )
  })

  it('moves to the preview when the store learns the extraction finished', async () => {
    seedRuns(makeDetail({ status: 'extracting' }, []))
    openWizard('run-1')
    await renderWizard()
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'extracting')

    await act(async () => {
      useDocumentFlowStore.getState().applyDetail(makeDetail({ status: 'preview' }))
    })

    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'preview')
    expect(within(screen.getByTestId('docflow-item-list')).getByText('Task A1')).toBeInTheDocument()
  })

  it('shows the extraction error and retries with the current generation model', async () => {
    seedRuns(makeDetail({ status: 'extract_failed', error: 'The model returned no JSON' }, []))
    api.retryExtraction.mockResolvedValue(makeDetail({ status: 'extracting', error: null }, []))
    openWizard('run-1')
    await renderWizard()

    expect(screen.getByTestId('docflow-extract-error')).toHaveTextContent(
      'The model returned no JSON'
    )
    fireEvent.click(screen.getByTestId('docflow-retry-extraction-btn'))

    await waitFor(() =>
      expect(api.retryExtraction).toHaveBeenCalledWith({ runId: 'run-1', generation: GENERATION })
    )
    await waitFor(() =>
      expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'extracting')
    )
  })

  it('keeps the failed step and says why when the retry itself is refused', async () => {
    seedRuns(makeDetail({ status: 'extract_failed', error: 'The model returned no JSON' }, []))
    api.retryExtraction.mockRejectedValue(new Error('Document not found'))
    openWizard('run-1')
    await renderWizard()

    fireEvent.click(screen.getByTestId('docflow-retry-extraction-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('docflow-extract-error')).toHaveTextContent('Document not found')
    )
    expect(screen.getByTestId('docflow-retry-extraction-btn')).not.toBeDisabled()
  })

  it('goes back to the picker with "Choose another document"', async () => {
    seedRuns(makeDetail({ status: 'extract_failed', error: 'Timed out' }, []))
    openWizard('run-1')
    await renderWizard()

    // The picker fetches the project's runs as it mounts.
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-choose-another-btn'))
    })

    expect(useDocumentFlowStore.getState().wizard).toMatchObject({ open: true, runId: null })
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'pick')
  })
})

describe('ImplementDocumentWizard — opened on a run', () => {
  it('fetches a run it has not loaded and lands on its step', async () => {
    let deliver: (detail: ReturnType<typeof makeDetail>) => void = () => {}
    api.get.mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve
      })
    )
    openWizard('run-1')
    await renderWizard()

    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'loading')
    expect(api.get).toHaveBeenCalledWith('run-1')
    await act(async () => {
      deliver(makeDetail({ status: 'extract_failed', error: 'Timed out' }, []))
    })

    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'failed')
  })

  it('falls back to the picker when the run no longer exists', async () => {
    api.get.mockResolvedValue(null)
    openWizard('run-gone')
    await renderWizard()

    await waitFor(() =>
      expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'pick')
    )
    expect(useDocumentFlowStore.getState().wizard.runId).toBeNull()
  })

  it('hands a run that is already launched over to the dashboard', async () => {
    const running = makeDetail({ status: 'running' })
    seedRuns(running)
    api.get.mockResolvedValue(running)
    openWizard('run-1')
    await renderWizard()

    fireEvent.click(screen.getByTestId('docflow-open-dashboard-btn'))

    expect(useDocumentFlowStore.getState().dashboardRunId).toBe('run-1')
    expect(useDocumentFlowStore.getState().wizard.open).toBe(false)
  })
})
