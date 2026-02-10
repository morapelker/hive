import { describe, test, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const componentPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'worktrees',
  'WorktreeItem.tsx'
)

describe('Session 5: Manual Branch Rename via Context Menu', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(componentPath, 'utf-8')
  })

  describe('Rename Branch menu item placement', () => {
    test('Rename Branch exists in DropdownMenu for non-default worktrees', () => {
      // The DropdownMenuItem for Rename Branch should exist
      expect(content).toContain('Rename Branch')

      // It should be inside a !worktree.is_default guard
      const dropdownSection = content.slice(
        content.indexOf('DropdownMenuContent'),
        content.indexOf('</DropdownMenuContent>')
      )
      expect(dropdownSection).toContain('Rename Branch')
      expect(dropdownSection).toContain('!worktree.is_default')
    })

    test('Rename Branch exists in ContextMenu for non-default worktrees', () => {
      const contextSection = content.slice(
        content.indexOf('ContextMenuContent'),
        content.lastIndexOf('</ContextMenuContent>')
      )
      expect(contextSection).toContain('Rename Branch')
      expect(contextSection).toContain('!worktree.is_default')
    })

    test('Rename Branch uses Pencil icon', () => {
      expect(content).toContain('import')
      expect(content).toContain('Pencil')
      // Verify Pencil is used in the menu items
      const pencilCount = (content.match(/<Pencil/g) || []).length
      expect(pencilCount).toBe(2) // Once in dropdown, once in context menu
    })

    test('Rename Branch is NOT shown for default worktrees (gated by is_default)', () => {
      // Both Rename Branch menu items should be inside !worktree.is_default blocks
      // We verify this by checking they appear after the is_default guard in both menus
      const dropdownContent = content.slice(
        content.indexOf('<DropdownMenuContent'),
        content.indexOf('</DropdownMenuContent>')
      )
      const contextContent = content.slice(
        content.indexOf('<ContextMenuContent'),
        content.lastIndexOf('</ContextMenuContent>')
      )

      // In the dropdown, Rename Branch should come after !worktree.is_default
      const dropdownDefaultIdx = dropdownContent.indexOf('!worktree.is_default')
      const dropdownRenameIdx = dropdownContent.indexOf('Rename Branch')
      expect(dropdownDefaultIdx).toBeLessThan(dropdownRenameIdx)
      expect(dropdownDefaultIdx).not.toBe(-1)

      // In the context menu, same check
      const contextDefaultIdx = contextContent.indexOf('!worktree.is_default')
      const contextRenameIdx = contextContent.indexOf('Rename Branch')
      expect(contextDefaultIdx).toBeLessThan(contextRenameIdx)
      expect(contextDefaultIdx).not.toBe(-1)
    })
  })

  describe('inline rename input', () => {
    test('component has isRenamingBranch state', () => {
      expect(content).toContain('isRenamingBranch')
      expect(content).toContain('setIsRenamingBranch')
      expect(content).toContain('useState(false)')
    })

    test('component has branchNameInput state', () => {
      expect(content).toContain('branchNameInput')
      expect(content).toContain('setBranchNameInput')
    })

    test('inline input renders when isRenamingBranch is true', () => {
      expect(content).toContain('isRenamingBranch ?')
      expect(content).toContain('branch-rename-input')
    })

    test('input handles Enter to submit', () => {
      expect(content).toContain("e.key === 'Enter'")
      expect(content).toContain('handleBranchRename')
    })

    test('input handles Escape to cancel', () => {
      expect(content).toContain("e.key === 'Escape'")
      expect(content).toContain('setIsRenamingBranch(false)')
    })

    test('input handles blur to cancel', () => {
      expect(content).toContain('onBlur')
      expect(content).toContain('setIsRenamingBranch(false)')
    })

    test('input stops click propagation to avoid selecting worktree', () => {
      expect(content).toContain('e.stopPropagation()')
    })

    test('input uses a ref for auto-focus', () => {
      expect(content).toContain('renameInputRef')
      expect(content).toContain('useRef<HTMLInputElement>')
    })
  })

  describe('handleBranchRename handler', () => {
    test('canonicalizes the branch name before sending', () => {
      // Check that the handler performs canonicalization
      expect(content).toContain('.toLowerCase()')
      expect(content).toContain(".replace(/[\\s_]+/g, '-')")
      expect(content).toContain('.slice(0, 50)')
    })

    test('calls window.worktreeOps.renameBranch', () => {
      expect(content).toContain('window.worktreeOps.renameBranch')
    })

    test('calls updateWorktreeBranch on success', () => {
      expect(content).toContain('updateWorktreeBranch')
    })

    test('shows success toast on successful rename', () => {
      expect(content).toContain('toast.success(`Branch renamed to')
    })

    test('shows error toast on failure', () => {
      expect(content).toContain("toast.error(result.error || 'Failed to rename branch')")
    })

    test('shows error toast for invalid (empty after canonicalization) branch name', () => {
      expect(content).toContain("toast.error('Invalid branch name')")
    })

    test('skips rename when input unchanged from current branch', () => {
      // Should return early if trimmed === worktree.branch_name
      expect(content).toContain('trimmed === worktree.branch_name')
    })

    test('resets isRenamingBranch to false after rename completes', () => {
      // The handler should always close the input
      const handler = content.slice(
        content.indexOf('const handleBranchRename'),
        content.indexOf('const handleClick')
      )
      // setIsRenamingBranch(false) should appear in the handler
      const closeCount = (handler.match(/setIsRenamingBranch\(false\)/g) || []).length
      expect(closeCount).toBeGreaterThanOrEqual(3) // early return, invalid, and final
    })
  })

  describe('startBranchRename', () => {
    test('pre-fills input with current branch name', () => {
      expect(content).toContain('setBranchNameInput(worktree.branch_name)')
    })

    test('sets isRenamingBranch to true', () => {
      const starter = content.slice(
        content.indexOf('const startBranchRename'),
        content.indexOf('const handleBranchRename')
      )
      expect(starter).toContain('setIsRenamingBranch(true)')
    })
  })

  describe('preload and IPC integration', () => {
    test('preload exposes renameBranch on worktreeOps', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const preloadContent = fs.readFileSync(preloadPath, 'utf-8')

      expect(preloadContent).toContain('renameBranch')
      expect(preloadContent).toContain("ipcRenderer.invoke('worktree:renameBranch'")
    })

    test('preload type declarations include renameBranch on worktreeOps', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const dtsContent = fs.readFileSync(dtsPath, 'utf-8')

      expect(dtsContent).toContain('renameBranch')
      expect(dtsContent).toContain('worktreeId: string')
      expect(dtsContent).toContain('oldBranch: string')
      expect(dtsContent).toContain('newBranch: string')
    })

    test('IPC handler for worktree:renameBranch exists', () => {
      const handlerPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'ipc',
        'worktree-handlers.ts'
      )
      const handlerContent = fs.readFileSync(handlerPath, 'utf-8')

      expect(handlerContent).toContain("'worktree:renameBranch'")
      expect(handlerContent).toContain('gitService.renameBranch')
      expect(handlerContent).toContain('branch_renamed: 1')
    })
  })

  describe('store integration', () => {
    test('useWorktreeStore has updateWorktreeBranch method', () => {
      const storePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'stores',
        'useWorktreeStore.ts'
      )
      const storeContent = fs.readFileSync(storePath, 'utf-8')

      expect(storeContent).toContain('updateWorktreeBranch')
      expect(storeContent).toContain('branch_renamed: 1')
    })
  })
})
