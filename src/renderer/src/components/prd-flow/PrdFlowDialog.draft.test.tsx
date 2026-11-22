// "New PRD → orchestrator ticket": the form's "Save for later", and the form as it opens on a
// draft that was saved. What "Save for later" needs (a name, and nothing more), exactly what it
// hands to savePrdFlowDraft, what a refused and an accepted save do, and, for a saved draft,
// the answers the form starts from and the ticket "Save" and "Start" act on. Saving a draft
// and starting a flow are lib/prd-flow's: both are faked here.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const start = vi.hoisted(() => ({ startPrdFlow: vi.fn() }))
const draftLib = vi.hoisted(() => ({ savePrdFlowDraft: vi.fn() }))
const where = vi.hoisted(() => ({
  resolvePrdFlowTarget: vi.fn(),
  findExistingPrdFlowFiles: vi.fn()
}))
vi.mock('@/lib/prd-flow/start', () => start)
vi.mock('@/lib/prd-flow/draft', () => draftLib)
vi.mock('@/lib/prd-flow/target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prd-flow/target')>()),
  ...where
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />
}))
vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

import { toast } from '@/lib/toast'
import type { PrdFlowTargetResult } from '@/lib/prd-flow/target'
import { usePrdFlowStore, type PrdFlowDraft } from '@/stores/usePrdFlowStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import { PrdFlowDialog } from './PrdFlowDialog'
import { PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS } from './prd-flow-form'

const MAIN_CHECKOUT: PrdFlowTargetResult = {
  ok: true,
  target: {
    checkout: { kind: 'worktree', worktreeId: 'wt-main' },
    cwd: '/repo/main',
    memberDirs: []
  }
}

const OPUS: DocumentRunLaunchConfig = {
  sdk: 'claude-code-cli',
  model: { providerID: 'anthropic', modelID: 'claude-opus-4', variant: 'high' },
  codexFastMode: false,
  customProviderId: null
}

const DRAFT: PrdFlowDraft = {
  ticketId: 'ticket-draft',
  projectId: 'proj-1',
  name: 'code mode',
  prompt: 'Build a code mode',
  research: false,
  clarify: true,
  launch: OPUS,
  createdAt: 1_000,
  updatedAt: 2_000
}

const initialPrdFlowState = usePrdFlowStore.getState()
const initialSettingsState = useSettingsStore.getState()

const dialog = (): HTMLElement => screen.getByTestId('prd-flow-dialog')
const nameInput = (): HTMLInputElement =>
  screen.getByTestId('prd-flow-name-input') as HTMLInputElement
const promptInput = (): HTMLTextAreaElement =>
  screen.getByTestId('prd-flow-prompt-input') as HTMLTextAreaElement
const startButton = (): HTMLButtonElement =>
  screen.getByTestId('prd-flow-start-btn') as HTMLButtonElement
const saveButton = (): HTMLButtonElement =>
  screen.getByTestId('prd-flow-save-btn') as HTMLButtonElement
const research = (): HTMLElement => screen.getByTestId('prd-flow-research-checkbox')
const clarify = (): HTMLElement => screen.getByTestId('prd-flow-clarify-checkbox')
const errorLine = (): string | null => screen.queryByTestId('prd-flow-error')?.textContent ?? null

/** Mounts the dialog as AppLayout does, and opens a new form. */
async function openForm(): Promise<void> {
  render(<PrdFlowDialog />)
  await act(async () => {
    usePrdFlowStore.getState().openDialog('proj-1')
  })
}

/** Mounts the dialog and opens it on the saved draft, as its card does. */
async function openDraft(draft: PrdFlowDraft = DRAFT): Promise<void> {
  usePrdFlowStore.getState().putDraft(draft)
  render(<PrdFlowDialog />)
  await act(async () => {
    usePrdFlowStore.getState().openDialog(draft.projectId, draft.ticketId)
  })
}

function fill(name: string, prompt: string): void {
  fireEvent.change(nameInput(), { target: { value: name } })
  fireEvent.change(promptInput(), { target: { value: prompt } })
}

async function press(action: () => void): Promise<void> {
  await act(async () => {
    action()
  })
}

beforeEach(() => {
  start.startPrdFlow.mockResolvedValue({ ok: true, ticketId: 'ticket-1' })
  draftLib.savePrdFlowDraft.mockResolvedValue({ ok: true, ticketId: 'ticket-1' })
  where.resolvePrdFlowTarget.mockResolvedValue(MAIN_CHECKOUT)
  where.findExistingPrdFlowFiles.mockResolvedValue([])
  useSettingsStore.setState({
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    customProviders: []
  } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  usePrdFlowStore.setState(initialPrdFlowState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('"Save for later" in a new form', () => {
  it('is off until the ticket has a name, and needs no prompt', async () => {
    await openForm()
    expect(saveButton()).toHaveTextContent(/^Save for later/)
    expect(saveButton()).toBeDisabled()

    fireEvent.change(promptInput(), { target: { value: 'Build a code mode' } })
    expect(saveButton()).toBeDisabled()

    fireEvent.change(nameInput(), { target: { value: 'code mode' } })
    fireEvent.change(promptInput(), { target: { value: '' } })
    expect(saveButton()).toBeEnabled()
    // "Start" still wants the prompt
    expect(startButton()).toBeDisabled()
  })

  it('stays off for a name with no letter or digit', async () => {
    await openForm()

    fill(' -> ', 'Build a code mode')

    expect(saveButton()).toBeDisabled()
  })

  it('stays off in a project the flow cannot run in', async () => {
    where.resolvePrdFlowTarget.mockResolvedValue({
      ok: false,
      error: 'This project has no main checkout to run in.'
    })
    await openForm()

    fill('code mode', 'Build a code mode')

    expect(saveButton()).toBeDisabled()
  })

  it('hands the answers to savePrdFlowDraft, starts nothing, and closes', async () => {
    usePrdFlowStore.setState({ launchPref: OPUS })
    await openForm()
    fill('  code mode ', ' Build a code mode ')
    fireEvent.click(clarify())

    await press(() => fireEvent.click(saveButton()))

    expect(draftLib.savePrdFlowDraft).toHaveBeenCalledExactlyOnceWith({
      projectId: 'proj-1',
      name: 'code mode',
      prompt: 'Build a code mode',
      research: true,
      clarify: false,
      launch: OPUS,
      ticketId: undefined
    })
    expect(start.startPrdFlow).not.toHaveBeenCalled()
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
    expect(screen.queryByTestId('prd-flow-dialog')).toBeNull()
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      'PRD draft saved: “code mode”. It waits in To Do until you launch it.'
    )
  })

  it('saves on Cmd+Shift+Enter, and starts on Cmd+Enter alone', async () => {
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() =>
      fireEvent.keyDown(promptInput(), { key: 'Enter', metaKey: true, shiftKey: true })
    )

    expect(draftLib.savePrdFlowDraft).toHaveBeenCalledTimes(1)
    expect(start.startPrdFlow).not.toHaveBeenCalled()
  })

  it('is not kept off by a document that is already there: only "Start" is', async () => {
    vi.useFakeTimers()
    where.findExistingPrdFlowFiles.mockResolvedValue(['/repo/main/CODE_MODE_PRD.html'])
    await openForm()
    fill('code mode', 'Build a code mode')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS)
    })

    expect(startButton()).toBeDisabled()
    expect(saveButton()).toBeEnabled()
  })

  it('shows why a save was refused, and stays open with what was typed', async () => {
    draftLib.savePrdFlowDraft.mockResolvedValue({
      ok: false,
      error: 'The ticket could not be created.'
    })
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.click(saveButton()))

    expect(errorLine()).toBe('The ticket could not be created.')
    expect(usePrdFlowStore.getState().dialog.open).toBe(true)
    expect(nameInput().value).toBe('code mode')
    expect(dialog()).not.toHaveAttribute('data-starting')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('cannot be closed, or sent twice, while the save is in flight', async () => {
    let finish!: (value: { ok: true; ticketId: string }) => void
    draftLib.savePrdFlowDraft.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.click(saveButton()))
    expect(saveButton()).toHaveTextContent(/^Saving…/)
    expect(saveButton()).toBeDisabled()
    expect(startButton()).toBeDisabled()
    expect(startButton()).toHaveTextContent(/^Start/)
    expect(dialog()).toHaveAttribute('data-starting')
    await press(() => fireEvent.keyDown(dialog(), { key: 'Escape' }))
    expect(usePrdFlowStore.getState().dialog.open).toBe(true)

    await press(() => finish({ ok: true, ticketId: 'ticket-1' }))
    expect(draftLib.savePrdFlowDraft).toHaveBeenCalledTimes(1)
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
  })
})

describe('the form opened on a saved draft', () => {
  it('says it edits a draft, and starts from what was saved', async () => {
    // The model chosen last elsewhere is not the draft's
    usePrdFlowStore.setState({ launchPref: null })
    await openDraft()

    expect(screen.getByRole('dialog', { name: 'Edit PRD draft' })).toBe(dialog())
    expect(dialog()).toHaveAttribute('data-draft', 'ticket-draft')
    expect(nameInput().value).toBe('code mode')
    expect(promptInput().value).toBe('Build a code mode')
    expect(research()).toHaveAttribute('aria-checked', 'false')
    expect(clarify()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('prd-flow-launch-sdk-claude-code-cli')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(saveButton()).toHaveTextContent(/^Save(?! for later)/)
    expect(startButton()).toBeEnabled()
  })

  it('saves the changes on the ticket of the draft', async () => {
    await openDraft()
    fireEvent.change(promptInput(), { target: { value: 'Build it properly' } })
    fireEvent.click(research())

    await press(() => fireEvent.click(saveButton()))

    expect(draftLib.savePrdFlowDraft).toHaveBeenCalledExactlyOnceWith({
      projectId: 'proj-1',
      name: 'code mode',
      prompt: 'Build it properly',
      research: true,
      clarify: true,
      launch: OPUS,
      ticketId: 'ticket-draft'
    })
    expect(start.startPrdFlow).not.toHaveBeenCalled()
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
  })

  it('starts the flow on the ticket of the draft, with what the form says now', async () => {
    await openDraft()
    fireEvent.change(nameInput(), { target: { value: 'code mode v2' } })

    await press(() => fireEvent.click(startButton()))

    expect(start.startPrdFlow).toHaveBeenCalledExactlyOnceWith({
      projectId: 'proj-1',
      name: 'code mode v2',
      prompt: 'Build a code mode',
      research: false,
      clarify: true,
      launch: OPUS,
      ticketId: 'ticket-draft'
    })
    expect(draftLib.savePrdFlowDraft).not.toHaveBeenCalled()
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('PRD flow started: “code mode v2”')
  })

  it('keeps "Start" off for a draft whose prompt is not written yet', async () => {
    await openDraft({ ...DRAFT, prompt: '' })

    expect(startButton()).toBeDisabled()
    expect(saveButton()).toBeEnabled()

    fireEvent.change(promptInput(), { target: { value: 'Build a code mode' } })
    expect(startButton()).toBeEnabled()
  })

  it('is a new form again the next time it opens without a draft', async () => {
    await openDraft()
    await press(() => fireEvent.click(screen.getByTestId('prd-flow-cancel-btn')))

    await act(async () => {
      usePrdFlowStore.getState().openDialog('proj-1')
    })

    expect(screen.getByRole('dialog', { name: 'New PRD → orchestrator ticket' })).toBe(dialog())
    expect(dialog()).not.toHaveAttribute('data-draft')
    expect(nameInput().value).toBe('')
    expect(promptInput().value).toBe('')
    expect(research()).toHaveAttribute('aria-checked', 'true')
    expect(saveButton()).toHaveTextContent(/^Save for later/)
  })

  it('opens as a new form when the draft it was opened for is gone', async () => {
    render(<PrdFlowDialog />)
    await act(async () => {
      usePrdFlowStore.getState().openDialog('proj-1', 'ticket-gone')
    })

    expect(screen.getByRole('dialog', { name: 'New PRD → orchestrator ticket' })).toBe(dialog())
    expect(nameInput().value).toBe('')
  })
})
