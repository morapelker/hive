import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useHintStore, useProjectStore, useSpaceStore, useFilterStore } from '@/stores'
import { COLON_COMMANDS } from '@/stores/useFilterStore'
import { dispatchHintAction } from '@/lib/hint-utils'
import { parseFilterInput } from '@/lib/colon-command-parser'
import { ColonCommandPopover, type ColonCommandItem } from './ColonCommandPopover'
import { LanguageIcon } from './LanguageIcon'

interface ProjectFilterProps {
  value: string
  onChange: (value: string) => void
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  // Popover state
  const [popoverMode, setPopoverMode] = useState<'command' | 'value' | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [activeCommand, setActiveCommand] = useState<string | null>(null)

  // Filter store
  const activeLanguages = useFilterStore((s) => s.activeLanguages)
  const addLanguage = useFilterStore((s) => s.addLanguage)

  // Projects for language detection
  const projects = useProjectStore((s) => s.projects)
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)
  const projectSpaceMap = useSpaceStore((s) => s.projectSpaceMap)

  // Get space-filtered projects for language options
  const spaceFilteredProjects = useMemo(() => {
    if (activeSpaceId === null) return projects
    const allowedIds = new Set(
      Object.entries(projectSpaceMap)
        .filter(([, spaceIds]) => spaceIds.includes(activeSpaceId))
        .map(([projectId]) => projectId)
    )
    return projects.filter((p) => allowedIds.has(p.id))
  }, [projects, activeSpaceId, projectSpaceMap])

  // Build popover items based on mode
  const popoverItems: ColonCommandItem[] = useMemo(() => {
    if (popoverMode === 'command') {
      const parsed = parseFilterInput(value)
      const filter = parsed.commandFilter?.toLowerCase() ?? ''
      return COLON_COMMANDS
        .filter((c) => c.name.toLowerCase().startsWith(filter))
        .map((c) => ({ key: c.name, label: c.displayName }))
    }

    if (popoverMode === 'value' && activeCommand) {
      const cmd = COLON_COMMANDS.find((c) => c.name === activeCommand)
      if (!cmd) return []

      const parsed = parseFilterInput(value)
      const filter = parsed.valueFilter?.toLowerCase() ?? ''

      // Get all available options, exclude already-selected
      const allOptions = cmd.getOptions(spaceFilteredProjects)
      const excludeSet = new Set(activeLanguages)
      const available = allOptions.filter((opt) => !excludeSet.has(opt))

      // Count projects per language for sorting
      const langCounts = new Map<string, number>()
      for (const p of spaceFilteredProjects) {
        if (p.language && available.includes(p.language)) {
          langCounts.set(p.language, (langCounts.get(p.language) ?? 0) + 1)
        }
      }

      return available
        .filter((opt) => opt.toLowerCase().startsWith(filter))
        .sort((a, b) => (langCounts.get(b) ?? 0) - (langCounts.get(a) ?? 0))
        .map((opt) => ({
          key: opt,
          label: opt,
          icon: <LanguageIcon language={opt} />
        }))
    }

    return []
  }, [popoverMode, activeCommand, value, spaceFilteredProjects, activeLanguages])

  // Reset selected index when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [popoverItems])

  // Handle input changes — parse and update popover mode
  const handleChange = useCallback(
    (newValue: string) => {
      onChange(newValue)

      const parsed = parseFilterInput(newValue)

      if (parsed.type === 'command-search') {
        setPopoverMode('command')
        setActiveCommand(null)
      } else if (parsed.type === 'value-search' && parsed.command) {
        setPopoverMode('value')
        setActiveCommand(parsed.command)
      } else {
        setPopoverMode(null)
        setActiveCommand(null)
      }
    },
    [onChange]
  )

  // Handle popover selection
  const handlePopoverSelect = useCallback(
    (key: string) => {
      if (popoverMode === 'command') {
        // Complete to :command=
        const newValue = `:${key}=`
        onChange(newValue)
        setPopoverMode('value')
        setActiveCommand(key)
        setSelectedIndex(0)
      } else if (popoverMode === 'value') {
        // Apply the filter
        addLanguage(key)
        onChange('')
        setPopoverMode(null)
        setActiveCommand(null)
        inputRef.current?.focus()
      }
    },
    [popoverMode, onChange, addLanguage]
  )

  const handlePopoverClose = useCallback(() => {
    setPopoverMode(null)
    setActiveCommand(null)
  }, [])

  useEffect(() => {
    const handleFocus = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('hive:focus-project-filter', handleFocus)
    return () => {
      window.removeEventListener('hive:focus-project-filter', handleFocus)
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // When popover is open, let the popover handle keyboard nav
    // Escape layering: first close popover, second clear + blur
    if (e.key === 'Escape') {
      if (popoverMode !== null) {
        // Popover capture-phase handler will close it; but we also need to
        // prevent the default blur behavior here
        return
      }
      onChange('')
      inputRef.current?.blur()
      return
    }

    // When popover is open, skip hint logic entirely
    if (popoverMode !== null) return

    // Ignore key-repeat events — they would re-enter the pending branch with the
    // same uppercase letter and immediately match the 'Aa'-style first hint.
    if (e.repeat) return

    if (!value) return

    // Skip hint logic when input starts with ':'
    if (value.startsWith(':')) return

    const { mode, pendingChar, hintMap, enterPending, exitPending, actionMode, setActionMode } =
      useHintStore.getState()
    const isUppercase = /^[A-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey

    if (mode === 'idle' && isUppercase) {
      e.preventDefault()
      enterPending(e.key)
    } else if (mode === 'pending') {
      // Ignore bare modifier keys so the user can press Shift+P / Shift+D
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return
      }

      // Toggle pin/archive action mode (mirrors vim navigation P/D interception)
      if (e.key === 'P') {
        setActionMode(actionMode === 'pin' ? 'select' : 'pin')
        e.preventDefault()
        return
      }
      if (e.key === 'D') {
        setActionMode(actionMode === 'archive' ? 'select' : 'archive')
        e.preventDefault()
        return
      }

      // Find entry where code[0] === pendingChar and code[1] === e.key.toLowerCase()
      const lowerKey = e.key.toLowerCase()
      let matchedKey: string | null = null
      for (const [k, code] of hintMap) {
        if (code[0] === pendingChar && code[1] === lowerKey) {
          matchedKey = k
          break
        }
      }

      if (matchedKey !== null) {
        e.preventDefault()
        dispatchHintAction(matchedKey, actionMode)
        exitPending()
      } else if (isUppercase) {
        e.preventDefault()
        enterPending(e.key)
      } else {
        exitPending()
      }
    }
  }

  const handleFocus = (): void => {
    useHintStore.getState().setInputFocused(true)
  }

  const handleBlur = (): void => {
    useHintStore.getState().exitPending()
    useHintStore.getState().setInputFocused(false)
  }

  return (
    <div className="relative flex items-center">
      <Search className="absolute left-3.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="Filter projects..."
        className="h-8 w-full text-sm px-2 pl-8 pr-12 rounded-md border border-input bg-transparent placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        data-testid="project-filter-input"
      />
      {value ? (
        <button
          onClick={() => {
            handleChange('')
            inputRef.current?.focus()
          }}
          className="absolute right-3.5 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground"
          data-testid="project-filter-clear"
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        <kbd className="absolute right-2 pointer-events-none text-[10px] text-muted-foreground/60 bg-muted/50 border border-border/50 rounded px-1 py-0.5 font-sans">
          ⌘G
        </kbd>
      )}
      <ColonCommandPopover
        visible={popoverMode !== null}
        items={popoverItems}
        selectedIndex={selectedIndex}
        onSelectedIndexChange={setSelectedIndex}
        onSelect={handlePopoverSelect}
        onClose={handlePopoverClose}
        emptyMessage={
          popoverMode === 'command' ? 'No matching commands' : 'No matching languages'
        }
      />
    </div>
  )
}
