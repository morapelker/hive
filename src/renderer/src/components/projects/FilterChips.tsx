import { LanguageIcon } from './LanguageIcon'

interface FilterChipsProps {
  languages: string[]
  onRemove: (lang: string) => void
}

export function FilterChips({ languages, onRemove }: FilterChipsProps): React.JSX.Element | null {
  if (languages.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1">
      {languages.map((lang) => (
        <button
          key={lang}
          onClick={() => onRemove(lang)}
          title={lang}
          className="flex items-center justify-center h-6 w-6 rounded-md border border-border/50 bg-muted/50 hover:bg-destructive/20 hover:border-destructive/50 transition-colors cursor-pointer"
          data-testid={`filter-chip-${lang}`}
        >
          <LanguageIcon language={lang} />
        </button>
      ))}
    </div>
  )
}
