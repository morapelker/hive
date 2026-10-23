// Inline editors of the structure grid. They look like plain text until hovered or focused (a
// border appears), so the Structure view reads like the read-only one and edits in place like
// TablePlus. The type and default fields are free text with a ▾ menu of suggestions (the
// dialect's types; NULL / '' / the current timestamp / "quote as text" for defaults).

import { forwardRef } from 'react'
import { ChevronDown } from 'lucide-react'
import type { SqlDialect } from '@shared/data-projects/types'
import { quoteSqlString, type SqlQuoteOptions } from '@shared/sql'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { typeCatalog } from './type-catalog'

export type CellTone = 'error' | 'warning' | null

export const cellInputClass =
  'h-6 w-full min-w-0 rounded-[4px] border border-transparent bg-transparent px-1 font-mono text-[12px] outline-none transition-colors placeholder:text-muted-foreground/50 hover:border-border focus:border-ring focus:bg-background disabled:cursor-default disabled:hover:border-transparent'

const toneClass = (tone: CellTone): string | false =>
  tone === 'error'
    ? 'border-red-500/70 hover:border-red-500/70'
    : tone === 'warning' && 'border-amber-500/70 hover:border-amber-500/70'

export interface CellInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  value: string
  onValueChange: (value: string) => void
  tone?: CellTone
  /** Shown as the tooltip; a problem message wins over the lock reason. */
  hint?: string
  'data-testid'?: string
}

export const CellInput = forwardRef<HTMLInputElement, CellInputProps>(function CellInput(
  { value, onValueChange, tone = null, hint, className, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      title={hint}
      aria-invalid={tone === 'error' || undefined}
      className={cn(cellInputClass, toneClass(tone), className)}
      {...props}
    />
  )
})

function SuggestionMenu({
  label,
  children,
  testId
}: {
  label: string
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          data-testid={testId}
          className="absolute right-0.5 top-1/2 flex h-5 w-4 -translate-y-1/2 items-center justify-center rounded-[3px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100 data-[state=open]:opacity-100"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-[210px] overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TypeInput({
  dialect,
  value,
  onValueChange,
  tableTypes,
  disabled,
  tone,
  hint,
  testId
}: {
  dialect: SqlDialect
  value: string
  onValueChange: (value: string) => void
  /** Types already used by the table's columns (offered first). */
  tableTypes: string[]
  disabled?: boolean
  tone?: CellTone
  hint?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div className="group/cell relative min-w-[120px]">
      <CellInput
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        tone={tone}
        hint={hint}
        placeholder="type"
        className="pr-5"
        data-testid={testId}
      />
      {!disabled && (
        <SuggestionMenu label="Pick a type" testId={testId && `${testId}-menu`}>
          {tableTypes.length > 0 && (
            <>
              <DropdownMenuLabel className="text-[11px]">In this table</DropdownMenuLabel>
              {tableTypes.map((t) => (
                <DropdownMenuItem
                  key={`t-${t}`}
                  className="font-mono text-[12px]"
                  onSelect={() => onValueChange(t)}
                >
                  {t}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          {typeCatalog(dialect).map((group, i) => (
            <div key={group.label}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-[11px]">{group.label}</DropdownMenuLabel>
              {group.types.map((t) => (
                <DropdownMenuItem
                  key={t}
                  className="font-mono text-[12px]"
                  onSelect={() => onValueChange(t)}
                  data-testid={`data-project-structure-type-option-${t}`}
                >
                  {t}
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </SuggestionMenu>
      )}
    </div>
  )
}

const NOW: Record<SqlDialect, string[]> = {
  postgres: ['CURRENT_TIMESTAMP', 'now()'],
  mysql: ['CURRENT_TIMESTAMP'],
  mariadb: ['CURRENT_TIMESTAMP'],
  sqlite: ['CURRENT_TIMESTAMP'],
  clickhouse: ['now()']
}

const isQuoted = (text: string): boolean => /^'.*'$/s.test(text.trim())

export function DefaultInput({
  dialect,
  value,
  onValueChange,
  disabled,
  tone,
  hint,
  testId,
  quoteOptions,
  noNowReason
}: {
  dialect: SqlDialect
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  tone?: CellTone
  hint?: string
  testId?: string
  /** MySQL / MariaDB: the session's backslash mode for "Quote as text". */
  quoteOptions?: SqlQuoteOptions
  /** Why the current-time presets are not offered (shown in their place). */
  noNowReason?: string
}): React.JSX.Element {
  const text = value.trim()
  const quoted = quoteSqlString(text, dialect, quoteOptions)
  return (
    <div className="group/cell relative min-w-[100px]">
      <CellInput
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        tone={tone}
        hint={hint ?? "SQL expression: quote text ('abc'), numbers and NULL as they are"}
        placeholder={disabled ? '' : 'no default'}
        className="pr-5"
        data-testid={testId}
      />
      {!disabled && (
        <SuggestionMenu label="Default presets" testId={testId && `${testId}-menu`}>
          <DropdownMenuItem className="text-[12px]" onSelect={() => onValueChange('')}>
            No default
          </DropdownMenuItem>
          <DropdownMenuItem
            className="font-mono text-[12px]"
            onSelect={() => onValueChange('NULL')}
          >
            NULL
          </DropdownMenuItem>
          <DropdownMenuItem className="text-[12px]" onSelect={() => onValueChange("''")}>
            Empty string{' '}
            <span className="ml-auto font-mono text-muted-foreground">&apos;&apos;</span>
          </DropdownMenuItem>
          {noNowReason ? (
            <DropdownMenuItem
              disabled
              className="max-w-[260px] whitespace-normal text-[11px] text-muted-foreground"
              data-testid={testId && `${testId}-no-now`}
            >
              {noNowReason}
            </DropdownMenuItem>
          ) : (
            NOW[dialect].map((expr) => (
              <DropdownMenuItem
                key={expr}
                className="font-mono text-[12px]"
                onSelect={() => onValueChange(expr)}
                data-testid={testId && `${testId}-now-${expr}`}
              >
                {expr}
              </DropdownMenuItem>
            ))
          )}
          {text && !isQuoted(text) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-[12px]"
                onSelect={() => onValueChange(quoted)}
                data-testid={testId && `${testId}-quote`}
              >
                Quote as text
                <span className="ml-auto max-w-[140px] truncate pl-3 font-mono text-muted-foreground">
                  {quoted}
                </span>
              </DropdownMenuItem>
            </>
          )}
        </SuggestionMenu>
      )}
    </div>
  )
}
