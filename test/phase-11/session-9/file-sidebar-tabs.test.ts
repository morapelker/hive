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

describe('Session 9: File Sidebar Tabs', () => {
  describe('FileSidebar component', () => {
    test('FileSidebar.tsx exists', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toBeTruthy()
    })

    test('renders two tabs: Changes and Files', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain("'changes'")
      expect(content).toContain("'files'")
      // Tab text content inside button elements
      expect(content).toMatch(/>\s*Changes\s*/)
      expect(content).toMatch(/>\s*Files\s*/)
      expect(content).toContain("setActiveTab('changes')")
      expect(content).toContain("setActiveTab('files')")
    })

    test('defaults to Changes tab', () => {
      const content = readFile('FileSidebar.tsx')
      // useState defaults to 'changes'
      expect(content).toContain("useState<'changes' | 'files'>('changes')")
    })

    test('Changes tab embeds ChangesView', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain('<ChangesView')
      expect(content).toContain("activeTab === 'changes'")
      expect(content).toContain("import { ChangesView } from './ChangesView'")
    })

    test('renders FileTree when files tab is active', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain('<FileTree')
    })

    test('passes hideHeader to FileTree in files tab', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain('hideHeader')
    })

    test('passes hideGitIndicators to FileTree in files tab', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain('hideGitIndicators')
    })

    test('passes hideGitContextActions to FileTree in files tab', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain('hideGitContextActions')
    })

    test('has close button with X icon', () => {
      const content = readFile('FileSidebar.tsx')
      expect(content).toContain('onClose')
      expect(content).toContain('<X')
      expect(content).toContain('aria-label="Close sidebar"')
    })

    test('active tab has underline indicator', () => {
      const content = readFile('FileSidebar.tsx')
      // Active tab should have a bottom border indicator
      expect(content).toContain('h-0.5 bg-primary')
    })
  })

  describe('FileTree hideHeader prop', () => {
    test('FileTree accepts hideHeader prop', () => {
      const content = readFile('FileTree.tsx')
      expect(content).toContain('hideHeader?: boolean')
    })

    test('FileTree conditionally renders header based on hideHeader', () => {
      const content = readFile('FileTree.tsx')
      // Verify that header rendering is conditional
      expect(content).toContain('!hideHeader')
      expect(content).toContain('headerElement')
    })
  })

  describe('FileTreeNode hideGitIndicators prop', () => {
    test('VirtualFileTreeNode accepts hideGitIndicators prop', () => {
      const content = readFile('FileTreeNode.tsx')
      expect(content).toContain('hideGitIndicators?: boolean')
    })

    test('GitStatusIndicator is conditionally rendered', () => {
      const content = readFile('FileTreeNode.tsx')
      // The git indicator should be hidden when hideGitIndicators is true
      expect(content).toContain('!hideGitIndicators && gitStatus')
    })
  })

  describe('FileContextMenu hideGitContextActions prop', () => {
    test('FileContextMenu accepts hideGitContextActions prop', () => {
      const content = readFile('FileContextMenu.tsx')
      expect(content).toContain('hideGitContextActions?: boolean')
    })

    test('git actions are hidden when hideGitContextActions is true', () => {
      const content = readFile('FileContextMenu.tsx')
      // The git action visibility checks should include hideGitContextActions
      expect(content).toContain('!hideGitContextActions && gitStatus')
      expect(content).toContain('!hideGitContextActions && staged')
    })
  })

  describe('Barrel exports', () => {
    test('index.ts exports FileSidebar', () => {
      const content = readFile('index.ts')
      expect(content).toContain("export { FileSidebar } from './FileSidebar'")
    })
  })

  describe('RightSidebar integration', () => {
    test('RightSidebar uses FileSidebar as the entire top half', () => {
      const rightSidebarPath = path.join(fileTreeDir, '..', 'layout', 'RightSidebar.tsx')
      const content = fs.readFileSync(rightSidebarPath, 'utf-8')
      expect(content).toContain('FileSidebar')
      expect(content).toContain('<FileSidebar')
      // Should NOT directly render FileTree or GitStatusPanel anymore
      expect(content).not.toContain('<FileTree')
      expect(content).not.toContain('<GitStatusPanel')
    })

    test('RightSidebar does not import GitStatusPanel', () => {
      const rightSidebarPath = path.join(fileTreeDir, '..', 'layout', 'RightSidebar.tsx')
      const content = fs.readFileSync(rightSidebarPath, 'utf-8')
      expect(content).not.toContain('import { GitStatusPanel }')
    })
  })
})
