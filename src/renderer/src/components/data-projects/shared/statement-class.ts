// Label and colours of each statement class (READ / WRITE / DDL / ADMIN / LOCK / ...).

import type { DataStatementClass } from '@shared/data-projects/types'

export const STATEMENT_CLASS_STYLE: Readonly<
  Record<DataStatementClass, { label: string; className: string }>
> = {
  read: { label: 'READ', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  session: { label: 'SESSION', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  tx: { label: 'TX', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  lock: { label: 'LOCK', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  write: { label: 'WRITE', className: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
  ddl: { label: 'DDL', className: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
  admin: { label: 'ADMIN', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  unknown: { label: 'UNKNOWN', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300' }
}
