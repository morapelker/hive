// "New PRD → orchestrator ticket": the form. What it shows when it opens (both checkmarks on,
// the agent and model chosen last), what keeps "Start" off (a missing name or prompt, a name
// with no letter or digit, a project the flow cannot run in, a document already on disk under
// the name), exactly what "Start" hands to startPrdFlow, and what a refused and an accepted
// start do. Starting a flow and finding where it runs are lib/prd-flow's: both are faked here.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const start = vi.hoisted(() => ({ startPrdFlow: vi.fn() }))
const where = vi.hoisted(() => ({
  resolvePrdFlowTarget: vi.fn(),
  findExistingPrdFlowFiles: vi.fn()
}))
vi.mock('@/lib/prd-flow/start', () => start)
// The lookups are stand-ins; the sentence for a file that is already there is the real one.
vi.mock('@/lib/prd-flow/target', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prd-flow/target')>()),
  ...where
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
// The picker's model list asks the server for this Mac's models: not this form's business.
vi.mock('@/components/sessions/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />
}))
vi.mock('@/components/sessions/CodexFastToggle', () => ({
  CodexFastToggle: () => <div data-testid="codex-fast-toggle" />
}))

import { toast } from '@/lib/toast'
import type { PrdFlowTargetResult } from '@/lib/prd-flow/target'
import { usePrdFlowStore } from '@/stores/usePrdFlowStore'
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

const initialPrdFlowState = usePrdFlowStore.getState()
const initialSettingsState = useSettingsStore.getState()

const nameInput = (): HTMLInputElement =>
  screen.getByTestId('prd-flow-name-input') as HTMLInputElement
const promptInput = (): HTMLTextAreaElement =>
  screen.getByTestId('prd-flow-prompt-input') as HTMLTextAreaElement
const startButton = (): HTMLButtonElement =>
  screen.getByTestId('prd-flow-start-btn') as HTMLButtonElement
const research = (): HTMLElement => screen.getByTestId('prd-flow-research-checkbox')
const clarify = (): HTMLElement => screen.getByTestId('prd-flow-clarify-checkbox')
const filesLine = (): string => screen.getByTestId('prd-flow-files').textContent ?? ''
const errorLine = (): string | null => screen.queryByTestId('prd-flow-error')?.textContent ?? null

/** Mounts the dialog as AppLayout does, and opens it the way every entry point does. */
async function openForm(projectId = 'proj-1'): Promise<void> {
  render(<PrdFlowDialog />)
  await act(async () => {
    usePrdFlowStore.getState().openDialog(projectId)
  })
}

function fill(name: string, prompt: string): void {
  fireEvent.change(nameInput(), { target: { value: name } })
  fireEvent.change(promptInput(), { target: { value: prompt } })
}

/** A click, or a key, and whatever the start it sets off answers. */
async function press(action: () => void): Promise<void> {
  await act(async () => {
    action()
  })
}

beforeEach(() => {
  start.startPrdFlow.mockResolvedValue({ ok: true, ticketId: 'ticket-1' })
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

describe('the form as it opens', () => {
  it('is not drawn until something opens it', () => {
    render(<PrdFlowDialog />)

    expect(screen.queryByTestId('prd-flow-dialog')).toBeNull()
    expect(where.resolvePrdFlowTarget).not.toHaveBeenCalled()
  })

  it('opens empty for the project it was asked for, with both checkmarks on', async () => {
    await openForm('proj-7')

    expect(screen.getByRole('dialog', { name: 'New PRD → orchestrator ticket' })).toBe(
      screen.getByTestId('prd-flow-dialog')
    )
    expect(nameInput().value).toBe('')
    expect(nameInput().placeholder).toBe('What are we building?')
    expect(promptInput().value).toBe('')
    expect(promptInput().placeholder).toBe('Describe what you want to create…')
    expect(promptInput().rows).toBe(8)
    expect(research()).toHaveAttribute('aria-checked', 'true')
    expect(clarify()).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Research with subagents first')).toBeTruthy()
    expect(screen.getByText('Ask me for clarifications')).toBeTruthy()
    expect(where.resolvePrdFlowTarget).toHaveBeenCalledWith('proj-7')
    expect(errorLine()).toBeNull()
  })

  it('starts typing in "Name", and keeps Tab among its own fields', async () => {
    await openForm()

    expect(document.activeElement).toBe(nameInput())
    // Tab must not flip the mode of the session behind the dialog
    expect(screen.getByTestId('prd-flow-dialog')).toHaveAttribute('data-tab-navigates')
  })

  it("offers the app's default agent and model when none was chosen before", async () => {
    await openForm()

    expect(screen.getByText('App default')).toBeTruthy()
    expect(screen.getByTestId('prd-flow-launch-choose')).toBeTruthy()
  })

  it('starts from the agent and model chosen last', async () => {
    usePrdFlowStore.setState({ launchPref: OPUS })
    await openForm()

    expect(screen.getByTestId('prd-flow-launch-sdk-claude-code-cli')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.queryByTestId('prd-flow-launch-choose')).toBeNull()
  })

  it('is a new form every time it opens, whatever was typed and unticked before', async () => {
    await openForm()
    fill('code mode', 'Build a code mode')
    fireEvent.click(research())
    fireEvent.click(clarify())
    expect(research()).toHaveAttribute('aria-checked', 'false')

    await press(() => fireEvent.click(screen.getByTestId('prd-flow-cancel-btn')))
    expect(screen.queryByTestId('prd-flow-dialog')).toBeNull()
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
    expect(start.startPrdFlow).not.toHaveBeenCalled()

    await act(async () => {
      usePrdFlowStore.getState().openDialog('proj-1')
    })
    expect(nameInput().value).toBe('')
    expect(promptInput().value).toBe('')
    expect(research()).toHaveAttribute('aria-checked', 'true')
    expect(clarify()).toHaveAttribute('aria-checked', 'true')
  })
})

describe('the line under "Name"', () => {
  it('names the two files and the directory they are written in', async () => {
    await openForm()
    expect(filesLine()).toBe('The session runs in /repo/main')

    fireEvent.change(nameInput(), { target: { value: 'code mode' } })

    expect(filesLine()).toBe('CODE_MODE_PRD.html, then CODE_MODE_TASKS.html, in /repo/main')
  })

  it('says a name needs a letter or a digit, and keeps "Start" off', async () => {
    await openForm()

    fill(' -> ', 'Build a code mode')

    expect(filesLine()).toBe('The name needs at least one letter or digit.')
    expect(startButton()).toBeDisabled()
  })

  it('says why the flow cannot run in the project, and keeps "Start" off', async () => {
    where.resolvePrdFlowTarget.mockResolvedValue({
      ok: false,
      error: 'This project has no base instance to run in.'
    })
    await openForm()
    expect(filesLine()).toBe('This project has no base instance to run in.')

    fill('code mode', 'Build a code mode')

    expect(filesLine()).toBe('This project has no base instance to run in.')
    expect(startButton()).toBeDisabled()
    await press(() => fireEvent.keyDown(promptInput(), { key: 'Enter', metaKey: true }))
    expect(start.startPrdFlow).not.toHaveBeenCalled()
  })

  it('leaves "Start" to say what is wrong when the directory could not be worked out', async () => {
    where.resolvePrdFlowTarget.mockRejectedValue(new Error('offline'))
    await openForm()

    fill('code mode', 'Build a code mode')

    expect(filesLine()).toBe('CODE_MODE_PRD.html, then CODE_MODE_TASKS.html')
    expect(startButton()).toBeEnabled()
    expect(where.findExistingPrdFlowFiles).not.toHaveBeenCalled()
  })

  it('drops the answer for a project the form is no longer about', async () => {
    let answer: (result: PrdFlowTargetResult) => void = () => {}
    where.resolvePrdFlowTarget.mockReturnValueOnce(
      new Promise<PrdFlowTargetResult>((resolve) => {
        answer = resolve
      })
    )
    await openForm('proj-1')
    await act(async () => {
      usePrdFlowStore.getState().openDialog('proj-2')
    })
    expect(filesLine()).toBe('The session runs in /repo/main')

    await act(async () => {
      answer({ ok: false, error: 'The project was not found.' })
    })

    expect(filesLine()).toBe('The session runs in /repo/main')
  })
})

describe('"Start"', () => {
  it('is off until there is a name and a prompt', async () => {
    await openForm()
    expect(startButton()).toBeDisabled()

    fireEvent.change(nameInput(), { target: { value: 'code mode' } })
    expect(startButton()).toBeDisabled()

    fireEvent.change(promptInput(), { target: { value: '   ' } })
    expect(startButton()).toBeDisabled()

    fireEvent.change(promptInput(), { target: { value: 'Build a code mode' } })
    expect(startButton()).toBeEnabled()

    fireEvent.change(nameInput(), { target: { value: '  ' } })
    expect(startButton()).toBeDisabled()
  })

  it.each([
    { research: true, clarify: true },
    { research: true, clarify: false },
    { research: false, clarify: true },
    { research: false, clarify: false }
  ])(
    'hands startPrdFlow the name, the prompt and the checkmarks (research $research, clarify $clarify)',
    async (ticked) => {
      await openForm()
      fill('  code mode ', '\nBuild a code mode\n\nwith a preview\n')
      if (!ticked.research) fireEvent.click(research())
      if (!ticked.clarify) fireEvent.click(clarify())

      await press(() => fireEvent.click(startButton()))

      expect(start.startPrdFlow).toHaveBeenCalledTimes(1)
      expect(start.startPrdFlow).toHaveBeenCalledWith({
        projectId: 'proj-1',
        name: 'code mode',
        prompt: 'Build a code mode\n\nwith a preview',
        research: ticked.research,
        clarify: ticked.clarify,
        launch: null
      })
    }
  )

  it('hands over the agent and model shown in the picker', async () => {
    usePrdFlowStore.setState({ launchPref: OPUS })
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.click(startButton()))

    expect(start.startPrdFlow).toHaveBeenCalledWith(expect.objectContaining({ launch: OPUS }))
  })

  it('hands over the app default once "Use app default" is pressed', async () => {
    usePrdFlowStore.setState({ launchPref: OPUS })
    await openForm()
    fill('code mode', 'Build a code mode')
    fireEvent.click(screen.getByTestId('prd-flow-launch-clear'))

    await press(() => fireEvent.click(startButton()))

    expect(start.startPrdFlow).toHaveBeenCalledWith(expect.objectContaining({ launch: null }))
    // What is remembered is startPrdFlow's to write, not the picker's
    expect(usePrdFlowStore.getState().launchPref).toEqual(OPUS)
  })

  it('closes the form and says the flow started', async () => {
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.click(startButton()))

    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
    expect(screen.queryByTestId('prd-flow-dialog')).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('PRD flow started: “code mode”')
  })

  it('stays open with the reason when the start is refused', async () => {
    start.startPrdFlow.mockResolvedValue({ ok: false, error: 'The ticket could not be created.' })
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.click(startButton()))

    expect(errorLine()).toBe('The ticket could not be created.')
    expect(screen.getByTestId('prd-flow-error').className).toContain('text-destructive')
    expect(usePrdFlowStore.getState().dialog.open).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
    // Nothing typed is lost, and the person can try again
    expect(nameInput().value).toBe('code mode')
    expect(promptInput().value).toBe('Build a code mode')
    expect(startButton()).toBeEnabled()
    // And the form can be left again: by Esc, the X, and Cmd/Ctrl+W
    expect(screen.getByTestId('prd-flow-dialog')).not.toHaveAttribute('data-starting')

    fireEvent.change(nameInput(), { target: { value: 'code mode 2' } })
    expect(errorLine()).toBeNull()
  })

  it('stays open with the message when the start throws', async () => {
    start.startPrdFlow.mockRejectedValue(new Error('The server did not answer.'))
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.click(startButton()))

    expect(errorLine()).toBe('The server did not answer.')
    expect(usePrdFlowStore.getState().dialog.open).toBe(true)
    expect(startButton()).toBeEnabled()
  })

  it.each([
    ['Cmd+Enter', { metaKey: true }],
    ['Ctrl+Enter', { ctrlKey: true }]
  ])('starts on %s from a field', async (_label, modifier) => {
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.keyDown(promptInput(), { key: 'Enter', ...modifier }))

    expect(start.startPrdFlow).toHaveBeenCalledTimes(1)
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
  })

  it('does not start on a plain Enter, nor on the shortcut while it is off', async () => {
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.keyDown(nameInput(), { key: 'Enter' }))
    expect(start.startPrdFlow).not.toHaveBeenCalled()

    fireEvent.change(promptInput(), { target: { value: '' } })
    await press(() => fireEvent.keyDown(nameInput(), { key: 'Enter', metaKey: true }))
    expect(start.startPrdFlow).not.toHaveBeenCalled()
  })

  it('starts one flow however often it is pressed, and cannot be left meanwhile', async () => {
    let answer: (result: { ok: true; ticketId: string }) => void = () => {}
    start.startPrdFlow.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    await openForm()
    fill('code mode', 'Build a code mode')
    expect(screen.getByTestId('prd-flow-dialog')).not.toHaveAttribute('data-starting')

    await press(() => {
      fireEvent.keyDown(promptInput(), { key: 'Enter', metaKey: true })
      fireEvent.keyDown(promptInput(), { key: 'Enter', metaKey: true })
    })
    await press(() => fireEvent.click(startButton()))

    expect(start.startPrdFlow).toHaveBeenCalledTimes(1)
    expect(startButton()).toBeDisabled()
    expect(startButton().textContent).toContain('Starting…')
    expect(screen.getByTestId('prd-flow-cancel-btn')).toBeDisabled()
    await press(() => fireEvent.keyDown(screen.getByTestId('prd-flow-dialog'), { key: 'Escape' }))
    expect(usePrdFlowStore.getState().dialog.open).toBe(true)
    // What Cmd/Ctrl+W reads (useKeyboardShortcuts) to leave the form alone meanwhile
    expect(screen.getByTestId('prd-flow-dialog')).toHaveAttribute('data-starting')

    await act(async () => {
      answer({ ok: true, ticketId: 'ticket-1' })
    })
    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
  })

  it('leaves on Escape without starting anything', async () => {
    await openForm()
    fill('code mode', 'Build a code mode')

    await press(() => fireEvent.keyDown(screen.getByTestId('prd-flow-dialog'), { key: 'Escape' }))

    expect(usePrdFlowStore.getState().dialog.open).toBe(false)
    expect(start.startPrdFlow).not.toHaveBeenCalled()
  })
})

describe('documents already on disk under the name', () => {
  /** Lets the name rest for `ms`, and whatever was asked then answer. */
  async function rest(ms = PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('are looked for once the name rests, in the directory the session runs in', async () => {
    await openForm()

    fireEvent.change(nameInput(), { target: { value: 'code' } })
    await rest(PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS - 1)
    fireEvent.change(nameInput(), { target: { value: 'code mode' } })
    await rest(PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS - 1)
    expect(where.findExistingPrdFlowFiles).not.toHaveBeenCalled()

    await rest(1)

    expect(where.findExistingPrdFlowFiles).toHaveBeenCalledTimes(1)
    expect(where.findExistingPrdFlowFiles).toHaveBeenCalledWith(
      { checkout: { kind: 'worktree', worktreeId: 'wt-main' }, cwd: '/repo/main', memberDirs: [] },
      'CODE_MODE'
    )
    expect(errorLine()).toBeNull()
  })

  it('block "Start" and say which file is in the way', async () => {
    where.findExistingPrdFlowFiles.mockResolvedValue(['/repo/main/CODE_MODE_PRD.html'])
    await openForm()
    fill('code mode', 'Build a code mode')
    expect(startButton()).toBeEnabled()

    await rest()

    expect(errorLine()).toBe(
      'CODE_MODE_PRD.html already exists in /repo/main. Pick another name, or remove the file.'
    )
    expect(startButton()).toBeDisabled()
    await press(() => fireEvent.keyDown(promptInput(), { key: 'Enter', metaKey: true }))
    expect(start.startPrdFlow).not.toHaveBeenCalled()
  })

  it('name both files when both are there', async () => {
    where.findExistingPrdFlowFiles.mockResolvedValue([
      '/repo/main/CODE_MODE_PRD.html',
      '/repo/main/CODE_MODE_TASKS.html'
    ])
    await openForm()
    fill('code mode', 'Build a code mode')

    await rest()

    expect(errorLine()).toBe(
      'CODE_MODE_PRD.html and CODE_MODE_TASKS.html already exist in /repo/main. Pick another name, or remove the files.'
    )
  })

  it('stop blocking as soon as the name is another one', async () => {
    where.findExistingPrdFlowFiles.mockImplementation(async (_target: unknown, prefix: string) =>
      prefix === 'CODE_MODE' ? ['/repo/main/CODE_MODE_PRD.html'] : []
    )
    await openForm()
    fill('code mode', 'Build a code mode')
    await rest()
    expect(startButton()).toBeDisabled()

    fireEvent.change(nameInput(), { target: { value: 'code mode 2' } })

    expect(errorLine()).toBeNull()
    expect(startButton()).toBeEnabled()
    await rest()
    expect(where.findExistingPrdFlowFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: '/repo/main' }),
      'CODE_MODE_2'
    )
    expect(startButton()).toBeEnabled()
  })

  it('are looked for again when the window comes back, so a removed file frees the name', async () => {
    where.findExistingPrdFlowFiles.mockResolvedValueOnce(['/repo/main/CODE_MODE_PRD.html'])
    await openForm()
    fill('code mode', 'Build a code mode')
    await rest()
    expect(startButton()).toBeDisabled()

    await press(() => fireEvent.focus(window))
    await rest()

    expect(where.findExistingPrdFlowFiles).toHaveBeenCalledTimes(2)
    expect(errorLine()).toBeNull()
    expect(startButton()).toBeEnabled()
  })

  it('block nothing when the look itself fails: "Start" looks again', async () => {
    where.findExistingPrdFlowFiles.mockRejectedValue(new Error('offline'))
    await openForm()
    fill('code mode', 'Build a code mode')

    await rest()

    expect(errorLine()).toBeNull()
    expect(startButton()).toBeEnabled()
  })
})
