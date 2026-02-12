import { describe, test, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Session 9: Integration & Verification — Tests
 *
 * Cross-feature integration tests verifying all Phase 13 sessions work together.
 * Covers:
 * 1. Markdown code blocks (S1) - render tree structures + inline code unaffected
 * 2. Diff colors (S2) - text-green-400 / text-red-400
 * 3. Selection propagation (S3) - clicking worktree selects parent project
 * 4. Streaming thinking blocks (S4) - auto-expand/collapse with user override
 * 5. Refresh project (S5) - context menu + syncWorktrees
 * 6. Quick action buttons (S6) - individual buttons, no dropdown
 * 7. Header branding (S7) - logo + project/branch display
 * 8. Git init dialog (S8) - dialog + IPC + preload
 */

// Helper to read source files relative to project root
function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../..', relativePath), 'utf-8')
}

describe('Session 9: Integration & Verification', () => {
  afterEach(() => {
    cleanup()
  })

  // ─── S1: Markdown Code Blocks ─────────────────────────────────────────────

  describe('S1: Markdown code blocks with tree structure render correctly', () => {
    test('bare fenced blocks use CodeBlock with "text" language', () => {
      const source = readSource('src/renderer/src/components/sessions/MarkdownRenderer.tsx')
      // isBlock condition detects multiline content
      expect(source).toContain("content.includes('\\n')")
      // Falls back to 'text' language for bare fenced blocks
      expect(source).toContain("match?.[1] ?? 'text'")
    })

    test('inline code is unaffected by the fix', () => {
      const source = readSource('src/renderer/src/components/sessions/MarkdownRenderer.tsx')
      // Inline code still uses the simple <code> element
      expect(source).toContain('bg-muted px-1.5 py-0.5 rounded text-sm font-mono')
      expect(source).toContain('{children}</code>')
    })

    test('CodeBlock component preserves whitespace with pre tag', () => {
      const source = readSource('src/renderer/src/components/sessions/CodeBlock.tsx')
      expect(source).toContain('<pre')
      expect(source).toContain('<code>')
      expect(source).toContain('data-testid="code-block"')
    })
  })

  // ─── S2: Diff Colors ──────────────────────────────────────────────────────

  describe('S2: Diff colors are readable', () => {
    test('EditToolView added lines use text-green-400', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      const addedLines = screen.getAllByTestId('diff-added')
      expect(addedLines.length).toBeGreaterThan(0)
      const contentSpan = addedLines[0].querySelector('span:last-child')
      expect(contentSpan).toHaveClass('text-green-400')
      expect(contentSpan).not.toHaveClass('text-green-300')
    })

    test('EditToolView removed lines use text-red-400', async () => {
      const { EditToolView } =
        await import('../../../src/renderer/src/components/sessions/tools/EditToolView')

      render(
        React.createElement(EditToolView, {
          name: 'Edit',
          input: { oldString: 'old line', newString: 'new line' },
          status: 'success'
        })
      )

      const removedLines = screen.getAllByTestId('diff-removed')
      expect(removedLines.length).toBeGreaterThan(0)
      const contentSpan = removedLines[0].querySelector('span:last-child')
      expect(contentSpan).toHaveClass('text-red-400')
      expect(contentSpan).not.toHaveClass('text-red-300')
    })

    test('CSS diff2html overrides include correct dark mode colors', () => {
      const css = readSource('src/renderer/src/styles/globals.css')
      // Dark mode green
      expect(css).toContain('color: #3fb950')
      // Dark mode red
      expect(css).toContain('color: #f85149')
      // Light mode green
      expect(css).toContain('color: #1a7f37')
      // Light mode red
      expect(css).toContain('color: #cf222e')
    })
  })

  // ─── S3: Selection Propagation ─────────────────────────────────────────────

  describe('S3: Selection propagation works', () => {
    test('WorktreeItem handleClick calls selectProject with project_id', () => {
      const source = readSource('src/renderer/src/components/worktrees/WorktreeItem.tsx')
      // selectProject is imported/used
      expect(source).toContain('selectProject')
      // Called with worktree.project_id in handleClick
      expect(source).toContain('selectProject(worktree.project_id)')
    })

    test('selectProject is sourced from useProjectStore', () => {
      const source = readSource('src/renderer/src/components/worktrees/WorktreeItem.tsx')
      expect(source).toContain('useProjectStore')
      expect(source).toMatch(/useProjectStore.*selectProject|selectProject.*useProjectStore/)
    })
  })

  // ─── S4: Streaming Thinking Blocks ─────────────────────────────────────────

  describe('S4: Thinking blocks auto-expand and collapse', () => {
    test('auto-expands when isStreaming becomes true', async () => {
      const { ReasoningBlock } =
        await import('../../../src/renderer/src/components/sessions/ReasoningBlock')

      const { rerender } = render(
        React.createElement(ReasoningBlock, { text: 'thinking...', isStreaming: false })
      )
      expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()

      rerender(React.createElement(ReasoningBlock, { text: 'thinking...', isStreaming: true }))
      expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()
    })

    test('auto-collapses when isStreaming becomes false', async () => {
      const { ReasoningBlock } =
        await import('../../../src/renderer/src/components/sessions/ReasoningBlock')

      const { rerender } = render(
        React.createElement(ReasoningBlock, { text: 'thinking...', isStreaming: true })
      )
      expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()

      rerender(React.createElement(ReasoningBlock, { text: 'done thinking', isStreaming: false }))
      expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
    })

    test('user manual collapse is respected after streaming ends', async () => {
      const user = userEvent.setup()
      const { ReasoningBlock } =
        await import('../../../src/renderer/src/components/sessions/ReasoningBlock')

      const { rerender } = render(
        React.createElement(ReasoningBlock, { text: 'thinking...', isStreaming: true })
      )
      // Auto-expanded
      expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()

      // User manually collapses
      await user.click(screen.getByTestId('reasoning-block-header'))
      expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()

      // Streaming ends — should stay collapsed (user override)
      rerender(React.createElement(ReasoningBlock, { text: 'done thinking', isStreaming: false }))
      expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
    })

    test('defaults to collapsed when isStreaming is not provided', async () => {
      const { ReasoningBlock } =
        await import('../../../src/renderer/src/components/sessions/ReasoningBlock')

      render(React.createElement(ReasoningBlock, { text: 'some reasoning' }))
      expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
    })

    test('manual toggle still works on non-streaming blocks', async () => {
      const user = userEvent.setup()
      const { ReasoningBlock } =
        await import('../../../src/renderer/src/components/sessions/ReasoningBlock')

      render(React.createElement(ReasoningBlock, { text: 'some reasoning' }))
      // Expand
      await user.click(screen.getByTestId('reasoning-block-header'))
      expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()
      // Collapse
      await user.click(screen.getByTestId('reasoning-block-header'))
      expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
    })

    test('isStreaming prop is forwarded from AssistantCanvas', () => {
      const source = readSource('src/renderer/src/components/sessions/AssistantCanvas.tsx')
      expect(source).toContain('isStreaming')
      expect(source).toContain('<ReasoningBlock')
    })
  })

  // ─── S5: Refresh Project ───────────────────────────────────────────────────

  describe('S5: Refresh project context menu', () => {
    test('ProjectItem has Refresh Project menu item', () => {
      const source = readSource('src/renderer/src/components/projects/ProjectItem.tsx')
      expect(source).toContain('Refresh Project')
      expect(source).toContain('handleRefreshProject')
      expect(source).toContain("toast.success('Project refreshed')")
    })

    test('Refresh Project appears after Refresh Language', () => {
      const source = readSource('src/renderer/src/components/projects/ProjectItem.tsx')
      const langIndex = source.indexOf('Refresh Language')
      const projectIndex = source.indexOf('Refresh Project')
      expect(langIndex).toBeGreaterThan(-1)
      expect(projectIndex).toBeGreaterThan(-1)
      expect(projectIndex).toBeGreaterThan(langIndex)
    })

    test('syncWorktrees is used from worktree store', () => {
      const source = readSource('src/renderer/src/components/projects/ProjectItem.tsx')
      expect(source).toContain('syncWorktrees')
      expect(source).toMatch(/syncWorktrees\(project\.id,\s*project\.path\)/)
    })
  })

  // ─── S6: Quick Action Buttons ──────────────────────────────────────────────

  describe('S6: Quick actions are all accessible', () => {
    test('has four individual buttons with data-testid attributes', () => {
      const source = readSource('src/renderer/src/components/layout/QuickActions.tsx')
      expect(source).toContain('data-testid="quick-action-cursor"')
      expect(source).toContain('data-testid="quick-action-ghostty"')
      expect(source).toContain('data-testid="quick-action-copy-path"')
      expect(source).toContain('data-testid="quick-action-finder"')
    })

    test('no dropdown menu exists', () => {
      const source = readSource('src/renderer/src/components/layout/QuickActions.tsx')
      expect(source).not.toContain('DropdownMenu')
      expect(source).not.toContain('DropdownMenuTrigger')
      expect(source).not.toContain('DropdownMenuContent')
      expect(source).not.toContain('ChevronDown')
    })

    test('Cursor and Ghostty buttons have labels', () => {
      const source = readSource('src/renderer/src/components/layout/QuickActions.tsx')
      expect(source).toContain('<span>Cursor</span>')
      expect(source).toContain('<span>Ghostty</span>')
    })

    test('Copy Path shows check icon after copying', () => {
      const source = readSource('src/renderer/src/components/layout/QuickActions.tsx')
      expect(source).toContain('copied')
      expect(source).toContain('setCopied(true)')
      expect(source).toContain('text-green-500')
      expect(source).toContain('Check')
    })

    test('buttons are disabled when no worktree path', () => {
      const source = readSource('src/renderer/src/components/layout/QuickActions.tsx')
      expect(source).toContain('disabled={disabled}')
      expect(source).toContain('const disabled = !worktreePath')
    })
  })

  // ─── S7: Header Branding ───────────────────────────────────────────────────

  describe('S7: Header branding with logo + project/branch', () => {
    test('header has logo image', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain("import hiveLogo from '@/assets/icon.png'")
      expect(source).toContain('src={hiveLogo}')
      expect(source).toContain('alt="Hive"')
    })

    test('shows project name when selected', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('selectedProject.name')
      expect(source).toContain('data-testid="header-project-info"')
    })

    test('shows branch name in parentheses', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('selectedWorktree?.branch_name')
      expect(source).toMatch(/\(\s*\{selectedWorktree\.branch_name\}\s*\)/)
    })

    test('hides branch for default worktree (no-worktree)', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain("'(no-worktree)'")
    })

    test('shows "Hive" fallback when no project selected', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toMatch(/>Hive<\/span>/)
    })

    test('header layout includes QuickActions in center', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('<QuickActions')
    })

    test('long names are truncated', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('truncate')
      expect(source).toContain('min-w-0')
    })

    test('logo asset exists', () => {
      const assetPath = path.resolve(__dirname, '../../../src/renderer/src/assets/icon.png')
      expect(fs.existsSync(assetPath)).toBe(true)
    })
  })

  // ─── S8: Git Init Dialog ───────────────────────────────────────────────────

  describe('S8: Git init dialog flow works end-to-end', () => {
    test('GitInitDialog renders with title and path', async () => {
      const { GitInitDialog } =
        await import('../../../src/renderer/src/components/projects/GitInitDialog')

      render(
        React.createElement(GitInitDialog, {
          open: true,
          path: '/tmp/my-project',
          onCancel: vi.fn(),
          onConfirm: vi.fn()
        })
      )

      expect(screen.getByText('Not a Git Repository')).toBeInTheDocument()
      expect(screen.getByText('/tmp/my-project')).toBeInTheDocument()
      expect(screen.getByText('Initialize Repository')).toBeInTheDocument()
      expect(screen.getByText('Cancel')).toBeInTheDocument()
    })

    test('Cancel button calls onCancel', async () => {
      const user = userEvent.setup()
      const { GitInitDialog } =
        await import('../../../src/renderer/src/components/projects/GitInitDialog')

      const onCancel = vi.fn()
      render(
        React.createElement(GitInitDialog, {
          open: true,
          path: '/tmp/test',
          onCancel,
          onConfirm: vi.fn()
        })
      )

      await user.click(screen.getByText('Cancel'))
      expect(onCancel).toHaveBeenCalled()
    })

    test('Initialize button calls onConfirm', async () => {
      const user = userEvent.setup()
      const { GitInitDialog } =
        await import('../../../src/renderer/src/components/projects/GitInitDialog')

      const onConfirm = vi.fn()
      render(
        React.createElement(GitInitDialog, {
          open: true,
          path: '/tmp/test',
          onCancel: vi.fn(),
          onConfirm
        })
      )

      await user.click(screen.getByText('Initialize Repository'))
      expect(onConfirm).toHaveBeenCalled()
    })

    test('dialog not visible when closed', async () => {
      const { GitInitDialog } =
        await import('../../../src/renderer/src/components/projects/GitInitDialog')

      render(
        React.createElement(GitInitDialog, {
          open: false,
          path: '/tmp/test',
          onCancel: vi.fn(),
          onConfirm: vi.fn()
        })
      )

      expect(screen.queryByText('Not a Git Repository')).not.toBeInTheDocument()
    })

    test('git:init IPC handler exists in project-handlers', () => {
      const source = readSource('src/main/ipc/project-handlers.ts')
      expect(source).toContain("'git:init'")
      expect(source).toContain('git init --initial-branch=main')
    })

    test('initRepository is exposed in preload bridge', () => {
      const source = readSource('src/preload/index.ts')
      expect(source).toContain('initRepository')
      expect(source).toContain("'git:init'")
    })

    test('initRepository type is declared in preload types', () => {
      const source = readSource('src/preload/index.d.ts')
      expect(source).toContain('initRepository')
    })

    test('AddProjectButton intercepts non-git errors and shows dialog', () => {
      const source = readSource('src/renderer/src/components/projects/AddProjectButton.tsx')
      expect(source).toContain('GitInitDialog')
      expect(source).toContain('gitInitPath')
      expect(source).toContain('not a Git repository')
      expect(source).toContain('initRepository')
    })
  })

  // ─── Cross-Feature Integration ─────────────────────────────────────────────

  describe('Cross-feature: Selection + Header integration', () => {
    test('Header uses both useProjectStore and useWorktreeStore', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('useProjectStore')
      expect(source).toContain('useWorktreeStore')
      expect(source).toContain('selectedProjectId')
      expect(source).toContain('selectedWorktreeId')
      expect(source).toContain('worktreesByProject')
    })

    test('WorktreeItem selection updates project store that Header reads', () => {
      // WorktreeItem calls selectProject (S3)
      const worktreeSource = readSource('src/renderer/src/components/worktrees/WorktreeItem.tsx')
      expect(worktreeSource).toContain('selectProject(worktree.project_id)')

      // Header reads selectedProjectId (S7)
      const headerSource = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(headerSource).toContain('selectedProjectId')
      expect(headerSource).toContain('selectedProject.name')
    })
  })

  describe('Cross-feature: Quick Actions + Header layout', () => {
    test('QuickActions is rendered inside Header', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('<QuickActions')
      expect(source).toContain("import { QuickActions } from './QuickActions'")
    })

    test('QuickActions uses same worktree store as Header', () => {
      const quickActionsSource = readSource('src/renderer/src/components/layout/QuickActions.tsx')
      const headerSource = readSource('src/renderer/src/components/layout/Header.tsx')
      // Both read from useWorktreeStore
      expect(quickActionsSource).toContain('useWorktreeStore')
      expect(headerSource).toContain('useWorktreeStore')
    })
  })

  // ─── No Regressions ───────────────────────────────────────────────────────

  describe('No regressions in critical patterns', () => {
    test('pre override still passes through children (not wrapping in extra pre)', () => {
      const source = readSource('src/renderer/src/components/sessions/MarkdownRenderer.tsx')
      expect(source).toContain('pre: ({ children }) => <>{children}</>')
    })

    test('ReasoningBlock still has data-testid attributes for all parts', () => {
      const source = readSource('src/renderer/src/components/sessions/ReasoningBlock.tsx')
      expect(source).toContain('data-testid="reasoning-block"')
      expect(source).toContain('data-testid="reasoning-block-header"')
      expect(source).toContain('data-testid="reasoning-block-content"')
    })

    test('EditToolView still has data-testid on diff lines', () => {
      const source = readSource('src/renderer/src/components/sessions/tools/EditToolView.tsx')
      expect(source).toContain('data-testid="diff-removed"')
      expect(source).toContain('data-testid="diff-added"')
      expect(source).toContain('data-testid="edit-tool-view"')
    })

    test('Header still has data-testid on key elements', () => {
      const source = readSource('src/renderer/src/components/layout/Header.tsx')
      expect(source).toContain('data-testid="header"')
      expect(source).toContain('data-testid="header-project-info"')
      expect(source).toContain('data-testid="settings-toggle"')
      expect(source).toContain('data-testid="right-sidebar-toggle"')
    })
  })
})
