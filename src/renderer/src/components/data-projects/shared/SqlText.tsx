// Read-only syntax-highlighted SQL (confirm dialog, history, messages, preview of staged edits),
// rendered from the shared lexer so it tokenizes exactly like the classifier that judged it.
// Mongo shell text (dialect null) is shown plain.

import { memo, useMemo } from 'react'
import type { SqlDialect } from '@shared/data-projects/types'
import { lexSql, type SqlTokenType } from '@shared/sql'
import { cn } from '@/lib/utils'

const TOKEN_CLASS: Partial<Record<SqlTokenType, string>> = {
  keyword: 'text-violet-600 dark:text-violet-300',
  string: 'text-green-700 dark:text-green-300',
  number: 'text-orange-600 dark:text-orange-300',
  comment: 'italic text-muted-foreground',
  quoted_identifier: 'text-amber-700 dark:text-amber-200',
  parameter: 'text-rose-600 dark:text-rose-300',
  variable: 'text-rose-600 dark:text-rose-300',
  executable_comment: 'text-red-600 dark:text-red-400',
  operator: 'text-cyan-700 dark:text-cyan-300',
  delimiter: 'text-red-600 dark:text-red-400'
}

/** Above this size the text is shown without highlighting (lexing is cheap, DOM spans are not). */
const MAX_HIGHLIGHT = 20_000

export const SqlText = memo(function SqlText({
  text,
  dialect,
  className,
  'data-testid': testId
}: {
  text: string
  dialect: SqlDialect | null
  className?: string
  'data-testid'?: string
}): React.JSX.Element {
  const parts = useMemo(() => {
    if (!dialect || text.length > MAX_HIGHLIGHT) return null
    return lexSql(text, dialect).tokens.map((t) => ({ cls: TOKEN_CLASS[t.type], text: t.text }))
  }, [text, dialect])
  return (
    <pre
      data-testid={testId}
      className={cn(
        'whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5]',
        className
      )}
    >
      {parts
        ? parts.map((p, i) =>
            p.cls ? (
              <span key={i} className={p.cls}>
                {p.text}
              </span>
            ) : (
              p.text
            )
          )
        : text}
    </pre>
  )
})
