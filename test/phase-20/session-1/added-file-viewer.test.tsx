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
    test('all files route through setActiveDiff (no openFile branch)', () => {
      const content = readChangesView()
      // handleViewDiff should call setActiveDiff for all file statuses
      expect(content).toContain('setActiveDiff({')
      // There should be no openFile call in handleViewDiff
      expect(content).not.toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('isNewFile is set dynamically based on file status', () => {
      const content = readChangesView()
      // isNewFile should be computed inline, not hardcoded to false
      expect(content).toContain("isNewFile: file.status === '?' || file.status === 'A'")
    })

    test('isUntracked is set based on ? status', () => {
      const content = readChangesView()
      expect(content).toContain("isUntracked: file.status === '?'")
    })

    test('onFileClick is still called for all file types', () => {
      const content = readChangesView()
      expect(content).toContain('onFileClick?.(file.relativePath)')
    })
  })

  describe('GitStatusPanel.tsx routing', () => {
    test('all files route through setActiveDiff (no openFile branch)', () => {
      const content = readGitStatusPanel()
      expect(content).toContain('setActiveDiff({')
      expect(content).not.toContain('openFile(fullPath, fileName, worktreeId)')
    })

    test('isNewFile is set dynamically based on file status', () => {
      const content = readGitStatusPanel()
      expect(content).toContain("isNewFile: file.status === '?' || file.status === 'A'")
    })

    test('isUntracked is set based on ? status', () => {
      const content = readGitStatusPanel()
      expect(content).toContain("isUntracked: file.status === '?'")
    })
  })

  describe('Both components use consistent routing logic', () => {
    test('both files use setActiveDiff with the same isNewFile expression', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      const expression = "isNewFile: file.status === '?' || file.status === 'A'"
      expect(changesView).toContain(expression)
      expect(gitStatusPanel).toContain(expression)
    })

    test('both files set isUntracked consistently', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      const expression = "isUntracked: file.status === '?'"
      expect(changesView).toContain(expression)
      expect(gitStatusPanel).toContain(expression)
    })

    test('neither file uses openFile for new files', () => {
      const changesView = readChangesView()
      const gitStatusPanel = readGitStatusPanel()

      // openFile should not be called in handleViewDiff anymore
      expect(changesView).not.toContain('openFile(fullPath, fileName, worktreeId)')
      expect(gitStatusPanel).not.toContain('openFile(fullPath, fileName, worktreeId)')
    })
  })
})
