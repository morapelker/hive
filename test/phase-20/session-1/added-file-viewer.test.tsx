import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const changesViewPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'file-tree',
  'ChangesView.tsx'
)

const gitStatusPanelPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'git',
  'GitStatusPanel.tsx'
)

function readChangesView(): string {
  return fs.readFileSync(changesViewPath, 'utf-8')
}

function readGitStatusPanel(): string {
  return fs.readFileSync(gitStatusPanelPath, 'utf-8')
}

describe('Session 1: Added File Viewer Routing', () => {
  describe('ChangesView.tsx routing', () => {
    test('untracked file (status ?) routes to openFile instead of setActiveDiff', () => {
      const content = readChangesView()
      // The handler should check for new files and call openFile
      expect(content).toContain("const isNewFile = file.status === '?' || file.status === 'A'")
      expect(content).toContain('if (isNewFile)')
      expect(content).toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('added file (status A) is treated as new file and routes to openFile', () => {
      const content = readChangesView()
      // Both ? and A should be treated as new files
      expect(content).toContain("file.status === 'A'")
      // The isNewFile branch should call openFile
      expect(content).toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('modified file (status M) still calls setActiveDiff', () => {
      const content = readChangesView()
      // The else branch should call setActiveDiff for non-new files
      expect(content).toContain('} else {')
      expect(content).toContain('setActiveDiff({')
      expect(content).toContain('isNewFile: false')
    })

    test('deleted file (status D) still calls setActiveDiff', () => {
      const content = readChangesView()
      // D files are not new files, so they go through the else branch
      // which calls setActiveDiff with isNewFile: false
      expect(content).toContain('isNewFile: false')
    })

    test('openFile receives correct full path from worktreePath + relativePath', () => {
      const content = readChangesView()
      // Verify the fullPath is constructed by joining worktreePath and relativePath
      expect(content).toContain('const fullPath = `${worktreePath}/${file.relativePath}`')
    })

    test('gets worktreeId from useWorktreeStore', () => {
      const content = readChangesView()
      expect(content).toContain('useWorktreeStore.getState().selectedWorktreeId')
    })

    test('extracts fileName from relativePath', () => {
      const content = readChangesView()
      expect(content).toContain(
        "const fileName = file.relativePath.split('/').pop() || file.relativePath"
      )
    })

    test('onFileClick is still called for all file types', () => {
      const content = readChangesView()
      // onFileClick should be called after both branches
      expect(content).toContain('onFileClick?.(file.relativePath)')
    })
  })

  describe('GitStatusPanel.tsx routing', () => {
    test('untracked file (status ?) routes to openFile instead of setActiveDiff', () => {
      const content = readGitStatusPanel()
      expect(content).toContain("const isNewFile = file.status === '?' || file.status === 'A'")
      expect(content).toContain('if (isNewFile)')
      expect(content).toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('added file (status A) is treated as new file and routes to openFile', () => {
      const content = readGitStatusPanel()
      expect(content).toContain("file.status === 'A'")
      expect(content).toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('modified file still calls setActiveDiff', () => {
      const content = readGitStatusPanel()
      expect(content).toContain('} else {')
      expect(content).toContain('setActiveDiff({')
      expect(content).toContain('isNewFile: false')
    })

    test('openFile receives correct full path', () => {
      const content = readGitStatusPanel()
      expect(content).toContain('const fullPath = `${worktreePath}/${file.relativePath}`')
    })

    test('gets worktreeId from useWorktreeStore', () => {
      const content = readGitStatusPanel()
      expect(content).toContain('useWorktreeStore.getState().selectedWorktreeId')
    })
  })

  describe('Both components use consistent routing logic', () => {
    test('both files use the same isNewFile condition', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      const condition = "const isNewFile = file.status === '?' || file.status === 'A'"
      expect(changesView).toContain(condition)
      expect(gitStatusPanel).toContain(condition)
    })

    test('both files call openFile for new files', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      expect(changesView).toContain('openFile(fullPath, fileName, worktreeId)')
      expect(gitStatusPanel).toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('both files call setActiveDiff with isNewFile: false for non-new files', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      expect(changesView).toContain('isNewFile: false')
      expect(gitStatusPanel).toContain('isNewFile: false')
    })

    test('neither file passes isNewFile: true to setActiveDiff', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      // setActiveDiff should never receive isNewFile: true anymore
      // since new files are routed to openFile instead
      expect(changesView).not.toContain('isNewFile: true')
      // Also isNewFile should not be passed as a variable to setActiveDiff
      // (previously was `isNewFile` which could be true)
      // Now the else branch always sets isNewFile: false
      expect(gitStatusPanel).not.toContain('isNewFile: true')
    })
  })
})
