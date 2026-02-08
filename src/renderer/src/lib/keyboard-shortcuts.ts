// Platform detection
const isMac =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

// ==========================================
// Types
// ==========================================

export type ModifierKey = 'ctrl' | 'meta' | 'alt' | 'shift'

export interface KeyBinding {
  key: string // The key to press (lowercase), e.g. 'n', 'tab', ','
  modifiers: ModifierKey[] // Required modifier keys
}

export interface ShortcutDefinition {
  id: string
  label: string // Human-readable name, e.g. "New Session"
  description?: string
  category: ShortcutCategory
  defaultBinding: KeyBinding
}

export type ShortcutCategory =
  | 'session'
  | 'navigation'
  | 'git'
  | 'sidebar'
  | 'focus'
  | 'settings'

// ==========================================
// Default Shortcut Definitions
// ==========================================

export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  // Session shortcuts
  {
    id: 'session:new',
    label: 'New Session',
    description: 'Create a new chat session',
    category: 'session',
    defaultBinding: { key: 'n', modifiers: ['meta'] }
  },
  {
    id: 'session:close',
    label: 'Close Session',
    description: 'Close the current session tab (noop if none open)',
    category: 'session',
    defaultBinding: { key: 'w', modifiers: ['meta'] }
  },
  {
    id: 'session:mode-toggle',
    label: 'Toggle Build/Plan Mode',
    description: 'Switch between build and plan mode',
    category: 'session',
    defaultBinding: { key: 'Tab', modifiers: [] }
  },

  // Navigation shortcuts
  {
    id: 'nav:command-palette',
    label: 'Open Command Palette',
    description: 'Open the command palette',
    category: 'navigation',
    defaultBinding: { key: 'p', modifiers: ['meta'] }
  },
  {
    id: 'nav:session-history',
    label: 'Open Session History',
    description: 'Open the session history panel',
    category: 'navigation',
    defaultBinding: { key: 'k', modifiers: ['meta'] }
  },
  {
    id: 'nav:new-worktree',
    label: 'New Worktree',
    description: 'Create a new worktree for the current project',
    category: 'navigation',
    defaultBinding: { key: 'n', modifiers: ['meta', 'shift'] }
  },

  // Git shortcuts
  {
    id: 'git:commit',
    label: 'Focus Commit Form',
    description: 'Focus the git commit form',
    category: 'git',
    defaultBinding: { key: 'c', modifiers: ['meta', 'shift'] }
  },
  {
    id: 'git:push',
    label: 'Push to Remote',
    description: 'Push commits to the remote repository',
    category: 'git',
    defaultBinding: { key: 'p', modifiers: ['meta', 'shift'] }
  },
  {
    id: 'git:pull',
    label: 'Pull from Remote',
    description: 'Pull commits from the remote repository',
    category: 'git',
    defaultBinding: { key: 'l', modifiers: ['meta', 'shift'] }
  },

  // Sidebar shortcuts
  {
    id: 'sidebar:toggle-left',
    label: 'Toggle Left Sidebar',
    description: 'Show or hide the left sidebar',
    category: 'sidebar',
    defaultBinding: { key: 'b', modifiers: ['meta'] }
  },
  {
    id: 'sidebar:toggle-right',
    label: 'Toggle Right Sidebar',
    description: 'Show or hide the right sidebar',
    category: 'sidebar',
    defaultBinding: { key: 'b', modifiers: ['meta', 'shift'] }
  },

  // Focus shortcuts
  {
    id: 'focus:left-sidebar',
    label: 'Focus Left Sidebar',
    description: 'Move focus to the left sidebar',
    category: 'focus',
    defaultBinding: { key: '1', modifiers: ['meta'] }
  },
  {
    id: 'focus:main-pane',
    label: 'Focus Main Pane',
    description: 'Move focus to the main chat pane',
    category: 'focus',
    defaultBinding: { key: '2', modifiers: ['meta'] }
  },

  // Settings shortcuts
  {
    id: 'settings:open',
    label: 'Open Settings',
    description: 'Open the settings panel',
    category: 'settings',
    defaultBinding: { key: ',', modifiers: ['meta'] }
  }
]

// Build a map for fast lookup
const shortcutMap = new Map<string, ShortcutDefinition>()
DEFAULT_SHORTCUTS.forEach((s) => shortcutMap.set(s.id, s))

// ==========================================
// Utility Functions
// ==========================================

/**
 * Serialize a KeyBinding to a display string, e.g. "⌘N" or "Ctrl+Shift+N"
 */
export function formatBinding(binding: KeyBinding): string {
  const modSymbols = binding.modifiers.map((mod) => {
    switch (mod) {
      case 'meta':
        return isMac ? '\u2318' : 'Ctrl'
      case 'ctrl':
        return isMac ? '\u2303' : 'Ctrl'
      case 'alt':
        return isMac ? '\u2325' : 'Alt'
      case 'shift':
        return isMac ? '\u21E7' : 'Shift'
      default:
        return mod
    }
  })

  const keyDisplay = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  return [...modSymbols, keyDisplay].join(isMac ? '' : '+')
}

/**
 * Serialize a KeyBinding to a stable string for storage and comparison.
 * e.g. "meta+shift+n"
 */
export function serializeBinding(binding: KeyBinding): string {
  const sortedMods = [...binding.modifiers].sort()
  return [...sortedMods, binding.key.toLowerCase()].join('+')
}

/**
 * Deserialize a stored binding string back to a KeyBinding.
 */
export function deserializeBinding(serialized: string): KeyBinding {
  const parts = serialized.split('+')
  const key = parts.pop()!
  const modifiers = parts as ModifierKey[]
  return { key, modifiers }
}

/**
 * Check if a keyboard event matches a binding.
 * For cross-platform, treats both ctrl and meta as "command" when modifier is 'meta'.
 */
export function eventMatchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  // Check key (case-insensitive)
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false

  const ctrlRequired = binding.modifiers.includes('ctrl')
  const metaRequired = binding.modifiers.includes('meta')
  const altRequired = binding.modifiers.includes('alt')
  const shiftRequired = binding.modifiers.includes('shift')

  // For cross-platform, treat both ctrl and meta as the same "command" key
  const hasCtrlOrMeta = event.ctrlKey || event.metaKey
  const needsCtrlOrMeta = ctrlRequired || metaRequired

  if (needsCtrlOrMeta && !hasCtrlOrMeta) return false
  if (!needsCtrlOrMeta && hasCtrlOrMeta) return false
  if (altRequired && !event.altKey) return false
  if (!altRequired && event.altKey) return false
  if (shiftRequired && !event.shiftKey) return false
  if (!shiftRequired && event.shiftKey) return false

  return true
}

/**
 * Get a shortcut definition by ID.
 */
export function getShortcutDefinition(id: string): ShortcutDefinition | undefined {
  return shortcutMap.get(id)
}

/**
 * Get all shortcut definitions.
 */
export function getAllShortcutDefinitions(): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS
}

/**
 * Get shortcut definitions by category.
 */
export function getShortcutsByCategory(category: ShortcutCategory): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS.filter((s) => s.category === category)
}

/**
 * Detect conflicts between a proposed binding and existing bindings.
 * Returns the IDs of conflicting shortcuts.
 */
export function detectConflicts(
  proposedBinding: KeyBinding,
  currentBindings: Map<string, KeyBinding>,
  excludeId?: string
): string[] {
  const proposedSerialized = serializeBinding(proposedBinding)
  const conflicts: string[] = []

  for (const [id, binding] of currentBindings.entries()) {
    if (excludeId && id === excludeId) continue
    if (serializeBinding(binding) === proposedSerialized) {
      conflicts.push(id)
    }
  }

  return conflicts
}

// Category display labels
export const shortcutCategoryLabels: Record<ShortcutCategory, string> = {
  session: 'Sessions',
  navigation: 'Navigation',
  git: 'Git',
  sidebar: 'Sidebars',
  focus: 'Focus',
  settings: 'Settings'
}

// Category display order
export const shortcutCategoryOrder: ShortcutCategory[] = [
  'session',
  'navigation',
  'git',
  'sidebar',
  'focus',
  'settings'
]
