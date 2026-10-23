// Wizard step 1: pick the engine from six logo cards, or paste a connection URL / DSN / SQLite
// path. A pasted URL is parsed locally (shared parser, no round trip), its engine detected and
// the wizard jumps straight to the connection fields with everything filled in.

import { useState } from 'react'
import { ClipboardPaste } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  DATA_ENGINE_INFO,
  DATA_ENGINES,
  type DataEngine,
  type DataParsedConnectionUrl
} from '@shared/data-projects/types'
import { parseConnectionUrl } from '@shared/data-projects/connection-url'
import { EngineTile } from '../engine-logos'
import { Field, SectionTitle, invalidProps } from './wizard-fields'

const ENGINE_HINT: Readonly<Record<DataEngine, string>> = {
  mysql: 'SQL · port 3306',
  mariadb: 'SQL · port 3306',
  postgres: 'SQL · port 5432',
  sqlite: 'SQL · local file',
  clickhouse: 'SQL · HTTP 8123',
  mongodb: 'Documents · port 27017'
}

export interface EngineStepProps {
  selected: DataEngine | null
  onPick: (engine: DataEngine) => void
  onParsed: (parsed: DataParsedConnectionUrl) => void
  initialUrl?: string
}

export function EngineStep({
  selected,
  onPick,
  onParsed,
  initialUrl
}: EngineStepProps): React.JSX.Element {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [error, setError] = useState<string | null>(null)

  const importUrl = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) {
      setError('Paste a connection URL first')
      return
    }
    const result = parseConnectionUrl(trimmed)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    onParsed(result.value)
  }

  return (
    <div className="flex flex-col gap-5" data-testid="data-project-wizard-engine-step">
      <div className="flex flex-col gap-2">
        <SectionTitle>Database</SectionTitle>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Database engine">
          {DATA_ENGINES.map((engine) => {
            const info = DATA_ENGINE_INFO[engine]
            const active = selected === engine
            return (
              <button
                key={engine}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onPick(engine)}
                className={cn(
                  'flex items-center gap-2.5 rounded-[9px] border px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'border-ring bg-accent'
                    : 'border-border hover:border-muted-foreground/40 hover:bg-accent/50'
                )}
                data-testid={`data-project-wizard-engine-${engine}`}
              >
                <EngineTile engine={engine} className="size-8 rounded-[7px]" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium">{info.label}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {ENGINE_HINT[engine]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>Or paste a connection URL</SectionTitle>
        <Field
          label="Connection URL"
          htmlFor="data-project-wizard-paste-url"
          error={error ?? undefined}
          hint="postgres://user:pass@host:5432/db, mysql://…, mongodb+srv://…, https://…:8443 (ClickHouse), or a .sqlite path. The password goes to secure storage."
        >
          <div className="flex items-center gap-1.5">
            <Input
              id="data-project-wizard-paste-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                if (error) setError(null)
              }}
              onPaste={(e) => {
                // Import as soon as something is pasted into an empty box.
                const pasted = e.clipboardData.getData('text')
                if (!url.trim() && pasted.trim()) {
                  e.preventDefault()
                  setUrl(pasted.trim())
                  importUrl(pasted)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.stopPropagation()
                  importUrl(url)
                }
              }}
              placeholder="postgres://user@db.example.com:5432/shop"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 font-mono text-[12px]"
              data-testid="data-project-wizard-paste-url"
              {...invalidProps('data-project-wizard-paste-url', error ?? undefined)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => importUrl(url)}
              data-testid="data-project-wizard-paste-url-import"
            >
              <ClipboardPaste className="size-3.5" />
              Import
            </Button>
          </div>
        </Field>
      </div>
    </div>
  )
}
