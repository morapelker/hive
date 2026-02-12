import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const fileTreeDir = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'file-tree'
)

function readFile(fileName: string): string {
  return fs.readFileSync(path.join(fileTreeDir, fileName), 'utf-8')
}

describe('Session 10: Changes View', () => {
  describe('ChangesView component exists and is complete', () => {
    test('ChangesView.tsx exists and is not a placeholder', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toBeTruthy()
      // Should no longer contain placeholder text
      expect(content).not.toContain('coming next session')
    })

    test('exports ChangesView function component', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('export function ChangesView')
    })
  })

  describe('File grouping by git status', () => {
    test('groups files into staged, modified, and untracked', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('stagedFiles')
      expect(content).toContain('modifiedFiles')
      expect(content).toContain('untrackedFiles')
    })

    test('uses useMemo for file categorization', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('useMemo')
      // Staged check
      expect(content).toContain('file.staged')
      // Untracked check
      expect(content).toContain("file.status === '?'")
      // Modified check
      expect(content).toContain("file.status === 'M'")
      expect(content).toContain("file.status === 'D'")
    })

    test('reads from useGitStore for file statuses', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('useGitStore')
      expect(content).toContain('fileStatusesByWorktree')
    })
  })

  describe('Collapsible group headers', () => {
    test('has a GroupHeader sub-component', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('function GroupHeader')
      expect(content).toContain('<GroupHeader')
    })

    test('groups can be collapsed/expanded', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('collapsed')
      expect(content).toContain('toggleGroup')
      expect(content).toContain('isCollapsed')
    })

    test('groups show count badges', () => {
      const content = readFile('ChangesView.tsx')
      // Count is rendered in each group header
      expect(content).toContain('{count}')
    })

    test('uses ChevronDown/ChevronRight for collapse indicator', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('ChevronDown')
      expect(content).toContain('ChevronRight')
    })

    test('section titles match expected values', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('"Staged Changes"')
      expect(content).toContain('"Changes"')
      expect(content).toContain('"Untracked"')
    })
  })

  describe('File rows', () => {
    test('has a FileRow sub-component', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('function FileRow')
      expect(content).toContain('<FileRow')
    })

    test('file rows show file icon', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain("import { FileIcon } from './FileIcon'")
      expect(content).toContain('<FileIcon')
    })

    test('file rows show git status indicator', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain("import { GitStatusIndicator } from './GitStatusIndicator'")
      expect(content).toContain('<GitStatusIndicator')
    })

    test('clicking a file row opens diff viewer', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('onViewDiff')
      expect(content).toContain('setActiveDiff')
      expect(content).toContain('useFileViewerStore')
    })
  })

  describe('Bulk actions', () => {
    test('has Stage All button', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('handleStageAll')
      expect(content).toContain('Stage All')
    })

    test('has Unstage All button', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('handleUnstageAll')
      expect(content).toContain('Unstage All')
    })

    test('has Discard All button', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('handleDiscardAll')
      expect(content).toContain('Discard')
    })

    test('bulk actions use git store methods', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('stageAll(worktreePath)')
      expect(content).toContain('unstageAll(worktreePath)')
      expect(content).toContain('discardChanges(worktreePath')
    })
  })

  describe('Individual file context menu', () => {
    test('uses ContextMenu component', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('ContextMenu')
      expect(content).toContain('ContextMenuTrigger')
      expect(content).toContain('ContextMenuContent')
      expect(content).toContain('ContextMenuItem')
    })

    test('staged files context menu has Unstage and Open Diff', () => {
      const content = readFile('ChangesView.tsx')
      // Unstage action for staged files
      expect(content).toContain('handleUnstageFile')
      // Open Diff in context
      expect(content).toContain('Open Diff')
    })

    test('unstaged files context menu has Stage, Discard, Open Diff', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('handleStageFile')
      expect(content).toContain('handleDiscardFile')
      expect(content).toContain('Discard Changes')
    })

    test('untracked files context menu has Stage, Delete, Add to .gitignore', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('Delete')
      expect(content).toContain('Add to .gitignore')
      expect(content).toContain('addToGitignore')
    })
  })

  describe('Empty state', () => {
    test('shows no changes message when empty', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('No changes')
      expect(content).toContain('changes-empty')
    })
  })

  describe('Branch info header', () => {
    test('shows branch name with icon', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('GitBranch')
      expect(content).toContain('branchInfo?.name')
    })

    test('shows ahead/behind counts', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('branchInfo.ahead')
      expect(content).toContain('branchInfo.behind')
      expect(content).toContain('ArrowUp')
      expect(content).toContain('ArrowDown')
    })
  })

  describe('Live updates', () => {
    test('subscribes to git status changes', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('window.gitOps.onStatusChanged')
    })

    test('loads file statuses on mount', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('loadFileStatuses')
      expect(content).toContain('loadBranchInfo')
    })

    test('has refresh button', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('handleRefresh')
      expect(content).toContain('RefreshCw')
    })
  })

  describe('Commit and push/pull controls', () => {
    test('includes GitCommitForm for staged files', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('GitCommitForm')
      expect(content).toContain('hasStaged')
    })

    test('includes GitPushPull controls', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('GitPushPull')
    })
  })

  describe('AI review integration', () => {
    test('has review changes with AI button', () => {
      const content = readFile('ChangesView.tsx')
      expect(content).toContain('handleReview')
      expect(content).toContain('Review changes with AI')
      expect(content).toContain('FileSearch')
    })
  })

  describe('FileSidebar integration', () => {
    test('FileSidebar imports and uses ChangesView', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain("import { ChangesView } from './ChangesView'")
      expect(content).toContain('<ChangesView')
    })

    test('FileSidebar no longer uses GitStatusPanel directly', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).not.toContain('GitStatusPanel')
    })
  })

  describe('Barrel exports', () => {
    test('index.ts exports ChangesView', () => {
      const content = readFile('index.ts')
      expect(content).toContain("export { ChangesView } from './ChangesView'")
    })
  })
})
