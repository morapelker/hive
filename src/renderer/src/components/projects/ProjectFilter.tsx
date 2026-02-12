import { useRef } from 'react'
import { Search, X } from 'lucide-react'

interface ProjectFilterProps {
  value: string
  onChange: (value: string) => void
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onChange('')
      inputRef.current?.blur()
    }
  }

  return (
    <div className="relative flex items-center px-2 pb-1.5">
      <Search className="absolute left-3.5 h-3 w-3 text-muted-foreground pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Filter projects..."
        className="h-7 w-full text-xs px-2 pl-6 rounded-md border border-input bg-transparent placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        data-testid="project-filter-input"
      />
      {value && (
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
      )}
    </div>
  )
}
