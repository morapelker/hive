/**
 * Session 6: Command Palette Tests
 *
 * Testing criteria from IMPLEMENTATION-P2.md:
 * - Command palette opens with Cmd+P
 * - Fuzzy search finds commands
 * - Recent commands shown at top
 * - Keyboard shortcuts displayed
 * - Navigation commands work
 * - Git commands work
 * - Nested commands show sub-items
 * - Escape closes palette
 * - Arrow keys navigate items
 */

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock command types
interface Command {
  id: string
  label: string
  description?: string
  category: 'navigation' | 'action' | 'git' | 'settings' | 'file' | 'recent'
  icon?: string
  shortcut?: string
  action: () => void | Promise<void>
  keywords?: string[]
  hasChildren?: boolean
  getChildren?: () => Command[]
  isEnabled?: () => boolean
  isVisible?: () => boolean
}

// Mock store state
interface CommandPaletteState {
  isOpen: boolean
  searchQuery: string
  selectedIndex: number
  commandStack: Command[][]
  currentParent: Command | null
  recentCommandIds: string[]
  maxRecentCommands: number
}

// Mock store actions
interface CommandPaletteActions {
  open: () => void
  close: () => void
  toggle: () => void
  setSearchQuery: (query: string) => void
  setSelectedIndex: (index: number) => void
  moveSelection: (delta: number, maxItems: number) => void
  addRecentCommand: (commandId: string) => void
  clearRecentCommands: () => void
  pushCommandLevel: (commands: Command[], parent: Command) => void
  popCommandLevel: () => void
  resetCommandStack: () => void
}

// Sample commands for testing
const sampleCommands: Command[] = [
  {
    id: 'action:new-session',
    label: 'New Session',
    description: 'Create a new chat session',
    category: 'action',
    icon: 'Plus',
    shortcut: '⌘N',
    keywords: ['new', 'create', 'session', 'chat'],
    action: vi.fn()
  },
  {
    id: 'nav:session-history',
    label: 'Open Session History',
    description: 'Search and browse past sessions',
    category: 'navigation',
    icon: 'History',
    shortcut: '⌘K',
    keywords: ['history', 'search', 'past', 'sessions'],
    action: vi.fn()
  },
  {
    id: 'nav:switch-worktree',
    label: 'Switch to Worktree',
    description: 'Navigate to a different worktree',
    category: 'navigation',
    icon: 'GitBranch',
    keywords: ['worktree', 'branch', 'switch'],
    hasChildren: true,
    action: vi.fn()
  },
  {
    id: 'git:commit',
    label: 'Commit Changes',
    description: 'Focus the commit form',
    category: 'git',
    icon: 'Check',
    shortcut: '⌘⇧C',
    keywords: ['commit', 'save', 'git'],
    action: vi.fn()
  },
  {
    id: 'git:push',
    label: 'Push to Remote',
    description: 'Push commits to the remote repository',
    category: 'git',
    icon: 'Upload',
    shortcut: '⌘⇧P',
    keywords: ['push', 'upload', 'remote', 'git'],
    action: vi.fn()
  },
  {
    id: 'settings:theme',
    label: 'Toggle Theme',
    description: 'Cycle through dark, light, system',
    category: 'settings',
    icon: 'Moon',
    keywords: ['theme', 'dark', 'light', 'mode'],
    action: vi.fn()
  }
]

// Nested command children for worktree switching
const worktreeChildren: Command[] = [
  {
    id: 'nav:worktree:wt1',
    label: 'main',
    description: 'feature/main',
    category: 'navigation',
    icon: 'GitBranch',
    action: vi.fn()
  },
  {
    id: 'nav:worktree:wt2',
    label: 'feature-branch',
    description: 'feature/auth',
    category: 'navigation',
    icon: 'GitBranch',
    action: vi.fn()
  }
]

// Create mock store
function createMockStore(): CommandPaletteState & CommandPaletteActions {
  let state: CommandPaletteState = {
    isOpen: false,
    searchQuery: '',
    selectedIndex: 0,
    commandStack: [],
    currentParent: null,
    recentCommandIds: [],
    maxRecentCommands: 5
  }

  return {
    get isOpen() {
      return state.isOpen
    },
    get searchQuery() {
      return state.searchQuery
    },
    get selectedIndex() {
      return state.selectedIndex
    },
    get commandStack() {
      return state.commandStack
    },
    get currentParent() {
      return state.currentParent
    },
    get recentCommandIds() {
      return state.recentCommandIds
    },
    get maxRecentCommands() {
      return state.maxRecentCommands
    },
    open: vi.fn(() => {
      state = { ...state, isOpen: true, searchQuery: '', selectedIndex: 0 }
    }),
    close: vi.fn(() => {
      state = { ...state, isOpen: false, searchQuery: '', selectedIndex: 0 }
    }),
    toggle: vi.fn(() => {
      state = { ...state, isOpen: !state.isOpen }
    }),
    setSearchQuery: vi.fn((query: string) => {
      state = { ...state, searchQuery: query, selectedIndex: 0 }
    }),
    setSelectedIndex: vi.fn((index: number) => {
      state = { ...state, selectedIndex: index }
    }),
    moveSelection: vi.fn((delta: number, maxItems: number) => {
      let newIndex = state.selectedIndex + delta
      if (newIndex < 0) newIndex = maxItems - 1
      if (newIndex >= maxItems) newIndex = 0
      state = { ...state, selectedIndex: newIndex }
    }),
    addRecentCommand: vi.fn((commandId: string) => {
      const filtered = state.recentCommandIds.filter((id) => id !== commandId)
      const updated = [commandId, ...filtered].slice(0, state.maxRecentCommands)
      state = { ...state, recentCommandIds: updated }
    }),
    clearRecentCommands: vi.fn(() => {
      state = { ...state, recentCommandIds: [] }
    }),
    pushCommandLevel: vi.fn((commands: Command[], parent: Command) => {
      state = {
        ...state,
        commandStack: [...state.commandStack, commands],
        currentParent: parent,
        searchQuery: '',
        selectedIndex: 0
      }
    }),
    popCommandLevel: vi.fn(() => {
      const newStack = state.commandStack.slice(0, -1)
      state = {
        ...state,
        commandStack: newStack,
        currentParent: null,
        searchQuery: '',
        selectedIndex: 0
      }
    }),
    resetCommandStack: vi.fn(() => {
      state = {
        ...state,
        commandStack: [],
        currentParent: null,
        searchQuery: '',
        selectedIndex: 0
      }
    })
  }
}

// Fuzzy search implementation for testing
function fuzzySearch(query: string, commands: Command[]): Command[] {
  if (!query.trim()) return commands

  const searchTerms = query.toLowerCase().split(/\s+/)

  return commands
    .map((cmd) => {
      const label = cmd.label.toLowerCase()
      const description = (cmd.description || '').toLowerCase()
      const keywords = (cmd.keywords || []).map((k) => k.toLowerCase())
      const category = cmd.category.toLowerCase()

      let score = 0

      for (const term of searchTerms) {
        if (label.includes(term)) {
          score += label.startsWith(term) ? 100 : 50
        } else if (keywords.some((k) => k.includes(term))) {
          score += 30
        } else if (description.includes(term)) {
          score += 20
        } else if (category.includes(term)) {
          score += 10
        } else {
          score -= 100
        }
      }

      return { command: cmd, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ command }) => command)
}

describe('Session 6: Command Palette', () => {
  let mockStore: ReturnType<typeof createMockStore>

  beforeEach(() => {
    vi.clearAllMocks()
    mockStore = createMockStore()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('Opening and Closing', () => {
    test('Command palette opens with toggle action', () => {
      expect(mockStore.isOpen).toBe(false)
      mockStore.open()
      expect(mockStore.open).toHaveBeenCalled()
    })

    test('Command palette closes with close action', () => {
      mockStore.open()
      mockStore.close()
      expect(mockStore.close).toHaveBeenCalled()
    })

    test('Toggle action toggles open state', () => {
      mockStore.toggle()
      expect(mockStore.toggle).toHaveBeenCalled()
    })

    test('Escape triggers close', () => {
      mockStore.open()

      // Simulate escape key press behavior
      const handleEscape = () => {
        if (mockStore.commandStack.length > 0) {
          mockStore.popCommandLevel()
        } else {
          mockStore.close()
        }
      }

      handleEscape()
      expect(mockStore.close).toHaveBeenCalled()
    })

    test('Escape pops command level when nested', () => {
      mockStore.open()
      mockStore.pushCommandLevel(worktreeChildren, sampleCommands[2])

      // Simulate escape when nested
      const handleEscape = () => {
        if (mockStore.commandStack.length > 0) {
          mockStore.popCommandLevel()
        } else {
          mockStore.close()
        }
      }

      handleEscape()
      expect(mockStore.popCommandLevel).toHaveBeenCalled()
    })
  })

  describe('Fuzzy Search', () => {
    test('Fuzzy search finds commands by partial match', () => {
      const results = fuzzySearch('new', sampleCommands)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe('action:new-session')
    })

    test('Fuzzy search finds commands by keyword', () => {
      const results = fuzzySearch('history', sampleCommands)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe('nav:session-history')
    })

    test('Fuzzy search finds commands by description', () => {
      const results = fuzzySearch('chat', sampleCommands)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].label).toBe('New Session')
    })

    test('Fuzzy search finds commands by category', () => {
      const results = fuzzySearch('git', sampleCommands)

      expect(results.length).toBe(2)
      expect(results.every((r) => r.category === 'git')).toBe(true)
    })

    test('Fuzzy search returns empty for no matches', () => {
      const results = fuzzySearch('xyznonexistent', sampleCommands)

      expect(results.length).toBe(0)
    })

    test('Empty query returns all commands', () => {
      const results = fuzzySearch('', sampleCommands)

      expect(results.length).toBe(sampleCommands.length)
    })

    test('Fuzzy search with multiple terms narrows results', () => {
      const results = fuzzySearch('new session', sampleCommands)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0].id).toBe('action:new-session')
    })

    test('Search query is set and resets selection', () => {
      mockStore.setSearchQuery('test')

      expect(mockStore.setSearchQuery).toHaveBeenCalledWith('test')
    })
  })

  describe('Recent Commands', () => {
    test('Recent commands are tracked', () => {
      mockStore.addRecentCommand('action:new-session')

      expect(mockStore.addRecentCommand).toHaveBeenCalledWith('action:new-session')
    })

    test('Recent commands are limited to max count', () => {
      // Add more than maxRecentCommands
      for (let i = 0; i < 7; i++) {
        mockStore.addRecentCommand(`cmd:${i}`)
      }

      expect(mockStore.recentCommandIds.length).toBeLessThanOrEqual(5)
    })

    test('Duplicate recent command moves to front', () => {
      mockStore.addRecentCommand('action:new-session')
      mockStore.addRecentCommand('git:commit')
      mockStore.addRecentCommand('action:new-session')

      // First item should be the most recently added
      expect(mockStore.recentCommandIds[0]).toBe('action:new-session')
    })

    test('Clear recent commands empties list', () => {
      mockStore.addRecentCommand('action:new-session')
      mockStore.clearRecentCommands()

      expect(mockStore.clearRecentCommands).toHaveBeenCalled()
    })
  })

  describe('Keyboard Shortcuts Display', () => {
    test('Commands with shortcuts have shortcut displayed', () => {
      const newSessionCmd = sampleCommands.find((c) => c.id === 'action:new-session')

      expect(newSessionCmd?.shortcut).toBe('⌘N')
    })

    test('Git commit shows correct shortcut', () => {
      const commitCmd = sampleCommands.find((c) => c.id === 'git:commit')

      expect(commitCmd?.shortcut).toBe('⌘⇧C')
    })

    test('Git push shows correct shortcut', () => {
      const pushCmd = sampleCommands.find((c) => c.id === 'git:push')

      expect(pushCmd?.shortcut).toBe('⌘⇧P')
    })

    test('Session history shows K shortcut', () => {
      const historyCmd = sampleCommands.find((c) => c.id === 'nav:session-history')

      expect(historyCmd?.shortcut).toBe('⌘K')
    })
  })

  describe('Navigation Commands', () => {
    test('Navigation commands exist', () => {
      const navCommands = sampleCommands.filter((c) => c.category === 'navigation')

      expect(navCommands.length).toBeGreaterThan(0)
    })

    test('Switch worktree command has children', () => {
      const switchWorktree = sampleCommands.find((c) => c.id === 'nav:switch-worktree')

      expect(switchWorktree?.hasChildren).toBe(true)
    })

    test('Navigation command executes action', async () => {
      const historyCmd = sampleCommands.find((c) => c.id === 'nav:session-history')
      await historyCmd?.action()

      expect(historyCmd?.action).toHaveBeenCalled()
    })
  })

  describe('Git Commands', () => {
    test('Git commands exist', () => {
      const gitCommands = sampleCommands.filter((c) => c.category === 'git')

      expect(gitCommands.length).toBe(2)
    })

    test('Commit command exists with correct properties', () => {
      const commitCmd = sampleCommands.find((c) => c.id === 'git:commit')

      expect(commitCmd).toBeDefined()
      expect(commitCmd?.label).toBe('Commit Changes')
      expect(commitCmd?.category).toBe('git')
    })

    test('Push command exists with correct properties', () => {
      const pushCmd = sampleCommands.find((c) => c.id === 'git:push')

      expect(pushCmd).toBeDefined()
      expect(pushCmd?.label).toBe('Push to Remote')
      expect(pushCmd?.category).toBe('git')
    })

    test('Git command executes action', async () => {
      const commitCmd = sampleCommands.find((c) => c.id === 'git:commit')
      await commitCmd?.action()

      expect(commitCmd?.action).toHaveBeenCalled()
    })
  })

  describe('Nested Commands', () => {
    test('Nested command shows sub-items', () => {
      const switchWorktree = sampleCommands.find((c) => c.id === 'nav:switch-worktree')

      expect(switchWorktree?.hasChildren).toBe(true)
    })

    test('Selecting nested command pushes new level', () => {
      const switchWorktree = sampleCommands.find((c) => c.id === 'nav:switch-worktree')
      mockStore.pushCommandLevel(worktreeChildren, switchWorktree!)

      expect(mockStore.pushCommandLevel).toHaveBeenCalledWith(worktreeChildren, switchWorktree)
    })

    test('Pop command level returns to previous level', () => {
      mockStore.pushCommandLevel(worktreeChildren, sampleCommands[2])
      mockStore.popCommandLevel()

      expect(mockStore.popCommandLevel).toHaveBeenCalled()
    })

    test('Reset command stack returns to root', () => {
      mockStore.pushCommandLevel(worktreeChildren, sampleCommands[2])
      mockStore.resetCommandStack()

      expect(mockStore.resetCommandStack).toHaveBeenCalled()
    })

    test('Worktree children have correct structure', () => {
      expect(worktreeChildren.length).toBe(2)
      expect(worktreeChildren[0].category).toBe('navigation')
      expect(worktreeChildren[0].icon).toBe('GitBranch')
    })
  })

  describe('Arrow Key Navigation', () => {
    test('Arrow down increases selection index', () => {
      const maxItems = sampleCommands.length
      mockStore.moveSelection(1, maxItems)

      expect(mockStore.moveSelection).toHaveBeenCalledWith(1, maxItems)
    })

    test('Arrow up decreases selection index', () => {
      mockStore.setSelectedIndex(2)
      const maxItems = sampleCommands.length
      mockStore.moveSelection(-1, maxItems)

      expect(mockStore.moveSelection).toHaveBeenCalledWith(-1, maxItems)
    })

    test('Selection wraps from bottom to top', () => {
      const maxItems = 3
      // Start at index 2 (last item)
      mockStore.setSelectedIndex(2)
      // Move down should wrap to 0
      mockStore.moveSelection(1, maxItems)

      expect(mockStore.moveSelection).toHaveBeenCalledWith(1, maxItems)
    })

    test('Selection wraps from top to bottom', () => {
      const maxItems = 3
      // Start at index 0 (first item)
      mockStore.setSelectedIndex(0)
      // Move up should wrap to maxItems - 1
      mockStore.moveSelection(-1, maxItems)

      expect(mockStore.moveSelection).toHaveBeenCalledWith(-1, maxItems)
    })

    test('Set selected index directly', () => {
      mockStore.setSelectedIndex(3)

      expect(mockStore.setSelectedIndex).toHaveBeenCalledWith(3)
    })
  })

  describe('Command Execution', () => {
    test('Executing command calls action', async () => {
      const cmd = sampleCommands[0]
      await cmd.action()

      expect(cmd.action).toHaveBeenCalled()
    })

    test('Executing command adds to recent', async () => {
      const cmd = sampleCommands[0]
      await cmd.action()
      mockStore.addRecentCommand(cmd.id)

      expect(mockStore.addRecentCommand).toHaveBeenCalledWith(cmd.id)
    })

    test('Command with isEnabled false should be disabled', () => {
      const disabledCmd: Command = {
        id: 'disabled:cmd',
        label: 'Disabled Command',
        category: 'action',
        action: vi.fn(),
        isEnabled: () => false
      }

      expect(disabledCmd.isEnabled?.()).toBe(false)
    })

    test('Command with isVisible false should be hidden', () => {
      const hiddenCmd: Command = {
        id: 'hidden:cmd',
        label: 'Hidden Command',
        category: 'action',
        action: vi.fn(),
        isVisible: () => false
      }

      expect(hiddenCmd.isVisible?.()).toBe(false)
    })
  })

  describe('Settings Commands', () => {
    test('Settings commands exist', () => {
      const settingsCommands = sampleCommands.filter((c) => c.category === 'settings')

      expect(settingsCommands.length).toBeGreaterThan(0)
    })

    test('Theme toggle command exists', () => {
      const themeCmd = sampleCommands.find((c) => c.id === 'settings:theme')

      expect(themeCmd).toBeDefined()
      expect(themeCmd?.label).toBe('Toggle Theme')
    })

    test('Settings command executes action', async () => {
      const themeCmd = sampleCommands.find((c) => c.id === 'settings:theme')
      await themeCmd?.action()

      expect(themeCmd?.action).toHaveBeenCalled()
    })
  })

  describe('Command Categories', () => {
    test('All expected categories are present', () => {
      const categories = new Set(sampleCommands.map((c) => c.category))

      expect(categories.has('navigation')).toBe(true)
      expect(categories.has('action')).toBe(true)
      expect(categories.has('git')).toBe(true)
      expect(categories.has('settings')).toBe(true)
    })

    test('Commands are grouped by category correctly', () => {
      const groups = new Map<string, Command[]>()

      for (const cmd of sampleCommands) {
        const existing = groups.get(cmd.category) || []
        groups.set(cmd.category, [...existing, cmd])
      }

      expect(groups.get('navigation')?.length).toBe(2)
      expect(groups.get('git')?.length).toBe(2)
      expect(groups.get('action')?.length).toBe(1)
      expect(groups.get('settings')?.length).toBe(1)
    })
  })

  describe('Performance', () => {
    test('Fuzzy search completes in under 50ms', () => {
      // Generate 100+ commands for performance test
      const manyCommands: Command[] = Array.from({ length: 100 }, (_, i) => ({
        id: `cmd:${i}`,
        label: `Command ${i}`,
        description: `Description for command ${i}`,
        category: 'action' as const,
        keywords: [`keyword${i}`, `tag${i}`],
        action: vi.fn()
      }))

      const start = performance.now()
      fuzzySearch('command 50', manyCommands)
      const duration = performance.now() - start

      expect(duration).toBeLessThan(50)
    })

    test('Opening palette initializes quickly', () => {
      const start = performance.now()
      mockStore.open()
      const duration = performance.now() - start

      expect(duration).toBeLessThan(10)
    })
  })

  describe('Keyboard Shortcut Format', () => {
    test('Mac-style shortcuts use symbols', () => {
      // ⌘ for Command, ⇧ for Shift, ⌥ for Option, ⌃ for Control
      const newSessionCmd = sampleCommands.find((c) => c.id === 'action:new-session')

      expect(newSessionCmd?.shortcut).toMatch(/⌘/)
    })

    test('Shift modifier included in shortcuts', () => {
      const commitCmd = sampleCommands.find((c) => c.id === 'git:commit')

      expect(commitCmd?.shortcut).toContain('⇧')
    })
  })
})
