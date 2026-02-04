import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FileTreeFilterProps {
  value: string
  onChange: (value: string) => void
  className?: string
}

const DEBOUNCE_DELAY = 150

export function FileTreeFilter({ value, onChange, className }: FileTreeFilterProps): React.JSX.Element {
  const [localValue, setLocalValue] = useState(value)
  const debounceTimer = useRef<NodeJS.Timeout | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync local value with external value
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)

      // Clear existing timer
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
      }

      // Set new debounced update
      debounceTimer.current = setTimeout(() => {
        onChange(newValue)
      }, DEBOUNCE_DELAY)
    },
    [onChange]
  )

  const handleClear = useCallback(() => {
    setLocalValue('')
    onChange('')
    inputRef.current?.focus()
  }, [onChange])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (localValue) {
          handleClear()
        } else {
          inputRef.current?.blur()
        }
      }
    },
    [localValue, handleClear]
  )

  return (
    <div className={cn('relative', className)}>
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        ref={inputRef}
        type="text"
        placeholder="Filter files..."
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className={cn(
          'h-7 pl-7 pr-7 text-xs',
          'bg-background/50 border-border/50',
          'focus:bg-background focus:border-border'
        )}
        data-testid="file-tree-filter"
      />
      {localValue && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6 hover:bg-transparent"
          onClick={handleClear}
          title="Clear filter"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      )}
    </div>
  )
}
