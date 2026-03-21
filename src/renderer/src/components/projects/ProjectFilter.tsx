import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { useHintStore } from '@/stores'
import { dispatchHintAction } from '@/lib/hint-utils'

interface ProjectFilterProps {
  value: string
  onChange: (value: string) => void
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

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
    if (e.key === 'Escape') {
      onChange('')
      inputRef.current?.blur()
      return
    }

    // Ignore key-repeat events — they would re-enter the pending branch with the
    // same uppercase letter and immediately match the 'Aa'-style first hint.
    if (e.repeat) return

    if (!value) return

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
        onChange={(e) => onChange(e.target.value)}
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
            onChange('')
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
    </div>
  )
}
