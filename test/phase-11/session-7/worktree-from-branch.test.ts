import { describe, test, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock simple-git so the module can load without real git
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

describe('Session 7: Worktree from Branch', () => {
  describe('listBranchesWithStatus method', () => {
    test('git-service has listBranchesWithStatus method', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'git-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      expect(content).toContain('async listBranchesWithStatus()')
      expect(content).toContain("this.git.branch(['-a'])")
      expect(content).toContain("worktree', 'list', '--porcelain'")
    })

    test('listBranchesWithStatus returns correct shape', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'git-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      // Verify the return type includes all required fields
      expect(content).toContain('isRemote')
      expect(content).toContain('isCheckedOut')
      expect(content).toContain('worktreePath')
    })
  })

  describe('createWorktreeFromBranch method', () => {
    test('git-service has createWorktreeFromBranch method', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'git-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      expect(content).toContain('async createWorktreeFromBranch(')
      expect(content).toContain('projectName: string')
      expect(content).toContain('branchName: string')
    })

    test('createWorktreeFromBranch delegates to duplicateWorktree for checked-out branches', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'git-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      // Verify it calls duplicateWorktree when branch is already checked out
      expect(content).toContain('this.duplicateWorktree(branchName, wtPath, projectName)')
    })

    test('createWorktreeFromBranch uses git worktree add for unchecked branches', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'git-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      // Verify it calls git worktree add with branch name (no -b flag)
      expect(content).toContain("'worktree', 'add', worktreePath, branchName")
    })
  })

  describe('IPC handlers', () => {
    test('worktree:createFromBranch handler exists', () => {
      const handlersPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'ipc',
        'worktree-handlers.ts'
      )
      const content = fs.readFileSync(handlersPath, 'utf-8')
      expect(content).toContain("'worktree:createFromBranch'")
      expect(content).toContain('gitService.createWorktreeFromBranch')
    })

    test('git:listBranchesWithStatus handler exists', () => {
      const handlersPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'ipc',
        'worktree-handlers.ts'
      )
      const content = fs.readFileSync(handlersPath, 'utf-8')
      expect(content).toContain("'git:listBranchesWithStatus'")
      expect(content).toContain('gitService.listBranchesWithStatus()')
    })
  })

  describe('preload bridge', () => {
    test('createFromBranch exposed on worktreeOps', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const content = fs.readFileSync(preloadPath, 'utf-8')
      expect(content).toContain('createFromBranch')
      expect(content).toContain("'worktree:createFromBranch'")
    })

    test('listBranchesWithStatus exposed on gitOps', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const content = fs.readFileSync(preloadPath, 'utf-8')
      expect(content).toContain('listBranchesWithStatus')
      expect(content).toContain("'git:listBranchesWithStatus'")
    })
  })

  describe('type declarations', () => {
    test('createFromBranch declared in worktreeOps types', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).toContain('createFromBranch')
    })

    test('listBranchesWithStatus declared in gitOps types', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).toContain('listBranchesWithStatus')
    })

    test('listBranchesWithStatus return type includes branch info fields', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).toContain('isRemote: boolean')
      expect(content).toContain('isCheckedOut: boolean')
    })
  })

  describe('BranchPickerDialog component', () => {
    test('BranchPickerDialog.tsx exists', () => {
      const dialogPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      expect(fs.existsSync(dialogPath)).toBe(true)
    })

    test('BranchPickerDialog accepts required props', () => {
      const dialogPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      const content = fs.readFileSync(dialogPath, 'utf-8')
      expect(content).toContain('open: boolean')
      expect(content).toContain('onOpenChange')
      expect(content).toContain('projectPath: string')
      expect(content).toContain('onSelect')
    })

    test('BranchPickerDialog uses Dialog component', () => {
      const dialogPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      const content = fs.readFileSync(dialogPath, 'utf-8')
      expect(content).toContain("from '@/components/ui/dialog'")
      expect(content).toContain('<Dialog')
    })

    test('BranchPickerDialog has filter input', () => {
      const dialogPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      const content = fs.readFileSync(dialogPath, 'utf-8')
      expect(content).toContain('Filter branches')
      expect(content).toContain('setFilter')
    })

    test('BranchPickerDialog shows remote and active badges', () => {
      const dialogPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      const content = fs.readFileSync(dialogPath, 'utf-8')
      expect(content).toContain('remote')
      expect(content).toContain('active')
      expect(content).toContain('isRemote')
      expect(content).toContain('isCheckedOut')
    })

    test('BranchPickerDialog calls listBranchesWithStatus on open', () => {
      const dialogPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      const content = fs.readFileSync(dialogPath, 'utf-8')
      expect(content).toContain('listBranchesWithStatus')
    })

    test('BranchPickerDialog is exported from barrel', () => {
      const indexPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'worktrees',
        'index.ts'
      )
      const content = fs.readFileSync(indexPath, 'utf-8')
      expect(content).toContain("export { BranchPickerDialog } from './BranchPickerDialog'")
    })
  })

  describe('ProjectItem integration', () => {
    test('ProjectItem has New Workspace From... menu item', () => {
      const itemPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'projects',
        'ProjectItem.tsx'
      )
      const content = fs.readFileSync(itemPath, 'utf-8')
      expect(content).toContain('New Workspace From...')
      expect(content).toContain('GitBranch')
    })

    test('ProjectItem imports BranchPickerDialog', () => {
      const itemPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'projects',
        'ProjectItem.tsx'
      )
      const content = fs.readFileSync(itemPath, 'utf-8')
      expect(content).toContain('BranchPickerDialog')
    })

    test('ProjectItem has branchPickerOpen state', () => {
      const itemPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'projects',
        'ProjectItem.tsx'
      )
      const content = fs.readFileSync(itemPath, 'utf-8')
      expect(content).toContain('branchPickerOpen')
      expect(content).toContain('setBranchPickerOpen')
    })

    test('ProjectItem has handleBranchSelect callback', () => {
      const itemPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'projects',
        'ProjectItem.tsx'
      )
      const content = fs.readFileSync(itemPath, 'utf-8')
      expect(content).toContain('handleBranchSelect')
      expect(content).toContain('createFromBranch')
    })

    test('ProjectItem renders BranchPickerDialog', () => {
      const itemPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'projects',
        'ProjectItem.tsx'
      )
      const content = fs.readFileSync(itemPath, 'utf-8')
      expect(content).toContain('<BranchPickerDialog')
      expect(content).toContain('onSelect={handleBranchSelect}')
    })
  })
})
