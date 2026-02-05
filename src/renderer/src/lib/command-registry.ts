import { type Command, type CommandCategory } from '@/stores/useCommandPaletteStore'

// Platform detection for shortcut display
const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

// Helper to format shortcuts for display
export function formatShortcut(key: string, modifiers: string[] = []): string {
  const modSymbols = modifiers.map((mod) => {
    switch (mod) {
      case 'meta':
        return isMac ? '⌘' : 'Ctrl'
      case 'ctrl':
        return isMac ? '⌃' : 'Ctrl'
      case 'alt':
        return isMac ? '⌥' : 'Alt'
      case 'shift':
        return isMac ? '⇧' : 'Shift'
      default:
        return mod
    }
  })
  return [...modSymbols, key.toUpperCase()].join(isMac ? '' : '+')
}

// Command registry - holds all available commands
class CommandRegistry {
  private commands: Map<string, Command> = new Map()
  private listeners: Set<() => void> = new Set()

  // Register a command
  register(command: Command): void {
    this.commands.set(command.id, command)
    this.notifyListeners()
  }

  // Register multiple commands
  registerMany(commands: Command[]): void {
    commands.forEach((cmd) => this.commands.set(cmd.id, cmd))
    this.notifyListeners()
  }

  // Unregister a command
  unregister(commandId: string): void {
    this.commands.delete(commandId)
    this.notifyListeners()
  }

  // Get a command by ID
  get(commandId: string): Command | undefined {
    return this.commands.get(commandId)
  }

  // Get all commands
  getAll(): Command[] {
    return Array.from(this.commands.values())
  }

  // Get commands by category
  getByCategory(category: CommandCategory): Command[] {
    return this.getAll().filter((cmd) => cmd.category === category)
  }

  // Get visible commands
  getVisible(): Command[] {
    return this.getAll().filter((cmd) => !cmd.isVisible || cmd.isVisible())
  }

  // Subscribe to changes
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener())
  }
}

// Singleton instance
export const commandRegistry = new CommandRegistry()

// Fuzzy search helper
export function fuzzySearch(query: string, commands: Command[]): Command[] {
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
        // Exact match in label (highest priority)
        if (label.includes(term)) {
          score += label.startsWith(term) ? 100 : 50
        }
        // Match in keywords
        else if (keywords.some((k) => k.includes(term))) {
          score += 30
        }
        // Match in description
        else if (description.includes(term)) {
          score += 20
        }
        // Match in category
        else if (category.includes(term)) {
          score += 10
        }
        // No match for this term
        else {
          score -= 100
        }
      }

      return { command: cmd, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ command }) => command)
}

// Group commands by category for display
export function groupCommandsByCategory(commands: Command[]): Map<CommandCategory, Command[]> {
  const groups = new Map<CommandCategory, Command[]>()

  for (const cmd of commands) {
    const existing = groups.get(cmd.category) || []
    groups.set(cmd.category, [...existing, cmd])
  }

  return groups
}

// Category display names
export const categoryLabels: Record<CommandCategory, string> = {
  recent: 'Recent',
  navigation: 'Navigation',
  action: 'Actions',
  git: 'Git',
  settings: 'Settings',
  file: 'File'
}

// Category display order
export const categoryOrder: CommandCategory[] = [
  'recent',
  'navigation',
  'action',
  'git',
  'settings',
  'file'
]
