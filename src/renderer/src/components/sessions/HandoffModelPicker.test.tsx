import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HandoffSplitButton } from './HandoffSplitButton'
import { clearHandoffModelCatalogCache } from '@/lib/handoffSelection'
import {
  isHandoffPickerOpenForSession,
  resetHandoffPickerState
} from '@/lib/handoff-ui-state'
import { useSettingsStore } from '@/stores/useSettingsStore'

const opencodeApiMocks = vi.hoisted(() => ({
  listModels: vi.fn().mockResolvedValue({ success: true, value: { success: true, providers: [] } })
}))

vi.mock('@/api/opencode-api', () => ({
  opencodeApi: opencodeApiMocks
}))

const initialSettingsState = useSettingsStore.getState()

describe('HandoffModelPicker inside a modal dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHandoffModelCatalogCache()
    opencodeApiMocks.listModels.mockResolvedValue({
      success: true,
      value: { success: true, providers: [] }
    })
    useSettingsStore.setState({
      availableAgentSdks: { opencode: true, claude: true, codex: true },
      defaultAgentSdk: 'claude-code-cli',
      lastHandoffOverride: null,
      selectedModel: null,
      selectedModelByProvider: {},
      defaultModels: null
    })
  })

  afterEach(() => {
    cleanup()
    clearHandoffModelCatalogCache()
    resetHandoffPickerState()
    useSettingsStore.setState(initialSettingsState, true)
  })

  function renderInDialog(): { onDialogOpenChange: ReturnType<typeof vi.fn> } {
    const onDialogOpenChange = vi.fn()

    render(
      <Dialog open onOpenChange={onDialogOpenChange}>
        <DialogContent data-testid="host-dialog">
          <DialogHeader>
            <DialogTitle>Ticket</DialogTitle>
          </DialogHeader>
          <HandoffSplitButton worktreeId="worktree-1" onHandoff={vi.fn()} testIdPrefix="plan-review" />
        </DialogContent>
      </Dialog>
    )

    return { onDialogOpenChange }
  }

  it('keeps the host dialog open while interacting with the picker popover', async () => {
    // The ticket modal hosts this picker; the popover portals outside the
    // dialog's DOM, so it must be modal — otherwise every click inside it
    // registers as a pointer-down-outside on the dialog and closes the ticket.
    const { onDialogOpenChange } = renderInDialog()
    const user = userEvent.setup()

    await user.click(screen.getByTestId('plan-review-handoff-chevron'))
    const sdkTrigger = await screen.findByRole('button', { name: 'Select handoff SDK' })

    await user.click(sdkTrigger)
    const codexItem = await screen.findByRole('menuitem', { name: 'Codex' })

    await user.click(codexItem)

    expect(onDialogOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId('host-dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select handoff SDK' })).toHaveTextContent('Codex')
  })

  it('registers the session-scoped picker-open guard while the popover is open', async () => {
    render(
      <HandoffSplitButton
        worktreeId="worktree-1"
        sessionId="session-1"
        onHandoff={vi.fn()}
        testIdPrefix="plan-review"
      />
    )
    const user = userEvent.setup()

    expect(isHandoffPickerOpenForSession('session-1')).toBe(false)

    await user.click(screen.getByTestId('plan-review-handoff-chevron'))
    await screen.findByRole('button', { name: 'Select handoff SDK' })
    expect(isHandoffPickerOpenForSession('session-1')).toBe(true)
    expect(isHandoffPickerOpenForSession('other-session')).toBe(false)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(isHandoffPickerOpenForSession('session-1')).toBe(false))
  })

  it('applies picker changes to the effective selection live, without pressing Handoff', async () => {
    // Changing SDK/model/effort must take effect immediately: the user can
    // close the picker and fire the main handoff button (or right-click goal
    // mode) expecting the selection they just made — e.g. switch to xhigh,
    // then send an xhigh goal prompt from the main button.
    opencodeApiMocks.listModels.mockResolvedValue({
      success: true,
      value: {
        success: true,
        providers: [
          {
            id: 'codex',
            name: 'Codex',
            models: {
              'gpt-x': { id: 'gpt-x', name: 'GPT X', variants: { low: {}, xhigh: {} } }
            }
          }
        ]
      }
    })
    render(
      <HandoffSplitButton
        worktreeId="worktree-1"
        sessionId="session-1"
        onHandoff={vi.fn()}
        testIdPrefix="plan-review"
      />
    )
    const user = userEvent.setup()

    await user.click(screen.getByTestId('plan-review-handoff-chevron'))
    await user.click(await screen.findByRole('button', { name: 'Select handoff SDK' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Codex' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select handoff model' })).toHaveTextContent(
        'GPT X'
      )
    )

    await user.click(screen.getByRole('button', { name: 'xhigh' }))

    // Close WITHOUT confirming — the selection must stick.
    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(useSettingsStore.getState().lastHandoffOverride).toEqual({
        agentSdk: 'codex',
        providerID: 'codex',
        modelID: 'gpt-x',
        variant: 'xhigh'
      })
    )
    const mainButton = screen.getByTestId('plan-review-handoff-btn')
    expect(mainButton).toHaveTextContent('Codex')
    expect(mainButton).toHaveTextContent('GPT X')
    expect(mainButton).toHaveTextContent('xhigh')
  })

  it('closes the picker instead of stranding it when the anchor collapses to zero size', async () => {
    render(
      <HandoffSplitButton
        worktreeId="worktree-1"
        sessionId="session-1"
        onHandoff={vi.fn()}
        testIdPrefix="plan-review"
      />
    )
    const user = userEvent.setup()

    const chevron = screen.getByTestId('plan-review-handoff-chevron')
    // The chevron's parent is the split button's root container (the watcher's ref target).
    const container = chevron.parentElement as HTMLElement
    // jsdom has no layout; feed the watcher a real size first, then a collapse.
    let collapsed = false
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          width: collapsed ? 0 : 200,
          height: collapsed ? 0 : 32,
          top: 0,
          left: 0,
          right: collapsed ? 0 : 200,
          bottom: collapsed ? 0 : 32,
          toJSON: () => ({})
        }) as DOMRect
    )

    await user.click(chevron)
    await screen.findByRole('button', { name: 'Select handoff SDK' })

    collapsed = true
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Select handoff SDK' })).toBeNull()
    )
    expect(isHandoffPickerOpenForSession('session-1')).toBe(false)
  })
})
