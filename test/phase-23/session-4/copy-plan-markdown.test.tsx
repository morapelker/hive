import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// Mock the toast helpers used by SessionView / FAB. The context menu imports
// toast from sonner directly, so we mock that module too.
const toastSuccess = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg)
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  },
  default: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg)
  }
}))

// ToolCallDebugModal has heavy UI dependencies and is not under test here.
vi.mock('../../../src/renderer/src/components/sessions/ToolCallDebugModal', () => ({
  ToolCallDebugModal: () => null
}))

// HandoffSplitButton pulls in settings store + model catalog. We stub it to a
// simple sentinel so we can assert the FAB button ordering and interactions.
vi.mock('../../../src/renderer/src/components/sessions/HandoffSplitButton', () => ({
  HandoffSplitButton: () => <button data-testid="handoff-stub">Handoff</button>
}))

import { ToolCallContextMenu } from '../../../src/renderer/src/components/sessions/ToolCallContextMenu'
import { PlanReadyImplementFab } from '../../../src/renderer/src/components/sessions/PlanReadyImplementFab'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import type { ToolUseInfo } from '../../../src/renderer/src/components/sessions/ToolCard'

function makeToolUse(overrides: Partial<ToolUseInfo> = {}): ToolUseInfo {
  return {
    id: 'tool-use-1',
    name: 'ExitPlanMode',
    input: {},
    status: 'success',
    startTime: 0,
    ...overrides
  }
}

const PLAN_MARKDOWN = '# Plan\n\n- step one\n- step two\n\n```ts\nconst x = 1\n```\n'

// Install a clipboard mock that we can observe between tests.
let writeTextMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeTextMock = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true
  })
  toastSuccess.mockClear()
  toastError.mockClear()
  // Reset the pendingPlans map between tests.
  useSessionStore.setState({ pendingPlans: new Map() })
})

afterEach(() => {
  cleanup()
})

describe('ToolCallContextMenu — Copy plan item', () => {
  test('renders "Copy plan" menu item only for ExitPlanMode tool calls', async () => {
    const toolUse = makeToolUse({ input: { plan: PLAN_MARKDOWN } })
    render(
      <ToolCallContextMenu toolUse={toolUse}>
        <div data-testid="plan-card">plan card</div>
      </ToolCallContextMenu>
    )

    fireEvent.contextMenu(screen.getByTestId('plan-card'))

    await waitFor(() => {
      expect(screen.getByTestId('context-menu-copy-plan')).toBeInTheDocument()
    })
    expect(screen.getByText('Copy plan')).toBeInTheDocument()
    expect(screen.getByText('Copy Details')).toBeInTheDocument()
  })

  test('does NOT render "Copy plan" for non-ExitPlanMode tools', async () => {
    const toolUse = makeToolUse({ name: 'Bash', input: { command: 'ls' } })
    render(
      <ToolCallContextMenu toolUse={toolUse}>
        <div data-testid="bash-card">bash card</div>
      </ToolCallContextMenu>
    )

    fireEvent.contextMenu(screen.getByTestId('bash-card'))

    await waitFor(() => {
      expect(screen.getByText('Copy Details')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('context-menu-copy-plan')).not.toBeInTheDocument()
    expect(screen.queryByText('Copy plan')).not.toBeInTheDocument()
  })

  test('clicking "Copy plan" copies input.plan and fires success toast', async () => {
    const toolUse = makeToolUse({ input: { plan: PLAN_MARKDOWN } })
    render(
      <ToolCallContextMenu toolUse={toolUse}>
        <div data-testid="plan-card">plan card</div>
      </ToolCallContextMenu>
    )

    fireEvent.contextMenu(screen.getByTestId('plan-card'))
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-copy-plan')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('context-menu-copy-plan'))

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1)
    })
    expect(writeTextMock.mock.calls[0][0]).toBe(PLAN_MARKDOWN.trim())
    expect(toastSuccess).toHaveBeenCalledWith('Plan copied to clipboard')
    expect(toastError).not.toHaveBeenCalled()
  })

  test('falls back to pendingPlans store when input.plan is empty', async () => {
    const toolUse = makeToolUse({ id: 'tool-streaming-1', input: {} })

    useSessionStore.getState().setPendingPlan('session-abc', {
      requestId: 'req-1',
      toolUseID: 'tool-streaming-1',
      planContent: PLAN_MARKDOWN
    })

    render(
      <ToolCallContextMenu toolUse={toolUse}>
        <div data-testid="plan-card">plan card</div>
      </ToolCallContextMenu>
    )

    fireEvent.contextMenu(screen.getByTestId('plan-card'))
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-copy-plan')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('context-menu-copy-plan'))

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1)
    })
    expect(writeTextMock.mock.calls[0][0]).toBe(PLAN_MARKDOWN.trim())
    expect(toastSuccess).toHaveBeenCalledWith('Plan copied to clipboard')
  })

  test('shows error toast and skips clipboard when plan is empty from both sources', async () => {
    const toolUse = makeToolUse({ id: 'tool-empty', input: {} })
    // pendingPlans intentionally empty — reset in beforeEach.

    render(
      <ToolCallContextMenu toolUse={toolUse}>
        <div data-testid="plan-card">plan card</div>
      </ToolCallContextMenu>
    )

    fireEvent.contextMenu(screen.getByTestId('plan-card'))
    await waitFor(() => {
      expect(screen.getByTestId('context-menu-copy-plan')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('context-menu-copy-plan'))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('No plan content to copy')
    })
    expect(writeTextMock).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

describe('PlanReadyImplementFab — Copy plan button', () => {
  function renderFab(overrides: Partial<React.ComponentProps<typeof PlanReadyImplementFab>> = {}) {
    const defaults = {
      onImplement: vi.fn(),
      onHandoff: vi.fn(),
      onCopyPlan: vi.fn(),
      visible: true,
      onSaveAsTicket: vi.fn()
    }
    const props = { ...defaults, ...overrides }
    return { ...render(<PlanReadyImplementFab {...props} />), props }
  }

  test('renders Copy plan button with the expected test id when visible', () => {
    renderFab()
    const btn = screen.getByTestId('plan-ready-copy-plan-fab')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAccessibleName('Copy plan markdown')
    expect(btn).toHaveTextContent('Copy plan')
  })

  test('button sits between Save-as-ticket and Handoff in DOM order', () => {
    renderFab()
    const saveBtn = screen.getByTestId('plan-ready-save-ticket-fab')
    const copyBtn = screen.getByTestId('plan-ready-copy-plan-fab')
    const handoffBtn = screen.getByTestId('handoff-stub')

    expect(
      saveBtn.compareDocumentPosition(copyBtn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      copyBtn.compareDocumentPosition(handoffBtn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('clicking invokes the onCopyPlan prop', () => {
    const { props } = renderFab()
    fireEvent.click(screen.getByTestId('plan-ready-copy-plan-fab'))
    expect(props.onCopyPlan).toHaveBeenCalledTimes(1)
  })
})
