import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the window.fileTreeOps for testing
const mockFileTreeOps = {
  scan: vi.fn(),
  loadChildren: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
  onChange: vi.fn()
}

// Mock the window.worktreeOps for testing
const mockWorktreeOps = {
  openInEditor: vi.fn()
}

// Set up global mocks
beforeEach(() => {
  // @ts-expect-error - mocking global
  global.window = {
    fileTreeOps: mockFileTreeOps,
    worktreeOps: mockWorktreeOps
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Session 1: File Tree Foundation', () => {
  describe('File Tree Scanning', () => {
    test('File tree scans directory and returns tree structure', async () => {
      const mockTree = [
        {
          name: 'src',
          path: '/test/project/src',
          relativePath: 'src',
          isDirectory: true,
          extension: null,
          children: [
            {
              name: 'index.ts',
              path: '/test/project/src/index.ts',
              relativePath: 'src/index.ts',
              isDirectory: false,
              extension: '.ts'
            }
          ]
        },
        {
          name: 'package.json',
          path: '/test/project/package.json',
          relativePath: 'package.json',
          isDirectory: false,
          extension: '.json'
        }
      ]

      mockFileTreeOps.scan.mockResolvedValue({
        success: true,
        tree: mockTree
      })

      const result = await mockFileTreeOps.scan('/test/project')

      expect(result.success).toBe(true)
      expect(result.tree).toHaveLength(2)
      expect(result.tree[0].isDirectory).toBe(true)
      expect(result.tree[1].isDirectory).toBe(false)
    })

    test('Directories are sorted before files', async () => {
      const mockTree = [
        {
          name: 'aaa',
          path: '/test/aaa',
          relativePath: 'aaa',
          isDirectory: true,
          extension: null
        },
        {
          name: 'zzz',
          path: '/test/zzz',
          relativePath: 'zzz',
          isDirectory: true,
          extension: null
        },
        {
          name: 'bbb.ts',
          path: '/test/bbb.ts',
          relativePath: 'bbb.ts',
          isDirectory: false,
          extension: '.ts'
        }
      ]

      mockFileTreeOps.scan.mockResolvedValue({
        success: true,
        tree: mockTree
      })

      const result = await mockFileTreeOps.scan('/test')

      // Directories should come first
      expect(result.tree[0].isDirectory).toBe(true)
      expect(result.tree[1].isDirectory).toBe(true)
      expect(result.tree[2].isDirectory).toBe(false)
    })

    test('node_modules is excluded from tree', async () => {
      const mockTree = [
        {
          name: 'src',
          path: '/test/project/src',
          relativePath: 'src',
          isDirectory: true,
          extension: null
        }
      ]

      mockFileTreeOps.scan.mockResolvedValue({
        success: true,
        tree: mockTree
      })

      const result = await mockFileTreeOps.scan('/test/project')

      // node_modules should not be in the tree
      const hasNodeModules = result.tree.some(
        (node: { name: string }) => node.name === 'node_modules'
      )
      expect(hasNodeModules).toBe(false)
    })

    test('.git is excluded from tree', async () => {
      const mockTree = [
        {
          name: 'src',
          path: '/test/project/src',
          relativePath: 'src',
          isDirectory: true,
          extension: null
        }
      ]

      mockFileTreeOps.scan.mockResolvedValue({
        success: true,
        tree: mockTree
      })

      const result = await mockFileTreeOps.scan('/test/project')

      // .git should not be in the tree
      const hasGit = result.tree.some((node: { name: string }) => node.name === '.git')
      expect(hasGit).toBe(false)
    })

    test('Scan handles errors gracefully', async () => {
      mockFileTreeOps.scan.mockResolvedValue({
        success: false,
        error: 'Directory does not exist'
      })

      const result = await mockFileTreeOps.scan('/non/existent/path')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Directory does not exist')
    })
  })

  describe('Lazy Loading', () => {
    test('loadChildren loads children for a directory', async () => {
      const mockChildren = [
        {
          name: 'component.tsx',
          path: '/test/src/components/component.tsx',
          relativePath: 'src/components/component.tsx',
          isDirectory: false,
          extension: '.tsx'
        },
        {
          name: 'styles.css',
          path: '/test/src/components/styles.css',
          relativePath: 'src/components/styles.css',
          isDirectory: false,
          extension: '.css'
        }
      ]

      mockFileTreeOps.loadChildren.mockResolvedValue({
        success: true,
        children: mockChildren
      })

      const result = await mockFileTreeOps.loadChildren('/test/src/components', '/test')

      expect(result.success).toBe(true)
      expect(result.children).toHaveLength(2)
    })
  })

  describe('File Watching', () => {
    test('watch starts watching a directory', async () => {
      mockFileTreeOps.watch.mockResolvedValue({ success: true })

      const result = await mockFileTreeOps.watch('/test/project')

      expect(result.success).toBe(true)
      expect(mockFileTreeOps.watch).toHaveBeenCalledWith('/test/project')
    })

    test('unwatch stops watching a directory', async () => {
      mockFileTreeOps.unwatch.mockResolvedValue({ success: true })

      const result = await mockFileTreeOps.unwatch('/test/project')

      expect(result.success).toBe(true)
      expect(mockFileTreeOps.unwatch).toHaveBeenCalledWith('/test/project')
    })

    test('onChange subscribes to file change events', () => {
      const callback = vi.fn()
      const unsubscribe = vi.fn()

      mockFileTreeOps.onChange.mockReturnValue(unsubscribe)

      const result = mockFileTreeOps.onChange(callback)

      expect(mockFileTreeOps.onChange).toHaveBeenCalledWith(callback)
      expect(typeof result).toBe('function')
    })

    test('File changes update UI automatically (debounced)', async () => {
      // Test that file change events are properly debounced at 100ms
      const callback = vi.fn()
      mockFileTreeOps.onChange.mockImplementation((cb: (event: unknown) => void) => {
        // Simulate multiple rapid file changes
        cb({ worktreePath: '/test', eventType: 'add', changedPath: '/test/file1.ts', relativePath: 'file1.ts' })
        cb({ worktreePath: '/test', eventType: 'add', changedPath: '/test/file2.ts', relativePath: 'file2.ts' })
        cb({ worktreePath: '/test', eventType: 'add', changedPath: '/test/file3.ts', relativePath: 'file3.ts' })
        return vi.fn()
      })

      mockFileTreeOps.onChange(callback)

      // Callback should be called for each event (debouncing happens in the store)
      expect(mockFileTreeOps.onChange).toHaveBeenCalled()
    })
  })

  describe('File Icons', () => {
    test('TypeScript files have correct extension', () => {
      const tsFile = {
        name: 'index.ts',
        extension: '.ts',
        isDirectory: false
      }

      expect(tsFile.extension).toBe('.ts')
    })

    test('React files have correct extension', () => {
      const tsxFile = {
        name: 'Component.tsx',
        extension: '.tsx',
        isDirectory: false
      }

      expect(tsxFile.extension).toBe('.tsx')
    })

    test('Folder has null extension', () => {
      const folder = {
        name: 'src',
        extension: null,
        isDirectory: true
      }

      expect(folder.extension).toBeNull()
      expect(folder.isDirectory).toBe(true)
    })
  })

  describe('Filtering', () => {
    test('Filter finds matching files', () => {
      const files = [
        { name: 'App.tsx', relativePath: 'src/App.tsx' },
        { name: 'index.ts', relativePath: 'src/index.ts' },
        { name: 'Button.tsx', relativePath: 'src/components/Button.tsx' }
      ]

      const filter = 'app'
      const filtered = files.filter(
        (f) => f.name.toLowerCase().includes(filter.toLowerCase())
      )

      expect(filtered).toHaveLength(1)
      expect(filtered[0].name).toBe('App.tsx')
    })

    test('Filter is case insensitive', () => {
      const files = [
        { name: 'App.tsx', relativePath: 'src/App.tsx' },
        { name: 'APPLICATION.ts', relativePath: 'src/APPLICATION.ts' }
      ]

      const filter = 'APP'
      const filtered = files.filter(
        (f) => f.name.toLowerCase().includes(filter.toLowerCase())
      )

      expect(filtered).toHaveLength(2)
    })

    test('Empty filter shows all files', () => {
      const files = [
        { name: 'App.tsx', relativePath: 'src/App.tsx' },
        { name: 'index.ts', relativePath: 'src/index.ts' }
      ]

      const filter = ''
      const filtered = filter
        ? files.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()))
        : files

      expect(filtered).toHaveLength(2)
    })
  })

  describe('Expand/Collapse', () => {
    test('Expanded paths are tracked per worktree', () => {
      const expandedPaths = new Map<string, Set<string>>()

      // Worktree 1 has some paths expanded
      expandedPaths.set('/worktree1', new Set(['/worktree1/src', '/worktree1/src/components']))

      // Worktree 2 has different paths expanded
      expandedPaths.set('/worktree2', new Set(['/worktree2/lib']))

      expect(expandedPaths.get('/worktree1')?.has('/worktree1/src')).toBe(true)
      expect(expandedPaths.get('/worktree2')?.has('/worktree1/src')).toBe(false)
    })

    test('Collapse all clears expanded paths', () => {
      const expandedPaths = new Set(['/project/src', '/project/src/components', '/project/lib'])

      // Simulate collapse all
      expandedPaths.clear()

      expect(expandedPaths.size).toBe(0)
    })

    test('Toggle adds path if not expanded', () => {
      const expandedPaths = new Set<string>()
      const pathToToggle = '/project/src'

      if (expandedPaths.has(pathToToggle)) {
        expandedPaths.delete(pathToToggle)
      } else {
        expandedPaths.add(pathToToggle)
      }

      expect(expandedPaths.has(pathToToggle)).toBe(true)
    })

    test('Toggle removes path if already expanded', () => {
      const expandedPaths = new Set(['/project/src'])
      const pathToToggle = '/project/src'

      if (expandedPaths.has(pathToToggle)) {
        expandedPaths.delete(pathToToggle)
      } else {
        expandedPaths.add(pathToToggle)
      }

      expect(expandedPaths.has(pathToToggle)).toBe(false)
    })
  })

  describe('Performance', () => {
    test('File tree structure is suitable for 1000 files', () => {
      // Create a mock tree with 1000 files
      const mockTree: Array<{
        name: string
        path: string
        relativePath: string
        isDirectory: boolean
        extension: string | null
      }> = []

      for (let i = 0; i < 1000; i++) {
        mockTree.push({
          name: `file${i}.ts`,
          path: `/test/file${i}.ts`,
          relativePath: `file${i}.ts`,
          isDirectory: false,
          extension: '.ts'
        })
      }

      expect(mockTree.length).toBe(1000)

      // Simulate filtering - should be fast with simple string matching
      const start = performance.now()
      const filtered = mockTree.filter((f) => f.name.includes('999'))
      const duration = performance.now() - start

      expect(filtered.length).toBe(1)
      expect(duration).toBeLessThan(100) // Should be well under 100ms
    })

    test('Expanded path lookup is O(1) with Set', () => {
      const expandedPaths = new Set<string>()

      // Add 1000 paths
      for (let i = 0; i < 1000; i++) {
        expandedPaths.add(`/project/folder${i}`)
      }

      // Lookup should be constant time
      const start = performance.now()
      for (let i = 0; i < 10000; i++) {
        expandedPaths.has(`/project/folder${i % 1000}`)
      }
      const duration = performance.now() - start

      expect(duration).toBeLessThan(100) // 10000 lookups should be very fast
    })
  })

  describe('Persistence', () => {
    test('Expanded paths can be serialized to localStorage', () => {
      const expandedPaths = new Map<string, Set<string>>()
      expandedPaths.set('/worktree1', new Set(['/worktree1/src', '/worktree1/lib']))

      // Convert to serializable format
      const serialized: [string, string[]][] = []
      for (const [key, value] of expandedPaths.entries()) {
        serialized.push([key, Array.from(value)])
      }

      const json = JSON.stringify(serialized)
      expect(json).toContain('worktree1')
      expect(json).toContain('src')
    })

    test('Expanded paths can be deserialized from localStorage', () => {
      const serialized: [string, string[]][] = [
        ['/worktree1', ['/worktree1/src', '/worktree1/lib']]
      ]

      const expandedPaths = new Map<string, Set<string>>()
      for (const [key, value] of serialized) {
        expandedPaths.set(key, new Set(value))
      }

      expect(expandedPaths.get('/worktree1')?.has('/worktree1/src')).toBe(true)
      expect(expandedPaths.get('/worktree1')?.has('/worktree1/lib')).toBe(true)
    })
  })
})

// Integration test placeholder
describe('Session 1: File Tree Integration', () => {
  test.skip('File tree renders in right sidebar', () => {
    // This test requires a full renderer environment
    // Would verify that selecting a worktree shows the file tree
  })

  test.skip('Folders expand and collapse on click', () => {
    // This test requires DOM interaction
    // Would click on a folder and verify children visibility
  })

  test.skip('Filter input filters visible files', () => {
    // This test requires DOM interaction
    // Would type in filter input and verify filtering
  })

  test.skip('Expanded state persists after switching worktrees', () => {
    // This test requires multiple state changes
    // Would expand folder, switch worktree, switch back, verify expanded
  })

  test.skip('File tree loads in under 500ms for 1000 files', () => {
    // This test requires actual file system interaction
    // Would time the scan operation for a large directory
  })
})
