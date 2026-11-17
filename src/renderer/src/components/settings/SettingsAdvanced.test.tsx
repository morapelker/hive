// Settings › Advanced (SettingsAdvanced.tsx): the "Live usage in Code Mode sessions" switch.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  CODE_MODE_LIVE_USAGE_DESCRIPTION,
  CODE_MODE_LIVE_USAGE_LABEL,
  SettingsAdvanced
} from './SettingsAdvanced'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/api/perf-diagnostics-api', () => ({
  perfDiagnosticsApi: { enable: vi.fn(), getStatus: vi.fn(async () => null) }
}))
vi.mock('@/api/codex-debug-logger-api', () => ({
  codexDebugLoggerApi: { configure: vi.fn() }
}))

const initialSettings = useSettingsStore.getState()

beforeEach(() => {
  useSettingsStore.setState({ ...initialSettings, environmentVariables: [] }, true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// CODE_MODE_TASKS.html T09: the switch is on by default, flips the setting the main process
// reads, and its description says what the user will see while it is on and what off costs.
describe('Settings › Advanced › Live usage in Code Mode sessions', () => {
  it('is on by default and flips the setting both ways', () => {
    render(<SettingsAdvanced />)
    const toggle = screen.getByTestId('code-mode-live-usage-toggle')
    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(true)
    expect(toggle).toHaveAttribute('role', 'switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: 'Live usage in Code Mode sessions' })).toBe(toggle)
    expect(screen.getByText('Live usage in Code Mode sessions')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(false)
    expect(screen.getByTestId('code-mode-live-usage-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )

    fireEvent.click(screen.getByTestId('code-mode-live-usage-toggle'))
    expect(useSettingsStore.getState().claudeCodeModeLiveUsage).toBe(true)
    expect(screen.getByTestId('code-mode-live-usage-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  it('shows a switch that was saved off as off', () => {
    useSettingsStore.setState({ claudeCodeModeLiveUsage: false })
    render(<SettingsAdvanced />)
    expect(screen.getByTestId('code-mode-live-usage-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  it('explains the debug line, the log the app deletes, and what turning it off does', () => {
    render(<SettingsAdvanced />)
    expect(CODE_MODE_LIVE_USAGE_LABEL).toBe('Live usage in Code Mode sessions')
    const description = screen.getByTestId('code-mode-live-usage-description')
    expect(description).toHaveTextContent(CODE_MODE_LIVE_USAGE_DESCRIPTION)

    const text = description.textContent ?? ''
    // What the user will see while it is on (PRD FR-41, SEC-10: nothing is hidden).
    expect(text).toContain('"Debug mode enabled" line')
    expect(text).toMatch(/small diagnostic log/)
    expect(text).toMatch(/deletes when the session ends/)
    // What turning it off does.
    expect(text).toMatch(/Turn this off and Code Mode keeps working/)
    expect(text).toMatch(/usage updated less often/)
  })
})
