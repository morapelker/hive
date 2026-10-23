// READ / WRITE / DDL / ADMIN / LOCK / SESSION / TX / UNKNOWN badge for a classified statement,
// used by the confirm dialog, the messages list and the history panel.

import type { DataStatementClass } from '@shared/data-projects/types'
import { cn } from '@/lib/utils'
import { STATEMENT_CLASS_STYLE } from './statement-class'

export function StatementBadge({
  classification,
  className
}: {
  classification: DataStatementClass
  className?: string
}): React.JSX.Element {
  const style = STATEMENT_CLASS_STYLE[classification] ?? STATEMENT_CLASS_STYLE.unknown
  return (
    <span
      data-testid={`data-project-statement-badge-${classification}`}
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-[4px] px-1.5 font-sans text-[10px] font-semibold tracking-[0.04em]',
        style.className,
        className
      )}
    >
      {style.label}
    </span>
  )
}
