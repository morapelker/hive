import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

// Mock all store dependencies before importing the component
vi.mock('@/stores/useThemeStore', () => ({
  useThemeStore: vi.fn(() => ({
    setTheme: vi.fn()
  }))
}))

vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: vi.fn(() => ({
    resetToDefaults: vi.fn()
  }))
}))

vi.mock('@/lib/themes', () => ({
  DEFAULT_THEME_ID: 'zinc-dark'
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Track settings changes
const mockUpdateSetting = vi.fn()

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: vi.fn(() => ({
    autoStartSession: true,
    breedType: 'dogs',
    showModelIcons: false,
    defaultAgentSdk: 'opencode',
    updateSetting: mockUpdateSetting,
    resetToDefaults: vi.fn()
  }))
}))

describe('SettingsGeneral production labels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders "OpenCode" button text (no mock suffix)', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    render(React.createElement(SettingsGeneral))

    const opencodeButton = screen.getByTestId('agent-sdk-opencode')
    expect(opencodeButton).toBeInTheDocument()
    expect(opencodeButton.textContent).toBe('OpenCode')
    expect(opencodeButton.textContent).not.toContain('Mock')
    expect(opencodeButton.textContent).not.toContain('mock')
  })

  it('renders "Claude Code" button text (no mock suffix)', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    render(React.createElement(SettingsGeneral))

    const claudeButton = screen.getByTestId('agent-sdk-claude-code')
    expect(claudeButton).toBeInTheDocument()
    expect(claudeButton.textContent).toBe('Claude Code')
    expect(claudeButton.textContent).not.toContain('Mock')
    expect(claudeButton.textContent).not.toContain('mock')
  })

  it('renders user-friendly section label "AI Provider"', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    render(React.createElement(SettingsGeneral))

    expect(screen.getByText('AI Provider')).toBeInTheDocument()
  })

  it('explains that existing sessions keep their original provider', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    render(React.createElement(SettingsGeneral))

    expect(screen.getByText(/existing sessions keep their original provider/i)).toBeInTheDocument()
  })

  it('does not contain any "(Mock)" text anywhere in the settings panel', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    const { container } = render(React.createElement(SettingsGeneral))

    expect(container.textContent).not.toContain('(Mock)')
    expect(container.textContent).not.toContain('mock')
  })

  it('updates defaultAgentSdk to claude-code when Claude Code is clicked', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    render(React.createElement(SettingsGeneral))

    const claudeButton = screen.getByTestId('agent-sdk-claude-code')
    fireEvent.click(claudeButton)
    expect(mockUpdateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'claude-code')
  })

  it('updates defaultAgentSdk to opencode when OpenCode is clicked', async () => {
    const { SettingsGeneral } =
      await import('../../../src/renderer/src/components/settings/SettingsGeneral')
    render(React.createElement(SettingsGeneral))

    const opencodeButton = screen.getByTestId('agent-sdk-opencode')
    fireEvent.click(opencodeButton)
    expect(mockUpdateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'opencode')
  })
})
