// Read-only pieces of the Structure view, shared by the editor and the plain TableStructureView:
// section headings, the compact table, the properties list, foreign keys, triggers, and the
// CHECK / UNIQUE constraints (from the CREATE TABLE text and, for UNIQUE, from describe's
// indexes where the engine implements the constraint as one).

import type { DataTableDetails } from '@shared/data-projects/types'
import { cn } from '@/lib/utils'
import { formatBytes, formatCount } from '../../shared/format-utils'
import type { ConstraintRow } from './ddl-parse'

export function Section({
  title,
  count,
  actions,
  children,
  testId
}: {
  title: string
  count?: number
  actions?: React.ReactNode
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <section className="mb-5" data-testid={testId}>
      <div className="mb-1.5 flex min-h-6 items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal">{count}</span>}
        </h3>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function SimpleTable({
  headers,
  rows,
  testId,
  rowClassName,
  rowTestId
}: {
  headers: React.ReactNode[]
  rows: React.ReactNode[][]
  testId?: string
  rowClassName?: (index: number) => string | undefined
  rowTestId?: (index: number) => string | undefined
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-[12px]" data-testid={testId}>
        <thead className="bg-card">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-medium text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr
              key={i}
              className={cn('border-b border-border/60 align-top last:border-0', rowClassName?.(i))}
              data-testid={rowTestId?.(i)}
            >
              {cells.map((cell, k) => (
                <td key={k} className="px-2 py-1">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Monospaced text, or a dim dash when there is none. */
export function Mono({ text }: { text: string | null | undefined }): React.JSX.Element {
  return text ? (
    <span className="font-mono">{text}</span>
  ) : (
    <span className="text-muted-foreground/60">—</span>
  )
}

export function PropertiesSection({
  details
}: {
  details: DataTableDetails
}): React.JSX.Element | null {
  const facts: Array<[string, string]> = []
  if (details.engine) facts.push(['Engine', details.engine])
  if (details.rowEstimate !== undefined && details.rowEstimate !== null)
    facts.push(['Rows (estimate)', formatCount(details.rowEstimate)])
  if (details.sizeBytes !== undefined && details.sizeBytes !== null)
    facts.push(['Size', formatBytes(details.sizeBytes)])
  for (const p of details.properties ?? []) facts.push([p.label, p.value])
  if (details.comment) facts.push(['Comment', details.comment])
  if (!facts.length) return null
  return (
    <Section title="Properties">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-pre-wrap break-words font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

export function ForeignKeysSection({ details }: { details: DataTableDetails }): React.JSX.Element {
  return (
    <Section title="Foreign keys" count={details.foreignKeys.length}>
      {details.foreignKeys.length ? (
        <SimpleTable
          testId="data-project-structure-fks"
          headers={['Name', 'Columns', 'References', 'On update', 'On delete']}
          rows={details.foreignKeys.map((fk) => [
            <Mono text={fk.name} />,
            <Mono text={fk.columns.join(', ')} />,
            <Mono
              text={`${[fk.refDatabase, fk.refSchema, fk.refTable].filter(Boolean).join('.')}(${fk.refColumns.join(', ')})`}
            />,
            fk.onUpdate ?? '',
            fk.onDelete ?? ''
          ])}
        />
      ) : (
        <p className="text-[12px] text-muted-foreground">No foreign keys.</p>
      )}
    </Section>
  )
}

export function TriggersSection({ details }: { details: DataTableDetails }): React.JSX.Element {
  return (
    <Section title="Triggers" count={details.triggers.length}>
      {details.triggers.length ? (
        <SimpleTable
          testId="data-project-structure-triggers"
          headers={['Name', 'Definition']}
          rows={details.triggers.map((t) => [
            <Mono text={t.name} />,
            <pre key="d" className="whitespace-pre-wrap break-words font-mono text-[11px]">
              {t.definition ?? ''}
            </pre>
          ])}
        />
      ) : (
        <p className="text-[12px] text-muted-foreground">No triggers.</p>
      )}
    </Section>
  )
}

export function ConstraintsSection({ rows }: { rows: ConstraintRow[] }): React.JSX.Element | null {
  if (!rows.length) return null
  return (
    <Section title="Constraints" count={rows.length} testId="data-project-structure-constraints">
      <SimpleTable
        testId="data-project-structure-constraints-table"
        headers={['Type', 'Name', 'Definition', 'Column']}
        rows={rows.map((r) => [
          <span
            key="k"
            className="rounded-[4px] bg-secondary px-1.5 py-[1px] text-[10px] font-semibold tracking-[0.04em] text-muted-foreground"
          >
            {r.kind}
          </span>,
          <Mono text={r.name} />,
          <span key="d" className="whitespace-pre-wrap break-words font-mono">
            {r.definition}
          </span>,
          <Mono text={r.column ?? null} />
        ])}
      />
    </Section>
  )
}
