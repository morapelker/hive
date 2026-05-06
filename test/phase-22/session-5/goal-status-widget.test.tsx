import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'

import { GoalStatusWidget } from '@/components/sessions/GoalStatusWidget'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { CodexThreadGoal } from '@/stores/useSessionStore'

const originalState = useSettingsStore.getState()

function makeGoal(overrides: Partial<CodexThreadGoal> = {}): CodexThreadGoal {
  return {
    threadId: 'thread-1',
    objective: 'Add mul 161 to main',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 47_957,
    timeUsedSeconds: 80,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('GoalStatusWidget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-02T10:00:00.000Z'))
    act(() => {
      useSettingsStore.setState({
        ...originalState,
        goalStatusCollapsed: false
      })
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    act(() => {
      useSettingsStore.setState(originalState)
    })
  })

  it('shows active unbudgeted goal usage as elapsed time with token details', () => {
    render(<GoalStatusWidget goal={makeGoal()} topOffsetPx={16} />)

    expect(screen.getByText('Goal')).toBeInTheDocument()
    expect(screen.getByText('Pursuing goal (1m)')).toBeInTheDocument()
    expect(screen.getByText('Add mul 161 to main')).toBeInTheDocument()
    expect(screen.getByText('48K')).toBeInTheDocument()
    expect(screen.getByText('1m')).toBeInTheDocument()
  })

  it('shows active budgeted goal usage as tokens over budget', () => {
    render(
      <GoalStatusWidget
        goal={makeGoal({ tokenBudget: 50_000, tokensUsed: 47_957 })}
        topOffsetPx={16}
      />
    )

    expect(screen.getByText('Pursuing goal (48K / 50K)')).toBeInTheDocument()
    expect(screen.getByText('48K / 50K')).toBeInTheDocument()
  })

  it('shows complete status with final elapsed time', () => {
    render(
      <GoalStatusWidget
        goal={makeGoal({ status: 'complete', timeUsedSeconds: 104 })}
        topOffsetPx={16}
      />
    )

    expect(screen.getByText('Goal achieved (1m 44s)')).toBeInTheDocument()
  })

  it('uses the goalStatusCollapsed setting for collapse and expand actions', () => {
    const updateSetting = vi.fn()
    act(() => {
      useSettingsStore.setState({ goalStatusCollapsed: true, updateSetting })
    })

    render(<GoalStatusWidget goal={makeGoal()} topOffsetPx={24} />)

    const widget = screen.getByTestId('goal-status-widget')
    expect(widget.style.top).toBe('24px')
    expect(screen.queryByText('Add mul 161 to main')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('goal-status-widget-toggle'))

    expect(updateSetting).toHaveBeenCalledWith('goalStatusCollapsed', false)
  })
})
