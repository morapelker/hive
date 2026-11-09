import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '@/lib/toast'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { DEFAULT_MANUAL_STEPS_PROMPT, NO_DOCUMENT_PATH_TEXT } from '@shared/document-flow/prompts'
import type { DocumentRun } from '@shared/types/document-flow'
import { ExecuteManualStepsDialog } from './ExecuteManualStepsDialog'
import { makeRun } from './test-fixtures'

const manualSteps = vi.hoisted(() => ({ launchManualStepsSession: vi.fn() }))
const listModels = vi.hoisted(() => vi.fn())

// Launching the session has its own tests; here only the dialog in front of it.
vi.mock('@/lib/document-flow/manual-steps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-flow/manual-steps')>()),
  launchManualStepsSession: manualSteps.launchManualStepsSession
}))
vi.mock('@/api/opencode-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/opencode-api')>()
  return { ...actual, opencodeApi: { ...actual.opencodeApi, listModels } }
})
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

const STEPS = ['Set STRIPE_KEY', 'Rotate the webhook']
const FILLED_DEFAULT = DEFAULT_MANUAL_STEPS_PROMPT.replace('{doc_path}', '/docs/plan.html').replace(
  '{manual_steps}',
  '- Set STRIPE_KEY\n- Rotate the webhook'
)
const INTEGRATION_WORKTREE = {
  id: 'wt-integration',
  is_default: false,
  branch_name: 'doc-checkout'
}
const ROOT_WORKTREE = { id: 'wt-root', is_default: true, branch_name: 'main' }

const finishedRun = (overrides: Partial<DocumentRun> = {}): DocumentRun =>
  makeRun({
    status: 'completed',
    source_path: '/docs/plan.html',
    base_branch: 'main',
    integration_branch: 'doc-checkout',
    integration_worktree_id: 'wt-integration',
    ...overrides
  })

const initialSettings = useSettingsStore.getState()
const initialWorktrees = useWorktreeStore.getState()
const initialConnections = useConnectionStore.getState()

const updateSetting = vi.fn()
const onOpenChange = vi.fn()
const onLaunched = vi.fn()

function seedWorktrees(worktrees: unknown[]): void {
  useWorktreeStore.setState({
    worktreesByProject: new Map([['project-1', worktrees]]) as never,
    loadedProjectIds: new Set(['project-1']),
    loadWorktrees: vi.fn(async () => undefined)
  })
}

async function open(run: DocumentRun = finishedRun()): Promise<void> {
  await act(async () => {
    render(
      <ExecuteManualStepsDialog
        run={run}
        manualSteps={STEPS}
        open={true}
        onOpenChange={onOpenChange}
        onLaunched={onLaunched}
      />
    )
  })
}

const click = async (testId: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

const type = async (text: string): Promise<void> => {
  await act(async () => {
    fireEvent.change(screen.getByTestId('docflow-manual-steps-prompt'), {
      target: { value: text }
    })
  })
}

const promptValue = (): string =>
  (screen.getByTestId('docflow-manual-steps-prompt') as HTMLTextAreaElement).value

const lastLaunch = (): { target: { kind: string }; prompt: string; config: { sdk: string } } => {
  const [target, , prompt, config] = manualSteps.launchManualStepsSession.mock.calls[0]
  return { target, prompt, config }
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  listModels.mockResolvedValue({ success: true, providers: [] })
  manualSteps.launchManualStepsSession.mockResolvedValue('session-1')
  updateSetting.mockImplementation(async (key: string, value: unknown) => {
    useSettingsStore.setState({ [key]: value } as never)
  })
  useSettingsStore.setState({
    defaultAgentSdk: 'claude-code-cli',
    availableAgentSdks: { opencode: true, claude: true, codex: true },
    selectedModel: null,
    selectedModelByProvider: {},
    defaultModels: null,
    customProviders: [],
    manualStepsPromptTemplate: null,
    updateSetting: updateSetting as never
  })
  seedWorktrees([INTEGRATION_WORKTREE, ROOT_WORKTREE])
})

afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.resetAllMocks()
  useSettingsStore.setState(initialSettings, true)
  useWorktreeStore.setState(initialWorktrees, true)
  useConnectionStore.setState(initialConnections, true)
})

describe('ExecuteManualStepsDialog — the prompt', () => {
  it('starts from the built-in prompt, placeholders unfilled', async () => {
    await open()
    expect(promptValue()).toBe(DEFAULT_MANUAL_STEPS_PROMPT)
  })

  it('starts from the prompt the user kept', async () => {
    useSettingsStore.setState({ manualStepsPromptTemplate: 'my own {manual_steps}' })
    await open()
    expect(promptValue()).toBe('my own {manual_steps}')
  })

  it('shows both placeholders as included in the built-in prompt', async () => {
    await open()
    expect(screen.getByTestId('docflow-manual-steps-placeholder-doc_path')).toHaveTextContent(
      '{doc_path}included'
    )
    expect(screen.getByTestId('docflow-manual-steps-placeholder-manual_steps')).toHaveTextContent(
      '{manual_steps}included'
    )
  })

  it('names the placeholder that is missing as the prompt is edited, in red', async () => {
    await open()
    await type('no document here: {manual_steps}')

    const docPath = screen.getByTestId('docflow-manual-steps-placeholder-doc_path')
    expect(docPath).toHaveTextContent('{doc_path}missing')
    expect(docPath.className).toContain('text-red-500')
    const steps = screen.getByTestId('docflow-manual-steps-placeholder-manual_steps')
    expect(steps).toHaveTextContent('{manual_steps}included')
    expect(steps.className).toContain('text-emerald-500')
  })

  it('still launches a prompt with no placeholders', async () => {
    await open()
    await type('just do them')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-no')
    expect(lastLaunch().prompt).toBe('just do them')
  })

  it('will not launch an empty prompt', async () => {
    await open()
    await type('   \n ')
    expect(screen.getByTestId('docflow-manual-steps-launch')).toBeDisabled()
  })

  it('resets to the built-in prompt', async () => {
    useSettingsStore.setState({ manualStepsPromptTemplate: 'my own' })
    await open()
    await click('docflow-manual-steps-reset')
    expect(promptValue()).toBe(DEFAULT_MANUAL_STEPS_PROMPT)
    expect(screen.queryByTestId('docflow-manual-steps-reset')).toBeNull()
  })

  it('says what {doc_path} becomes on a run made from board tickets', async () => {
    await open(finishedRun({ source_kind: 'tickets', source_path: '' }))
    expect(screen.getByTestId('docflow-manual-steps-no-document')).toHaveTextContent(
      NO_DOCUMENT_PATH_TEXT
    )
    await click('docflow-manual-steps-launch')
    expect(lastLaunch().prompt).toContain(NO_DOCUMENT_PATH_TEXT)
  })

  it('stops saying so once the prompt no longer asks for the document', async () => {
    await open(finishedRun({ source_kind: 'tickets', source_path: '' }))
    await type('{manual_steps}')
    expect(screen.queryByTestId('docflow-manual-steps-no-document')).toBeNull()
  })
})

describe('ExecuteManualStepsDialog — keeping an edit', () => {
  it('launches an unchanged prompt without asking', async () => {
    await open()
    await click('docflow-manual-steps-launch')

    expect(screen.queryByTestId('docflow-manual-steps-keep-dialog')).toBeNull()
    expect(updateSetting).not.toHaveBeenCalled()
    expect(lastLaunch().prompt).toBe(FILLED_DEFAULT)
  })

  it('does not ask when an edit was undone', async () => {
    await open()
    await type('something else')
    await type(DEFAULT_MANUAL_STEPS_PROMPT)
    await click('docflow-manual-steps-launch')

    expect(screen.queryByTestId('docflow-manual-steps-keep-dialog')).toBeNull()
    expect(manualSteps.launchManualStepsSession).toHaveBeenCalledTimes(1)
  })

  it('asks before launching a changed prompt, and launches nothing yet', async () => {
    await open()
    await type('changed {manual_steps}')
    await click('docflow-manual-steps-launch')

    expect(screen.getByTestId('docflow-manual-steps-keep-dialog')).toBeInTheDocument()
    expect(manualSteps.launchManualStepsSession).not.toHaveBeenCalled()
  })

  it('keeps the edit and launches it', async () => {
    await open()
    await type('changed {manual_steps}')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-yes')

    expect(updateSetting).toHaveBeenCalledWith(
      'manualStepsPromptTemplate',
      'changed {manual_steps}'
    )
    expect(lastLaunch().prompt).toBe('changed - Set STRIPE_KEY\n- Rotate the webhook')
  })

  it('launches the edit once without keeping it', async () => {
    await open()
    await type('changed {manual_steps}')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-no')

    expect(updateSetting).not.toHaveBeenCalled()
    expect(lastLaunch().prompt).toBe('changed - Set STRIPE_KEY\n- Rotate the webhook')
  })

  it('goes back to editing, with the edit and nothing launched', async () => {
    await open()
    await type('changed')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-cancel')

    expect(screen.queryByTestId('docflow-manual-steps-keep-dialog')).toBeNull()
    expect(manualSteps.launchManualStepsSession).not.toHaveBeenCalled()
    expect(updateSetting).not.toHaveBeenCalled()
    expect(promptValue()).toBe('changed')
    // Radix has no trigger to return to: the body would be outside every dialog.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('docflow-manual-steps-prompt'))
    )
  })

  it('opts both dialogs out of the Tab shortcut of the session behind them', async () => {
    await open()
    await type('changed')
    await click('docflow-manual-steps-launch')

    expect(screen.getByTestId('docflow-manual-steps-dialog')).toHaveAttribute('data-docflow-dialog')
    expect(screen.getByTestId('docflow-manual-steps-keep-dialog')).toHaveAttribute(
      'data-docflow-dialog'
    )
  })

  it('stores nothing when the prompt kept is the built-in one', async () => {
    useSettingsStore.setState({ manualStepsPromptTemplate: 'my own' })
    await open()
    await click('docflow-manual-steps-reset')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-yes')

    expect(updateSetting).toHaveBeenCalledWith('manualStepsPromptTemplate', null)
  })

  it('compares against the kept prompt, not the built-in one', async () => {
    useSettingsStore.setState({ manualStepsPromptTemplate: 'my own {manual_steps}' })
    await open()
    await click('docflow-manual-steps-launch')

    expect(screen.queryByTestId('docflow-manual-steps-keep-dialog')).toBeNull()
    expect(lastLaunch().prompt).toBe('my own - Set STRIPE_KEY\n- Rotate the webhook')
  })
})

describe('ExecuteManualStepsDialog — where it runs', () => {
  it('runs on the run’s branch by default', async () => {
    await open()

    expect(screen.getByTestId('docflow-manual-steps-target-integration')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('docflow-manual-steps-target-integration')).toHaveTextContent(
      'doc-checkout'
    )
    await click('docflow-manual-steps-launch')
    expect(lastLaunch().target.kind).toBe('integration')
  })

  it('can run on the no-worktree path instead', async () => {
    await open()
    expect(screen.getByTestId('docflow-manual-steps-target-no-worktree')).toHaveTextContent('main')

    await click('docflow-manual-steps-target-no-worktree')
    expect(screen.getByTestId('docflow-manual-steps-target-no-worktree')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await click('docflow-manual-steps-launch')
    expect(lastLaunch().target).toMatchObject({
      kind: 'no-worktree',
      checkout: { kind: 'worktree', worktreeId: 'wt-root' }
    })
  })

  it('falls back to the no-worktree path and says why when the branch’s worktree is archived', async () => {
    seedWorktrees([ROOT_WORKTREE])
    await open()

    expect(screen.getByTestId('docflow-manual-steps-target-integration')).toBeDisabled()
    expect(screen.getByTestId('docflow-manual-steps-refusal-integration')).toHaveTextContent(
      'The worktree of doc-checkout was archived.'
    )
    await click('docflow-manual-steps-launch')
    expect(lastLaunch().target.kind).toBe('no-worktree')
  })

  it('cannot launch when no target is left', async () => {
    seedWorktrees([])
    await open()
    expect(screen.getByTestId('docflow-manual-steps-launch')).toBeDisabled()
  })

  it('loads the worktrees of a project that was never loaded, and offers the path once it has', async () => {
    const loadWorktrees = vi.fn(async () => undefined)
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      loadedProjectIds: new Set(),
      loadWorktrees
    })
    await open()

    expect(loadWorktrees).toHaveBeenCalledWith('project-1')
    expect(screen.getByTestId('docflow-manual-steps-target-no-worktree')).toBeDisabled()

    await act(async () => {
      seedWorktrees([INTEGRATION_WORKTREE, ROOT_WORKTREE])
    })
    expect(screen.getByTestId('docflow-manual-steps-target-no-worktree')).toBeEnabled()
  })

  it('offers the integration and base instances of a connection run', async () => {
    useConnectionStore.setState({
      loaded: true,
      loadConnections: vi.fn(async () => undefined),
      connections: [
        { id: 'conn-integration', status: 'active', path: '/c/int', members: [] },
        {
          id: 'conn-base',
          status: 'active',
          path: '/c/base',
          saved_project_id: 'project-1',
          is_base: 1,
          members: [{ worktree_branch: 'main' }]
        }
      ] as never
    })
    await open(
      finishedRun({
        integration_worktree_id: null,
        integration_connection_id: 'conn-integration',
        members: [{ project_id: 'web' }] as never
      })
    )
    await click('docflow-manual-steps-target-no-worktree')
    await click('docflow-manual-steps-launch')

    expect(lastLaunch().target).toMatchObject({
      kind: 'no-worktree',
      checkout: { kind: 'connection', connectionId: 'conn-base', path: '/c/base' }
    })
  })
})

describe('ExecuteManualStepsDialog — the agent', () => {
  it('defaults to the app’s default agent', async () => {
    await open()
    expect(screen.getByTestId('docflow-manual-steps-agent-sdk-claude-code-cli')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await click('docflow-manual-steps-launch')
    expect(lastLaunch().config.sdk).toBe('claude-code-cli')
  })

  it('launches on the agent picked, naming its question tool', async () => {
    await open()
    await click('docflow-manual-steps-agent-sdk-codex')
    await click('docflow-manual-steps-launch')

    expect(lastLaunch().config.sdk).toBe('codex')
    expect(lastLaunch().prompt).toContain('ask me using the request_user_input tool')
  })

  it('goes back to the app default when the choice is cleared', async () => {
    await open()
    await click('docflow-manual-steps-agent-sdk-codex')
    await click('docflow-manual-steps-agent-clear')
    await click('docflow-manual-steps-launch')

    expect(lastLaunch().config.sdk).toBe('claude-code-cli')
  })
})

describe('ExecuteManualStepsDialog — launching', () => {
  it('closes, and hands the session to the dashboard for its way to it', async () => {
    await open()
    await click('docflow-manual-steps-launch')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(toast.success).toHaveBeenCalledWith('Executing the manual steps on doc-checkout')
    expect(onLaunched).toHaveBeenCalledWith({
      sessionId: 'session-1',
      checkout: { kind: 'worktree', worktreeId: 'wt-integration' }
    })
  })

  it('says nothing of a session when the launch fails', async () => {
    manualSteps.launchManualStepsSession.mockRejectedValue(new Error('nope'))
    await open()
    await click('docflow-manual-steps-launch')

    expect(onLaunched).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('stays open with the prompt when the launch fails', async () => {
    manualSteps.launchManualStepsSession.mockRejectedValue(new Error('Could not send prompt'))
    await open()
    await type('changed')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-no')

    expect(toast.error).toHaveBeenCalledWith(
      'Could not execute the manual steps: Could not send prompt'
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(promptValue()).toBe('changed')
    expect(screen.getByTestId('docflow-manual-steps-launch')).toBeEnabled()
  })

  it('keeps the edit even when the launch then fails, so it is not asked about twice', async () => {
    manualSteps.launchManualStepsSession.mockRejectedValue(new Error('nope'))
    await open()
    await type('changed')
    await click('docflow-manual-steps-launch')
    await click('docflow-manual-steps-keep-yes')

    expect(useSettingsStore.getState().manualStepsPromptTemplate).toBe('changed')
    await click('docflow-manual-steps-launch')
    expect(screen.queryByTestId('docflow-manual-steps-keep-dialog')).toBeNull()
    expect(manualSteps.launchManualStepsSession).toHaveBeenCalledTimes(2)
  })

  it('launches once however often the button is pressed, and cannot be dismissed meanwhile', async () => {
    let finish: (id: string) => void = () => undefined
    manualSteps.launchManualStepsSession.mockImplementation(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    await open()
    await click('docflow-manual-steps-launch')

    expect(screen.getByTestId('docflow-manual-steps-launch')).toBeDisabled()
    expect(screen.getByTestId('docflow-manual-steps-cancel')).toBeDisabled()
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(manualSteps.launchManualStepsSession).toHaveBeenCalledTimes(1)

    await act(async () => finish('session-1'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
