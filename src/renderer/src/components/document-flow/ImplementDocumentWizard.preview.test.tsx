import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHandoffModelCatalogCache } from '@/lib/handoffSelection'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CustomClaudeProvider } from '@shared/types/custom-provider'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  type DocumentRunDetail,
  type DocumentRunItem,
  type DocumentRunItemPatch,
  type DocumentRunLaunchConfig,
  type DocumentRunPatch
} from '@shared/types/document-flow'
import { ImplementDocumentWizard } from './ImplementDocumentWizard'
import { TEST_PROJECT, makeDetail } from './test-fixtures'
import { DOCFLOW_TEXT_DEBOUNCE_MS } from './useDebouncedText'
import { markRunAwaitingPrefs } from './useRunConfigDraft'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  updateRun: vi.fn(),
  updateItem: vi.fn(),
  start: vi.fn(),
  retryExtraction: vi.fn(),
  suggestVerifyCommand: vi.fn()
}))
const listBranchesWithStatus = vi.hoisted(() => vi.fn())
const listModels = vi.hoisted(() => vi.fn())

vi.mock('@/api/document-flow-api', () => ({ documentFlowApi: api }))
vi.mock('@/api/git-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/git-api')>()
  return { ...actual, gitApi: { ...actual.gitApi, listBranchesWithStatus } }
})
vi.mock('@/api/opencode-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/opencode-api')>()
  return { ...actual, opencodeApi: { ...actual.opencodeApi, listModels } }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const initialFlowState = useDocumentFlowStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSettingsState = useSettingsStore.getState()

// Opus exposes xhigh (ultracode-eligible on the CLI); Sonnet stops at high.
const CLAUDE_PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      opus: { id: 'opus', name: 'Opus', variants: { low: {}, high: {}, xhigh: {} } },
      sonnet: { id: 'sonnet', name: 'Sonnet', variants: { low: {}, high: {} } }
    }
  }
]

const ULTRACODE_ON_SDK: DocumentRunLaunchConfig = {
  sdk: 'claude-code',
  model: { providerID: 'anthropic', modelID: 'opus', variant: 'ultracode' },
  codexFastMode: false
}

const storedDetail = (runId: string): DocumentRunDetail =>
  useDocumentFlowStore.getState().runsById[runId]

/** Seed a previewed run, point the wizard at it and render. */
async function renderPreview(detail: DocumentRunDetail = makeDetail()): Promise<void> {
  useDocumentFlowStore.setState({
    runsById: { [detail.run.id]: detail },
    wizard: { open: true, projectId: TEST_PROJECT.id, runId: detail.run.id }
  })
  await act(async () => {
    render(<ImplementDocumentWizard />)
  })
}

const expandItem = (key: string): void => {
  fireEvent.click(screen.getByTestId(`docflow-item-toggle-${key}`))
}

async function confirmLaunch(): Promise<void> {
  fireEvent.click(screen.getByTestId('docflow-launch-btn'))
  await act(async () => {
    fireEvent.click(screen.getByTestId('docflow-launch-confirm-btn'))
  })
}

beforeAll(() => {
  // Radix menus rely on these in a real browser; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // The server's side of the store actions: apply the patch to the stored row.
  api.updateItem.mockImplementation(
    async (runId: string, itemId: string, patch: DocumentRunItemPatch) => ({
      ...storedDetail(runId).items.find((item) => item.id === itemId),
      ...patch
    })
  )
  api.updateRun.mockImplementation(async (runId: string, patch: DocumentRunPatch) => {
    const { run } = storedDetail(runId)
    return { ...run, config: { ...run.config, ...patch.config } }
  })
  api.start.mockImplementation(async (runId: string) => {
    const detail = storedDetail(runId)
    return {
      ...detail,
      run: { ...detail.run, status: 'running', integration_branch: 'doc-checkout-redesign' }
    }
  })
  api.get.mockImplementation(async (runId: string) => storedDetail(runId) ?? null)
  api.list.mockResolvedValue([])
  api.suggestVerifyCommand.mockResolvedValue(null)
  listBranchesWithStatus.mockResolvedValue({
    success: true,
    branches: [
      { name: 'main', isRemote: false, isCheckedOut: true, worktreePath: TEST_PROJECT.path },
      { name: 'develop', isRemote: false, isCheckedOut: false },
      { name: 'origin/main', isRemote: true, isCheckedOut: false }
    ]
  })
  listModels.mockResolvedValue({ success: true, providers: CLAUDE_PROVIDERS })
  useProjectStore.setState({ projects: [TEST_PROJECT] } as never)
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code-cli',
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    customProviders: []
  })
})

afterEach(async () => {
  // Let fetches a test did not wait for settle inside act before the tree goes away.
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
  clearHandoffModelCatalogCache()
  useDocumentFlowStore.setState(initialFlowState, true)
  useProjectStore.setState(initialProjectState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('ImplementDocumentWizard — preview list', () => {
  it('summarises the extraction: counts, numbering, model, warnings and open questions', async () => {
    const detail = makeDetail({}, [
      { key: 'A1' },
      { key: 'A2', kind: 'data', has_migration: true, conflict_risk: 'high', size: 'L' },
      { key: 'A3', doc_status: 'done', selected: false }
    ])
    detail.run.extraction = {
      documentTitle: 'Checkout redesign',
      numbering: 'A1…A3',
      openQuestions: ['Which payment providers stay?'],
      warnings: ['A3 depends on unknown task "B9"; ignored.'],
      generatedBy: 'claude-code · haiku',
      textLength: 12000,
      figureCount: 2
    }
    await renderPreview(detail)

    expect(screen.getByTestId('docflow-preview-meta')).toHaveTextContent(
      '3 tickets · 2 selected · numbered A1…A3 · extracted by claude-code · haiku'
    )
    expect(screen.getByTestId('docflow-extraction-warnings')).toHaveTextContent(
      'A3 depends on unknown task "B9"; ignored.'
    )
    expect(screen.queryByTestId('docflow-open-questions')).toBeNull()
    fireEvent.click(screen.getByTestId('docflow-open-questions-toggle'))
    expect(screen.getByTestId('docflow-open-questions')).toHaveTextContent(
      'Which payment providers stay?'
    )

    const migrationRow = screen.getByTestId('docflow-item-A2')
    expect(migrationRow).toHaveTextContent('data')
    expect(migrationRow).toHaveTextContent('migration')
    expect(migrationRow).toHaveTextContent('high conflict risk')
    // A ticket the document already marks done arrives deselected and says why.
    expect(screen.getByTestId('docflow-item-select-A3')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('docflow-item-doc-status-A3')).toHaveTextContent(
      'marked done in the document'
    )
    expect(screen.getByTestId('docflow-item-model-A1')).toHaveTextContent('default')
  })

  it('writes the include toggle of a ticket', async () => {
    await renderPreview()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-select-A2'))
    })

    expect(api.updateItem).toHaveBeenCalledTimes(1)
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A2', { selected: false })
    expect(screen.getByTestId('docflow-item-select-A2')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('docflow-selected-count')).toHaveTextContent('2 of 3 selected')
  })

  it('selects all and none, writing only the tickets that change', async () => {
    await renderPreview(makeDetail({}, [{ key: 'A1' }, { key: 'A2', selected: false }]))

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-select-all'))
    })
    expect(api.updateItem.mock.calls).toEqual([['run-1', 'item-A2', { selected: true }]])
    expect(screen.getByTestId('docflow-select-all')).toBeDisabled()

    api.updateItem.mockClear()
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-select-none'))
    })
    expect(api.updateItem.mock.calls).toEqual([
      ['run-1', 'item-A1', { selected: false }],
      ['run-1', 'item-A2', { selected: false }]
    ])
  })

  it('flags dependencies on tickets that are left out or do not exist', async () => {
    await renderPreview(
      makeDetail({}, [
        { key: 'A1' },
        { key: 'A2', depends_on: ['A1', 'A3', 'Z9'] },
        { key: 'A3', selected: false }
      ])
    )

    expect(screen.getByTestId('docflow-item-dep-A2-A1')).toHaveTextContent('after A1')
    expect(screen.getByTestId('docflow-item-dep-A2-A3')).toHaveTextContent(
      'after A3 (not included)'
    )
    expect(screen.getByTestId('docflow-item-dep-A2-Z9')).toHaveTextContent('after Z9 (unknown)')
    const notes = screen.getAllByTestId('docflow-launch-note').map((note) => note.textContent)
    expect(notes).toContain('A2 will not wait for A3 (not included)')
    // A note, not a blocker: the launch stays available.
    expect(screen.getByTestId('docflow-launch-btn')).not.toBeDisabled()
  })
})

describe('ImplementDocumentWizard — ticket editor', () => {
  it('writes a title edit once, after the typing pause', async () => {
    vi.useFakeTimers()
    await renderPreview()
    expandItem('A1')
    const input = screen.getByTestId('docflow-item-title-A1')

    fireEvent.change(input, { target: { value: 'Rename the ch' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS - 50)
    })
    fireEvent.change(input, { target: { value: 'Rename the checkout' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS - 50)
    })
    // Still inside the pause after the last keystroke.
    expect(api.updateItem).not.toHaveBeenCalled()
    expect(input).toHaveValue('Rename the checkout')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(api.updateItem).toHaveBeenCalledTimes(1)
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
      title: 'Rename the checkout'
    })
    expect(screen.getByTestId('docflow-item-toggle-A1')).toHaveTextContent('Rename the checkout')
  })

  it('keeps what is being typed when the server echoes a normalized title', async () => {
    vi.useFakeTimers()
    // The server's rule for titles: no quotes or angle brackets, single spaces, trimmed.
    api.updateItem.mockImplementation(
      async (runId: string, itemId: string, patch: DocumentRunItemPatch) => ({
        ...storedDetail(runId).items.find((item) => item.id === itemId),
        ...patch,
        ...(typeof patch.title === 'string'
          ? { title: patch.title.replace(/["<>]/g, '').replace(/\s+/g, ' ').trim() }
          : {})
      })
    )
    await renderPreview(makeDetail({}, [{ key: 'A1', title: 'Login fix' }]))
    expandItem('A1')
    const input = screen.getByTestId('docflow-item-title-A1')
    fireEvent.focus(input)

    fireEvent.change(input, { target: { value: 'Login fix for ' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', { title: 'Login fix for ' })
    expect(storedDetail('run-1').items[0].title).toBe('Login fix for')
    // The trailing space survives the echo: the next word does not run into the previous one.
    expect(input).toHaveValue('Login fix for ')

    fireEvent.change(input, { target: { value: 'Login fix for "mobile"' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(input).toHaveValue('Login fix for "mobile"')

    // Leaving the field shows what was stored.
    fireEvent.blur(input)
    expect(input).toHaveValue('Login fix for mobile')
    expect(screen.getByTestId('docflow-item-toggle-A1')).toHaveTextContent('Login fix for mobile')
  })

  it('does not write a cleared title, and restores the stored one when the field is left', async () => {
    vi.useFakeTimers()
    await renderPreview(makeDetail({}, [{ key: 'A1', title: 'Login fix' }]))
    expandItem('A1')
    const input = screen.getByTestId('docflow-item-title-A1')
    fireEvent.focus(input)

    fireEvent.change(input, { target: { value: '' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })

    expect(api.updateItem).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(input).toHaveValue('')

    fireEvent.blur(input)
    expect(input).toHaveValue('Login fix')
  })

  it('restores the stored title when the field is left with a cleared title still pending', async () => {
    vi.useFakeTimers()
    await renderPreview(makeDetail({}, [{ key: 'A1', title: 'Login fix' }]))
    expandItem('A1')
    const input = screen.getByTestId('docflow-item-title-A1')
    fireEvent.focus(input)

    fireEvent.change(input, { target: { value: '' } })
    // Left before the pause ends: the blank edit is flushed at once and writes nothing, so
    // the stored title never changes and the field has to fall back to it on its own.
    await act(async () => {
      fireEvent.blur(input)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })

    expect(api.updateItem).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(input).toHaveValue('Login fix')
    expect(screen.getByTestId('docflow-item-toggle-A1')).toHaveTextContent('Login fix')
  })

  it('writes a pending edit as soon as the field is left', async () => {
    vi.useFakeTimers()
    await renderPreview()
    expandItem('A1')
    const input = screen.getByTestId('docflow-item-title-A1')
    fireEvent.focus(input)

    fireEvent.change(input, { target: { value: 'Rename the checkout' } })
    await act(async () => {
      fireEvent.blur(input)
    })

    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
      title: 'Rename the checkout'
    })
    expect(input).toHaveValue('Rename the checkout')
    expect(screen.getByTestId('docflow-item-toggle-A1')).toHaveTextContent('Rename the checkout')
    // The debounce that was still running does not write a second time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(api.updateItem).toHaveBeenCalledTimes(1)
  })

  it('shows the stored title once a write in flight at blur time settles without changing it', async () => {
    vi.useFakeTimers()
    let settle: () => void = () => {}
    // Trims like the server, and holds the reply until the test releases it.
    api.updateItem.mockImplementation(
      async (runId: string, itemId: string, patch: DocumentRunItemPatch) => {
        await new Promise<void>((resolve) => {
          settle = resolve
        })
        return {
          ...storedDetail(runId).items.find((item) => item.id === itemId),
          ...patch,
          ...(typeof patch.title === 'string' ? { title: patch.title.trim() } : {})
        }
      }
    )
    await renderPreview(makeDetail({}, [{ key: 'A1', title: 'Login fix' }]))
    expandItem('A1')
    const input = screen.getByTestId('docflow-item-title-A1')
    fireEvent.focus(input)

    fireEvent.change(input, { target: { value: 'Login fix ' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', { title: 'Login fix ' })
    // Left while the write is in flight: the draft stays until the reply lands.
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(input).toHaveValue('Login fix ')

    await act(async () => {
      settle()
    })
    // The echo equals what was stored before, so no stored-value change re-synced the field:
    // it still has to show the stored title.
    expect(storedDetail('run-1').items[0].title).toBe('Login fix')
    expect(input).toHaveValue('Login fix')
  })

  it('writes a pending description edit when the row is collapsed', async () => {
    vi.useFakeTimers()
    await renderPreview()
    expandItem('A1')

    fireEvent.change(screen.getByTestId('docflow-item-description-A1'), {
      target: { value: 'Build the new checkout.' }
    })
    await act(async () => {
      expandItem('A1')
    })

    expect(screen.queryByTestId('docflow-item-editor-A1')).toBeNull()
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
      description: 'Build the new checkout.'
    })
    // The debounce that was still running does not write a second time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })
    expect(api.updateItem).toHaveBeenCalledTimes(1)
  })

  it('previews the description as markdown', async () => {
    await renderPreview(makeDetail({}, [{ key: 'A1', description: '## Goal\n\nShip it.' }]))
    expandItem('A1')

    fireEvent.click(screen.getByTestId('docflow-item-preview-toggle-A1'))

    const preview = screen.getByTestId('docflow-item-description-preview-A1')
    expect(within(preview).getByRole('heading', { name: 'Goal' })).toBeInTheDocument()
    expect(screen.queryByTestId('docflow-item-description-A1')).toBeNull()
  })

  it('edits dependencies with chips and refuses one that would close a cycle', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1' }, { key: 'A2', depends_on: ['A1'] }, { key: 'A3' }])
    )
    expandItem('A1')
    // A2 already starts after A1, so A1 cannot start after A2.
    expect(screen.getByTestId('docflow-item-dep-toggle-A1-A2')).toBeDisabled()

    expandItem('A2')
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-dep-toggle-A2-A3'))
    })
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', {
      depends_on: ['A1', 'A3']
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-dep-toggle-A2-A1'))
    })
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', { depends_on: ['A3'] })
  })

  it('sets and clears a per-ticket model, mounting the model picker only on demand', async () => {
    await renderPreview()
    // No picker (and no catalog request) for closed popovers or rows on the run default.
    expect(screen.queryByTestId('docflow-item-model-picker-A1-choose')).toBeNull()
    // The row itself opens the picker; the ticket stays collapsed.
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-model-trigger-A1'))
    })
    expect(screen.queryByTestId('docflow-item-editor-A1')).toBeNull()
    expect(screen.queryByTestId('model-selector')).toBeNull()
    expect(listModels).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-model-picker-A1-choose'))
    })
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      launch_config: {
        sdk: 'claude-code-cli',
        model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
        codexFastMode: false,
        customProviderId: null
      }
    })
    expect(await screen.findByTestId('model-selector')).toBeInTheDocument()

    // Another SDK gets that SDK's own default model, never the previous one's variant.
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-model-picker-A1-sdk-codex'))
    })
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      launch_config: {
        sdk: 'codex',
        model: { providerID: 'codex', modelID: 'gpt-5.5', variant: undefined },
        codexFastMode: false,
        customProviderId: null
      }
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-model-picker-A1-clear'))
    })
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', { launch_config: null })
    expect(screen.queryByTestId('model-selector')).toBeNull()
  })
})

describe('ImplementDocumentWizard — run settings', () => {
  it('writes the whole config when a setting changes', async () => {
    await renderPreview()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-parallel-increase'))
    })
    expect(screen.getByTestId('docflow-parallel-value')).toHaveTextContent('5')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: 'pnpm check', maxParallel: 5 }
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-interactive-switch'))
    })
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({ maxParallel: 5, interactive: false })
    })
  })

  it('switches between the full and the small prompt', async () => {
    await renderPreview()

    expect(screen.getByTestId('docflow-prompt-style-full')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('docflow-prompt-style-small')).toHaveAttribute(
      'aria-checked',
      'false'
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-prompt-style-small'))
    })
    expect(screen.getByTestId('docflow-prompt-style-small')).toHaveAttribute('aria-checked', 'true')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: 'pnpm check', promptStyle: 'small' }
    })

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    expect(screen.getByTestId('docflow-launch-confirm')).toHaveTextContent(
      'Promptsmall (no subagents)'
    )
  })

  it('keeps the parallel ticket count between 1 and 50', async () => {
    await renderPreview(
      makeDetail({ config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: '', maxParallel: 50 } })
    )
    expect(screen.getByTestId('docflow-parallel-increase')).toBeDisabled()

    for (let click = 0; click < 51; click += 1) {
      await act(async () => {
        fireEvent.click(screen.getByTestId('docflow-parallel-decrease'))
      })
    }

    expect(screen.getByTestId('docflow-parallel-value')).toHaveTextContent('1')
    expect(screen.getByTestId('docflow-parallel-decrease')).toBeDisabled()
    expect(api.updateRun).toHaveBeenCalledTimes(49)
  })

  it('offers the local branches as base, naming the one the default resolves to', async () => {
    await renderPreview()

    const select = screen.getByTestId('docflow-base-branch')
    expect(listBranchesWithStatus).toHaveBeenCalledWith(TEST_PROJECT.path)
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent)
    // "main" is checked out in the root checkout; a branch checked out in a ticket worktree
    // would not qualify.
    expect(options).toEqual(['Current branch (main)', 'develop', 'main'])

    await act(async () => {
      fireEvent.change(select, { target: { value: 'develop' } })
    })
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({ baseBranch: 'develop' })
    })

    await act(async () => {
      fireEvent.change(select, { target: { value: '' } })
    })
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({ baseBranch: null })
    })
  })

  it('does not name a branch for the default while the root checkout has none', async () => {
    listBranchesWithStatus.mockResolvedValue({
      success: true,
      branches: [
        { name: 'a1-task', isRemote: false, isCheckedOut: true, worktreePath: '/worktrees/a1' },
        { name: 'main', isRemote: false, isCheckedOut: false }
      ]
    })
    await renderPreview()

    const options = within(screen.getByTestId('docflow-base-branch'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual(['Current branch', 'a1-task', 'main'])
  })

  it('writes the verify command after the typing pause, an empty one as "none"', async () => {
    vi.useFakeTimers()
    await renderPreview()
    const input = screen.getByTestId('docflow-verify-command')
    expect(input).toHaveValue('pnpm check')

    fireEvent.change(input, { target: { value: '' } })
    expect(api.updateRun).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCFLOW_TEXT_DEBOUNCE_MS)
    })

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: expect.objectContaining({ verifyCommand: '' })
    })
  })

  it('starts from the verify command remembered for the project', async () => {
    useDocumentFlowStore.setState({
      prefs: {
        ...initialFlowState.prefs,
        verifyCommandByProject: { [TEST_PROJECT.id]: 'pnpm typecheck' }
      }
    })
    await renderPreview(makeDetail({ config: DEFAULT_DOCUMENT_RUN_CONFIG }))

    expect(screen.getByTestId('docflow-verify-command')).toHaveValue('pnpm typecheck')
    expect(api.suggestVerifyCommand).not.toHaveBeenCalled()
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: expect.objectContaining({ verifyCommand: 'pnpm typecheck' })
    })
  })

  it('keeps a remembered "no verification" instead of asking for a suggestion', async () => {
    useDocumentFlowStore.setState({
      prefs: { ...initialFlowState.prefs, verifyCommandByProject: { [TEST_PROJECT.id]: '' } }
    })
    await renderPreview(makeDetail({ config: DEFAULT_DOCUMENT_RUN_CONFIG }))

    expect(screen.getByTestId('docflow-verify-command')).toHaveValue('')
    expect(api.suggestVerifyCommand).not.toHaveBeenCalled()
  })

  it('suggests a verify command for a project without a remembered one', async () => {
    api.suggestVerifyCommand.mockResolvedValue('pnpm test')
    await renderPreview(makeDetail({ config: DEFAULT_DOCUMENT_RUN_CONFIG }))

    expect(api.suggestVerifyCommand).toHaveBeenCalledWith(TEST_PROJECT.id)
    expect(screen.getByTestId('docflow-verify-command')).toHaveValue('pnpm test')
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({ verifyCommand: 'pnpm test' })
    })
  })

  it('does not ask for a suggestion once the run has a verify command, even an empty one', async () => {
    await renderPreview(
      makeDetail({ config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: '' } })
    )

    expect(api.suggestVerifyCommand).not.toHaveBeenCalled()
    expect(api.updateRun).not.toHaveBeenCalled()
  })

  it('keeps a stored "no verification" over the command remembered for the project', async () => {
    useDocumentFlowStore.setState({
      prefs: {
        ...initialFlowState.prefs,
        verifyCommandByProject: { [TEST_PROJECT.id]: 'pnpm typecheck' }
      }
    })
    api.suggestVerifyCommand.mockResolvedValue('pnpm test')
    await renderPreview(
      makeDetail({ config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: '' } })
    )

    // The user cleared the field on purpose: neither the preference nor a guess replaces it.
    expect(screen.getByTestId('docflow-verify-command')).toHaveValue('')
    expect(api.suggestVerifyCommand).not.toHaveBeenCalled()
    expect(api.updateRun).not.toHaveBeenCalled()
  })

  it('applies the remembered settings to a run created in this session, once', async () => {
    useDocumentFlowStore.setState({
      prefs: {
        maxParallel: 6,
        interactive: false,
        promptStyle: 'small',
        verifyCommandByProject: {},
        defaultLaunch: null
      }
    })
    markRunAwaitingPrefs('run-1')
    const detail = makeDetail()
    await renderPreview(detail)

    expect(screen.getByTestId('docflow-parallel-value')).toHaveTextContent('6')
    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: expect.objectContaining({ maxParallel: 6, interactive: false, promptStyle: 'small' })
    })

    // Reopening the same run shows what is stored, not the prefs again.
    cleanup()
    api.updateRun.mockClear()
    useDocumentFlowStore.setState({ prefs: { ...initialFlowState.prefs, maxParallel: 2 } })
    await renderPreview(storedDetail('run-1'))
    expect(screen.getByTestId('docflow-parallel-value')).toHaveTextContent('6')
    expect(api.updateRun).not.toHaveBeenCalled()
  })

  it('sets a default model for the run', async () => {
    await renderPreview()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-default-model-choose'))
    })

    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: expect.objectContaining({
        defaultLaunch: {
          sdk: 'claude-code-cli',
          model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
          codexFastMode: false,
          customProviderId: null
        }
      })
    })
    expect(await screen.findByTestId('model-selector')).toBeInTheDocument()
  })
})

describe('ImplementDocumentWizard — launch', () => {
  it('blocks the launch when no ticket is selected', async () => {
    await renderPreview(
      makeDetail({}, [
        { key: 'A1', selected: false },
        { key: 'A2', selected: false }
      ])
    )

    expect(screen.getByTestId('docflow-launch-btn')).toBeDisabled()
    expect(screen.getByTestId('docflow-launch-blocker')).toHaveTextContent(
      'Select at least one ticket.'
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-select-A1'))
    })
    expect(screen.getByTestId('docflow-launch-btn')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-launch-btn')).toHaveTextContent('Launch run (1)')
  })

  it('blocks the launch for a ticket with ultracode on an SDK that cannot run it', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1' }, { key: 'A2', launch_config: ULTRACODE_ON_SDK }])
    )

    expect(screen.getByTestId('docflow-launch-btn')).toBeDisabled()
    expect(screen.getByTestId('docflow-launch-blocker')).toHaveTextContent(
      'A2: ultracode only works with the Claude CLI, not Claude Code.'
    )
    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    expect(screen.queryByTestId('docflow-launch-confirm')).toBeNull()

    // Leaving the ticket out removes the problem.
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-select-A2'))
    })
    expect(screen.getByTestId('docflow-launch-btn')).not.toBeDisabled()
  })

  it('blocks the launch when the run default has ultracode on the wrong SDK', async () => {
    await renderPreview(
      makeDetail({
        config: {
          ...DEFAULT_DOCUMENT_RUN_CONFIG,
          verifyCommand: '',
          defaultLaunch: ULTRACODE_ON_SDK
        }
      })
    )

    expect(screen.getByTestId('docflow-launch-btn')).toBeDisabled()
    expect(screen.getAllByTestId('docflow-launch-blocker')).toHaveLength(1)
    expect(screen.getByTestId('docflow-launch-blocker')).toHaveTextContent(
      /^Default model: ultracode/
    )
  })

  it('blocks ultracode on a CLI model without xhigh once the catalog is known', async () => {
    await renderPreview(
      makeDetail({}, [
        {
          key: 'A1',
          launch_config: {
            sdk: 'claude-code-cli',
            model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'ultracode' },
            codexFastMode: false
          }
        }
      ])
    )

    await waitFor(() => expect(screen.getByTestId('docflow-launch-btn')).toBeDisabled())
    expect(listModels).toHaveBeenCalledWith({ agentSdk: 'claude-code' })
    expect(screen.getByTestId('docflow-launch-blocker')).toHaveTextContent(
      'A1: "ultracode" is not available for sonnet on Claude CLI.'
    )
  })

  it('confirms with a summary, then saves the settings, starts the run and opens the dashboard', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1' }, { key: 'A2' }, { key: 'A3', selected: false }])
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-parallel-decrease'))
    })
    api.updateRun.mockClear()

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    const dialog = screen.getByTestId('docflow-launch-confirm')
    expect(dialog).toHaveTextContent('Launch 2 tickets?')
    // No base branch of its own: the summary names the root checkout's branch.
    expect(dialog).toHaveTextContent('An integration branch is created from main')
    expect(dialog).toHaveTextContent('Base branchmain')
    expect(dialog).toHaveTextContent('The base branch itself is not modified.')
    expect(dialog).toHaveTextContent('Parallel tickets3')
    expect(dialog).toHaveTextContent('Verify bynone')
    expect(dialog).toHaveTextContent('Verify commandpnpm check')
    expect(dialog).toHaveTextContent('ModelApp default')
    expect(dialog).toHaveTextContent('Promptfull (research with subagents)')
    expect(api.start).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-launch-confirm-btn'))
    })

    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: 'pnpm check', maxParallel: 3 }
    })
    expect(api.start).toHaveBeenCalledWith('run-1', expect.any(String))
    expect(api.updateRun.mock.invocationCallOrder[0]).toBeLessThan(
      api.start.mock.invocationCallOrder[0]
    )
    const state = useDocumentFlowStore.getState()
    expect(state.wizard.open).toBe(false)
    expect(state.dashboardRunId).toBe('run-1')
    expect(state.runsById['run-1'].run.status).toBe('running')
    // The launched settings become the next run's defaults.
    expect(state.prefs).toMatchObject({
      maxParallel: 3,
      verifyCommandByProject: { [TEST_PROJECT.id]: 'pnpm check' }
    })
  })

  it('says "no verify command" and names the base branch in the confirmation', async () => {
    await renderPreview(
      makeDetail({
        config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, verifyCommand: '  ', baseBranch: 'develop' }
      })
    )

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))

    const dialog = screen.getByTestId('docflow-launch-confirm')
    expect(dialog).toHaveTextContent('Verify commandno verify command')
    expect(dialog).toHaveTextContent('Base branchdevelop')
    expect(dialog).toHaveTextContent('An integration branch is created from develop')
  })

  it('does nothing when the confirmation is cancelled', async () => {
    await renderPreview()

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    fireEvent.click(screen.getByTestId('docflow-launch-confirm-cancel'))

    expect(api.start).not.toHaveBeenCalled()
    expect(api.updateRun).not.toHaveBeenCalled()
    expect(useDocumentFlowStore.getState().wizard.open).toBe(true)
  })

  it('writes edits that are still waiting for their debounce before it starts the run', async () => {
    await renderPreview()
    expandItem('A1')
    fireEvent.change(screen.getByTestId('docflow-item-title-A1'), {
      target: { value: 'Typed just before launching' }
    })
    fireEvent.change(screen.getByTestId('docflow-verify-command'), {
      target: { value: 'pnpm lint' }
    })

    await confirmLaunch()

    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
      title: 'Typed just before launching'
    })
    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: expect.objectContaining({ verifyCommand: 'pnpm lint' })
    })
    expect(api.updateItem.mock.invocationCallOrder[0]).toBeLessThan(
      api.start.mock.invocationCallOrder[0]
    )
    expect(api.updateRun.mock.invocationCallOrder[0]).toBeLessThan(
      api.start.mock.invocationCallOrder[0]
    )
  })

  it('shows why the run could not start and stays in the preview', async () => {
    api.start.mockRejectedValue(new Error('The base branch has uncommitted changes'))
    await renderPreview()

    await confirmLaunch()

    expect(screen.getByTestId('docflow-launch-error')).toHaveTextContent(
      'The base branch has uncommitted changes'
    )
    expect(toast.error).toHaveBeenCalledWith(
      'The run could not be launched: The base branch has uncommitted changes'
    )
    const state = useDocumentFlowStore.getState()
    expect(state.wizard).toMatchObject({ open: true, runId: 'run-1' })
    expect(state.dashboardRunId).toBeNull()
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'preview')
    expect(screen.getByTestId('docflow-launch-btn')).not.toBeDisabled()
  })

  it('cannot be dismissed while the launch is in flight, and toasts a failure that lands after it was closed anyway', async () => {
    let rejectStart: (cause: Error) => void = () => {}
    api.start.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        })
    )
    await renderPreview()

    await confirmLaunch()

    expect(screen.getByTestId('docflow-preview-cancel')).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('docflow-wizard'), { key: 'Escape' })
    expect(useDocumentFlowStore.getState().wizard.open).toBe(true)

    // Cmd+W goes through the store directly; the launch keeps going without the dialog.
    await act(async () => {
      useDocumentFlowStore.getState().closeWizard()
    })
    expect(screen.queryByTestId('docflow-wizard')).toBeNull()
    await act(async () => {
      rejectStart(new Error('The integration worktree could not be created'))
    })

    expect(toast.error).toHaveBeenCalledWith(
      'The run could not be launched: The integration worktree could not be created'
    )
    expect(useDocumentFlowStore.getState().dashboardRunId).toBeNull()
    expect(storedDetail('run-1').run.status).toBe('preview')
  })

  it('does not start the run when a pending edit cannot be saved', async () => {
    await renderPreview()
    expandItem('A1')
    api.updateItem.mockRejectedValue(new Error('The run is no longer in preview'))
    fireEvent.change(screen.getByTestId('docflow-item-title-A1'), {
      target: { value: 'An edit the server refuses' }
    })

    await confirmLaunch()

    expect(api.start).not.toHaveBeenCalled()
    expect(screen.getByTestId('docflow-launch-error')).toHaveTextContent(
      'The run is no longer in preview'
    )

    // The edit is still pending, not dropped: the next launch writes it before it starts.
    api.updateItem.mockImplementation(async (runId: string, itemId: string, patch: object) => ({
      ...storedDetail(runId).items.find((item) => item.id === itemId),
      ...patch
    }))
    await confirmLaunch()

    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      title: 'An edit the server refuses'
    })
    expect(api.start).toHaveBeenCalledWith('run-1', expect.any(String))
    expect(useDocumentFlowStore.getState().runsById['run-1'].items[0].title).toBe(
      'An edit the server refuses'
    )
  })

  it('says so when the document yielded no tickets', async () => {
    await renderPreview(makeDetail({}, []))

    expect(screen.getByTestId('docflow-no-items')).toHaveTextContent(/No tickets were found/)
    expect(screen.getByTestId('docflow-launch-btn')).toBeDisabled()
  })

  it('keeps the run in preview when the dialog is cancelled', async () => {
    await renderPreview()

    fireEvent.click(screen.getByTestId('docflow-preview-cancel'))

    const state = useDocumentFlowStore.getState()
    expect(state.wizard.open).toBe(false)
    expect(state.runsById['run-1'].run.status).toBe('preview')
    expect(api.start).not.toHaveBeenCalled()
  })

  it('re-extracts only after confirming that the tickets are replaced', async () => {
    api.retryExtraction.mockImplementation(async ({ runId }: { runId: string }) => ({
      ...storedDetail(runId),
      run: { ...storedDetail(runId).run, status: 'extracting' },
      items: []
    }))
    await renderPreview()

    fireEvent.click(screen.getByTestId('docflow-reextract-btn'))
    expect(api.retryExtraction).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-reextract-confirm'))
    })

    expect(api.retryExtraction).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }))
    expect(screen.getByTestId('docflow-wizard')).toHaveAttribute('data-step', 'extracting')
  })
})

describe('ImplementDocumentWizard — verification', () => {
  const VERIFIED: Partial<DocumentRunItem>[] = [
    { key: 'A1', verification_suggested: ['tests'], verification: ['tests'] },
    { key: 'A2', verification_suggested: [], verification: [] }
  ]

  it('shows the three chips on every row, pressed as chosen and marked where suggested', async () => {
    await renderPreview(makeDetail({}, [...VERIFIED]))

    const a1 = within(screen.getByTestId('docflow-item-verify-A1'))
    expect(a1.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByTestId('docflow-item-verify-A1-tcu')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('docflow-item-verify-A1-playwright')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).toHaveAttribute('data-suggested')
    expect(screen.getByTestId('docflow-item-verify-A1-tcu')).not.toHaveAttribute('data-suggested')

    const a2 = within(screen.getByTestId('docflow-item-verify-A2'))
    expect(a2.getAllByRole('button')).toHaveLength(3)
    for (const method of ['tcu', 'playwright', 'tests']) {
      const chip = screen.getByTestId(`docflow-item-verify-A2-${method}`)
      expect(chip).toHaveAttribute('aria-pressed', 'false')
      expect(chip).not.toHaveAttribute('data-suggested')
      expect(chip).not.toBeDisabled()
    }
  })

  it('writes a chip toggle: adds in canonical order, removes a pressed one', async () => {
    await renderPreview(makeDetail({}, [...VERIFIED]))

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-verify-A1-playwright'))
    })
    expect(api.updateItem).toHaveBeenCalledTimes(1)
    expect(api.updateItem).toHaveBeenCalledWith('run-1', 'item-A1', {
      verification: ['playwright', 'tests']
    })
    expect(screen.getByTestId('docflow-item-verify-A1-playwright')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-item-verify-A1-tests'))
    })
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      verification: ['playwright']
    })
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    // The suggestion is still shown once it is turned off.
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).toHaveAttribute('data-suggested')
  })

  it('skips verification for every ticket with the global checkmark, keeping each choice', async () => {
    await renderPreview(makeDetail({}, [...VERIFIED]))
    const toggle = screen.getByTestId('docflow-verification-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('docflow-item-verify-A1')).not.toHaveAttribute('data-disabled')

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(api.updateRun).toHaveBeenCalledTimes(1)
    expect(api.updateRun).toHaveBeenCalledWith('run-1', {
      config: {
        ...DEFAULT_DOCUMENT_RUN_CONFIG,
        verifyCommand: 'pnpm check',
        verificationDisabled: true
      }
    })
    expect(screen.getByTestId('docflow-verification-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(screen.getByTestId('docflow-item-verify-A1')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('docflow-item-verify-A2')).toHaveAttribute('data-disabled')
    for (const method of ['tcu', 'playwright', 'tests']) {
      expect(screen.getByTestId(`docflow-item-verify-A1-${method}`)).toBeDisabled()
      expect(screen.getByTestId(`docflow-item-verify-A2-${method}`)).toBeDisabled()
    }
    // The choice stays visible, so turning verification back on restores it.
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(api.updateItem).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByTestId('docflow-verification-toggle'))
    })
    expect(api.updateRun).toHaveBeenLastCalledWith('run-1', {
      config: {
        ...DEFAULT_DOCUMENT_RUN_CONFIG,
        verifyCommand: 'pnpm check',
        verificationDisabled: false
      }
    })
    expect(screen.getByTestId('docflow-verification-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('docflow-item-verify-A1')).not.toHaveAttribute('data-disabled')
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).not.toBeDisabled()
    expect(screen.getByTestId('docflow-item-verify-A1-tests')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('sums the chosen methods over the selected tickets in the confirmation', async () => {
    await renderPreview(
      makeDetail({}, [
        { key: 'A1', verification: ['tests'] },
        { key: 'A2', verification: ['tests'] },
        { key: 'A3', verification: ['tcu', 'tests'], selected: false }
      ])
    )

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    const dialog = screen.getByTestId('docflow-launch-confirm')
    expect(dialog).toHaveTextContent('Verify bytests ×2')
    expect(dialog).not.toHaveTextContent('tcu')
    expect(dialog).toHaveTextContent('Verify commandpnpm check')
  })

  it('says verification is skipped for every ticket in the confirmation once it is off', async () => {
    await renderPreview(
      makeDetail(
        {
          config: {
            ...DEFAULT_DOCUMENT_RUN_CONFIG,
            verifyCommand: 'pnpm check',
            verificationDisabled: true
          }
        },
        [
          { key: 'A1', verification: ['tests'] },
          { key: 'A2', verification: ['tests'] }
        ]
      )
    )

    fireEvent.click(screen.getByTestId('docflow-launch-btn'))
    const dialog = screen.getByTestId('docflow-launch-confirm')
    expect(dialog).toHaveTextContent('Verify byskipped for every ticket')
    expect(dialog).toHaveTextContent('Verify commandpnpm check')
  })
})

describe('ImplementDocumentWizard — quick model chips', () => {
  const SONNET_HIGH: DocumentRunLaunchConfig = {
    sdk: 'claude-code-cli',
    model: { providerID: 'anthropic', modelID: 'sonnet', variant: 'high' },
    codexFastMode: false
  }
  const OPUS_XHIGH: DocumentRunLaunchConfig = {
    sdk: 'claude-code-cli',
    model: { providerID: 'anthropic', modelID: 'opus', variant: 'xhigh' },
    codexFastMode: false
  }
  const CODEX: DocumentRunLaunchConfig = {
    sdk: 'codex',
    model: { providerID: 'codex', modelID: 'gpt-5.5' },
    codexFastMode: false
  }

  const chip = (key: string, index = 0): HTMLElement =>
    screen.getByTestId(`docflow-item-quick-model-${key}-${index}`)
  const queryChip = (key: string, index = 0): HTMLElement | null =>
    screen.queryByTestId(`docflow-item-quick-model-${key}-${index}`)
  const tap = async (element: HTMLElement): Promise<void> => {
    await act(async () => {
      fireEvent.click(element)
    })
  }

  it('offers no chip while every ticket is on the run default', async () => {
    await renderPreview()
    for (const key of ['A1', 'A2', 'A3']) {
      expect(screen.queryByTestId(`docflow-item-quick-models-${key}`)).toBeNull()
    }
  })

  it('offers a model one ticket uses on every row, pressed where it is in use', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1', launch_config: SONNET_HIGH }, { key: 'A2' }, { key: 'A3' }])
    )

    expect(chip('A1')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('A1')).toHaveTextContent(/sonnet/i)
    expect(chip('A1')).toHaveTextContent('high')
    // The pressed chip names the model, so the picker trigger only keeps its arrows.
    expect(screen.queryByTestId('docflow-item-model-A1')).toBeNull()
    expect(screen.getByTestId('docflow-item-model-trigger-A1')).toBeInTheDocument()

    for (const key of ['A2', 'A3']) {
      expect(chip(key)).toHaveAttribute('aria-pressed', 'false')
      expect(chip(key)).toHaveTextContent(/sonnet/i)
      expect(queryChip(key, 1)).toBeNull()
      expect(screen.getByTestId(`docflow-item-model-${key}`)).toHaveTextContent('default')
    }
    // Chips need no picker.
    expect(screen.queryByTestId('model-selector')).toBeNull()
  })

  it('applies the model with one tap and goes back to the default with the next', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1', launch_config: SONNET_HIGH }, { key: 'A2' }, { key: 'A3' }])
    )

    await tap(chip('A2'))
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', {
      launch_config: SONNET_HIGH
    })
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('docflow-item-model-A2')).toBeNull()
    // A tap neither expands the ticket nor opens the picker.
    expect(screen.queryByTestId('docflow-item-editor-A2')).toBeNull()
    expect(screen.queryByTestId('docflow-item-model-picker-A2')).toBeNull()
    // The other rows are untouched.
    expect(chip('A1')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('A3')).toHaveAttribute('aria-pressed', 'false')

    await tap(chip('A2'))
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', { launch_config: null })
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('docflow-item-model-A2')).toHaveTextContent('default')
  })

  it('keeps a chip after the last ticket using it went back to the default', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1', launch_config: SONNET_HIGH }, { key: 'A2' }, { key: 'A3' }])
    )

    await tap(chip('A1'))
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', { launch_config: null })
    for (const key of ['A1', 'A2', 'A3']) {
      expect(chip(key)).toHaveAttribute('aria-pressed', 'false')
    }

    await tap(chip('A3'))
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A3', {
      launch_config: SONNET_HIGH
    })
    expect(chip('A3')).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches a row between two models, one write per tap', async () => {
    await renderPreview(
      makeDetail({}, [
        { key: 'A1', launch_config: SONNET_HIGH },
        { key: 'A2', launch_config: CODEX },
        { key: 'A3' }
      ])
    )
    // Same chips in the same order on every row.
    for (const key of ['A1', 'A2', 'A3']) {
      expect(chip(key, 0)).toHaveTextContent(/sonnet/i)
      expect(chip(key, 1)).toHaveTextContent('gpt-5.5')
    }
    expect(chip('A1', 0)).toHaveAttribute('aria-pressed', 'true')
    expect(chip('A1', 1)).toHaveAttribute('aria-pressed', 'false')
    expect(chip('A2', 0)).toHaveAttribute('aria-pressed', 'false')
    expect(chip('A2', 1)).toHaveAttribute('aria-pressed', 'true')

    api.updateItem.mockClear()
    await tap(chip('A3', 0))
    await tap(chip('A3', 1))
    expect(api.updateItem.mock.calls).toEqual([
      ['run-1', 'item-A3', { launch_config: SONNET_HIGH }],
      ['run-1', 'item-A3', { launch_config: CODEX }]
    ])
    expect(chip('A3', 0)).toHaveAttribute('aria-pressed', 'false')
    expect(chip('A3', 1)).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers the two latest models; a ticket on an older one shows it in its trigger', async () => {
    await renderPreview(
      makeDetail({}, [
        { key: 'A1', launch_config: SONNET_HIGH },
        { key: 'A2', launch_config: OPUS_XHIGH },
        { key: 'A3', launch_config: CODEX },
        { key: 'A4' }
      ])
    )
    for (const key of ['A1', 'A4']) {
      expect(chip(key, 0)).toHaveTextContent(/opus/i)
      expect(chip(key, 1)).toHaveTextContent('gpt-5.5')
      expect(queryChip(key, 2)).toBeNull()
      expect(chip(key, 0)).toHaveAttribute('aria-pressed', 'false')
      expect(chip(key, 1)).toHaveAttribute('aria-pressed', 'false')
    }
    expect(screen.getByTestId('docflow-item-model-A1')).toHaveTextContent(/sonnet/i)
    expect(screen.getByTestId('docflow-item-model-A4')).toHaveTextContent('default')
  })

  it('does not offer the run default as a chip', async () => {
    await renderPreview(
      makeDetail({ config: { ...DEFAULT_DOCUMENT_RUN_CONFIG, defaultLaunch: SONNET_HIGH } }, [
        { key: 'A1', launch_config: { ...SONNET_HIGH, customProviderId: null } },
        { key: 'A2', launch_config: CODEX },
        { key: 'A3' }
      ])
    )
    expect(chip('A3', 0)).toHaveTextContent('gpt-5.5')
    expect(queryChip('A3', 1)).toBeNull()
    // A1 spells out the run default; no chip stands for it, so its trigger says so.
    expect(screen.getByTestId('docflow-item-model-A1')).toHaveTextContent(/sonnet/i)
  })

  it('leaves the row as it was when the write fails', async () => {
    await renderPreview(
      makeDetail({}, [{ key: 'A1', launch_config: SONNET_HIGH }, { key: 'A2' }, { key: 'A3' }])
    )
    api.updateItem.mockRejectedValueOnce(new Error('nope'))

    await tap(chip('A2'))
    expect(toast.error).toHaveBeenCalledWith('Could not save your edit: nope')
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('docflow-item-model-A2')).toHaveTextContent('default')
  })

  it('checks a model applied with a chip like one chosen in the picker', async () => {
    await renderPreview(
      makeDetail({}, [
        { key: 'A1' },
        { key: 'A2', launch_config: ULTRACODE_ON_SDK, selected: false }
      ])
    )
    expect(screen.queryByTestId('docflow-launch-blocker')).toBeNull()

    // A deselected ticket still offers its model to the others.
    await tap(chip('A1'))
    expect(screen.getByTestId('docflow-launch-blocker')).toHaveTextContent(
      'A1: ultracode only works with the Claude CLI, not Claude Code.'
    )
  })

  it('tells apart chips that differ only in fast mode or in their custom provider', async () => {
    const provider = (id: string, name: string): CustomClaudeProvider => ({
      id,
      name,
      command: `${id}-claude`,
      usageProvider: 'none'
    })
    useSettingsStore.setState({
      customProviders: [provider('provider-1', 'Z.ai'), provider('provider-2', 'Moonshot')]
    })
    const custom = (customProviderId: string): DocumentRunLaunchConfig => ({
      sdk: 'claude-code-cli',
      model: null,
      codexFastMode: false,
      customProviderId
    })
    await renderPreview(
      makeDetail({}, [
        { key: 'A1', launch_config: custom('provider-1') },
        { key: 'A2', launch_config: custom('provider-2') },
        { key: 'A3' }
      ])
    )
    expect(chip('A3', 0)).toHaveTextContent('Z.ai')
    expect(chip('A3', 0)).toHaveAttribute('title', 'Use Claude CLI (Z.ai) · default model')
    expect(chip('A3', 1)).toHaveTextContent('Moonshot')
    expect(chip('A3', 1)).toHaveAttribute('title', 'Use Claude CLI (Moonshot) · default model')
    cleanup()

    await renderPreview(
      makeDetail({}, [
        { key: 'A1', launch_config: CODEX },
        { key: 'A2', launch_config: { ...CODEX, codexFastMode: true } },
        { key: 'A3' }
      ])
    )
    expect(chip('A3', 0)).not.toHaveTextContent('fast')
    expect(chip('A3', 0)).toHaveAttribute('title', 'Use Codex · gpt-5.5')
    expect(chip('A3', 1)).toHaveTextContent('fast')
    expect(chip('A3', 1)).toHaveAttribute('title', 'Use Codex · gpt-5.5 · fast')
    expect(chip('A2', 1)).toHaveAttribute(
      'title',
      'Codex · gpt-5.5 · fast (click to use the run default)'
    )
  })

  it('holds a picked model back while its save is still on the way after the picker closed', async () => {
    await renderPreview()

    await tap(screen.getByTestId('docflow-item-model-trigger-A1'))
    // The first step lands: the stored model is the one the picker only passes through.
    await tap(screen.getByTestId('docflow-item-model-picker-A1-choose'))

    let land: () => void = () => {}
    api.updateItem.mockImplementationOnce(
      async (runId: string, itemId: string, patch: DocumentRunItemPatch) => {
        await new Promise<void>((resolve) => {
          land = resolve
        })
        return { ...storedDetail(runId).items.find((item) => item.id === itemId), ...patch }
      }
    )
    await tap(screen.getByTestId('docflow-item-model-picker-A1-sdk-codex'))
    await tap(screen.getByTestId('docflow-item-model-trigger-A1'))
    expect(screen.queryByTestId('docflow-item-model-picker-A1')).toBeNull()

    // Closed, but the last pick has not landed: the model passed through is not offered.
    expect(screen.getByTestId('docflow-item-model-A1')).toHaveTextContent(/sonnet/i)
    expect(screen.queryByTestId('docflow-item-quick-models-A2')).toBeNull()

    await act(async () => {
      land()
    })
    expect(chip('A2')).toHaveTextContent('gpt-5.5')
    expect(queryChip('A2', 1)).toBeNull()
    expect(chip('A1')).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers a model picked in the picker once the picker is closed', async () => {
    await renderPreview()

    await tap(screen.getByTestId('docflow-item-model-trigger-A1'))
    await tap(screen.getByTestId('docflow-item-model-picker-A1-choose'))
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A1', {
      launch_config: expect.objectContaining({ sdk: 'claude-code-cli' })
    })
    // Still picking: every step is saved, and none of them should flash up on the other rows.
    await tap(screen.getByTestId('docflow-item-model-picker-A1-sdk-codex'))
    expect(screen.getByTestId('docflow-item-model-A1')).toHaveTextContent('gpt-5.5')
    expect(screen.queryByTestId('docflow-item-quick-models-A1')).toBeNull()
    expect(screen.queryByTestId('docflow-item-quick-models-A2')).toBeNull()

    await tap(screen.getByTestId('docflow-item-model-trigger-A1'))
    expect(screen.queryByTestId('docflow-item-model-picker-A1')).toBeNull()

    // Only the model the picker ended on is offered, not the one it passed through.
    expect(chip('A1')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('A1')).toHaveTextContent('gpt-5.5')
    expect(queryChip('A1', 1)).toBeNull()
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'false')
    expect(chip('A2')).toHaveTextContent('gpt-5.5')

    await tap(chip('A2'))
    expect(api.updateItem).toHaveBeenLastCalledWith('run-1', 'item-A2', {
      launch_config: {
        sdk: 'codex',
        model: { providerID: 'codex', modelID: 'gpt-5.5', variant: undefined },
        codexFastMode: false,
        customProviderId: null
      }
    })
    expect(chip('A2')).toHaveAttribute('aria-pressed', 'true')
  })
})
