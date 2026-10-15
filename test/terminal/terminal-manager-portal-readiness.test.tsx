import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { TerminalManager } from '../../src/renderer/src/components/terminal/TerminalManager'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useTerminalTabStore } from '../../src/renderer/src/stores/useTerminalTabStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'

vi.mock('@/components/terminal/TerminalView', () => ({
  TerminalView: ({ terminalId }: { terminalId: string }) => (
    <div data-testid={`terminal-view-${terminalId}`}>{terminalId}</div>
  )
}))

vi.mock('@/components/terminal/TerminalTabSidebar', () => ({
  TerminalTabSidebar: () => <div data-testid="terminal-tab-sidebar" />
}))

describe('TerminalManager portal readiness', () => {
  beforeEach(() => {
    act(() => {
      useTerminalTabStore.getState().removeAllTabs()

      useSettingsStore.setState({
        embeddedTerminalBackend: 'ghostty',
        terminalPosition: 'sidebar'
      })

      useWorktreeStore.setState({
        selectedWorktreeId: 'wt-1',
        worktreesByProject: new Map([
          [
            'proj-1',
            [
              {
                id: 'wt-1',
                project_id: 'proj-1',
                name: 'main',
                branch_name: 'main',
                path: '/tmp/project',
                status: 'active',
                is_default: true,
                branch_renamed: 0,
                last_message_at: null,
                session_titles: '[]',
                last_model_provider_id: null,
                last_model_id: null,
                last_model_variant: null,
                created_at: '2026-01-01T00:00:00.000Z',
                last_accessed_at: '2026-01-01T00:00:00.000Z',
                github_pr_number: null,
                github_pr_url: null
              }
            ]
          ]
        ])
      })
    })
  })

  test('does not auto-create a terminal until a real portal target exists', async () => {
    const { rerender } = render(
      <TerminalManager
        selectedWorktreeId="wt-1"
        worktreePath="/tmp/project"
        isVisible
        portalReady={false}
      />
    )

    await waitFor(() => {
      expect(useTerminalTabStore.getState().getTabs('wt-1')).toHaveLength(0)
    })

    rerender(
      <TerminalManager
        selectedWorktreeId="wt-1"
        worktreePath="/tmp/project"
        isVisible
        portalReady
      />
    )

    await waitFor(() => {
      expect(useTerminalTabStore.getState().getTabs('wt-1')).toHaveLength(1)
    })
  })

  // Sidebar mode used to create a tab (xterm + PTY) for every worktree the user
  // visited while the panel was hidden; creation now waits for visibility in
  // every position.
  test('does not auto-create a sidebar terminal while the panel is hidden', async () => {
    const { rerender } = render(
      <TerminalManager
        selectedWorktreeId="wt-1"
        worktreePath="/tmp/project"
        isVisible={false}
        portalReady
      />
    )

    await waitFor(() => {
      expect(useTerminalTabStore.getState().getTabs('wt-1')).toHaveLength(0)
    })

    rerender(
      <TerminalManager
        selectedWorktreeId="wt-1"
        worktreePath="/tmp/project"
        isVisible
        portalReady
      />
    )

    await waitFor(() => {
      expect(useTerminalTabStore.getState().getTabs('wt-1')).toHaveLength(1)
    })
  })
})
