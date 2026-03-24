import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

interface FileChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path?: string }
  diff?: string
}

function kindBadge(
  kind: FileChange['kind'],
  t: (key: string, params?: Record<string, string | number | boolean>) => string
) {
  switch (kind.type) {
    case 'add':
      return (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
          {t('toolViews.fileChange.add')}
        </span>
      )
    case 'delete':
      return (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
          {t('toolViews.fileChange.delete')}
        </span>
      )
    case 'update':
      return (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
          {t('toolViews.fileChange.update')}
        </span>
      )
    default:
      return (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400">
          {(kind as { type: string }).type}
        </span>
      )
  }
}

function classifyLine(
  line: string,
  kind: FileChange['kind']['type']
): { bg: string; color: string; prefix: string; testId?: string } {
  if (kind === 'add') {
    return {
      bg: 'bg-green-500/10',
      color: 'text-green-400',
      prefix: '+',
      testId: 'diff-added'
    }
  }
  if (kind === 'delete') {
    return {
      bg: 'bg-red-500/10',
      color: 'text-red-400',
      prefix: '-',
      testId: 'diff-removed'
    }
  }

  // update kind — parse unified diff prefixes
  if (line.startsWith('+')) {
    return {
      bg: 'bg-green-500/10',
      color: 'text-green-400',
      prefix: '+',
      testId: 'diff-added'
    }
  }
  if (line.startsWith('-')) {
    return {
      bg: 'bg-red-500/10',
      color: 'text-red-400',
      prefix: '-',
      testId: 'diff-removed'
    }
  }
  if (line.startsWith('@@')) {
    return { bg: '', color: 'text-zinc-500', prefix: ' ' }
  }
  return { bg: '', color: 'text-zinc-300', prefix: ' ' }
}

function parseDiffLines(diff: string, kind: FileChange['kind']['type']): string[] {
  const raw = diff.split('\n')
  if (kind === 'update') {
    return raw.filter((l) => !l.startsWith('---') && !l.startsWith('+++'))
  }
  return raw
}

function FileDiffSection({ change }: { change: FileChange }) {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)

  const allLines = change.diff ? parseDiffLines(change.diff, change.kind.type) : []
  const needsTruncation = allLines.length > MAX_PREVIEW_LINES
  const displayedLines =
    needsTruncation && !showAll ? allLines.slice(0, MAX_PREVIEW_LINES) : allLines
  const hiddenCount = allLines.length - displayedLines.length

  return (
    <div className="space-y-1.5">
      {/* File header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-zinc-200 break-all">{change.path}</span>
        {kindBadge(change.kind, t)}
        {change.kind.type === 'update' && change.kind.move_path && (
          <span className="text-[10px] text-zinc-400">
            &rarr; <span className="font-mono">{change.kind.move_path}</span>
          </span>
        )}
      </div>

      {/* Diff block */}
      {allLines.length > 0 ? (
        <div className="bg-zinc-900/50 rounded-md overflow-hidden">
          <div className="font-mono text-xs overflow-x-auto">
            {displayedLines.map((line, i) => {
              const { bg, color, prefix, testId } = classifyLine(line, change.kind.type)
              // For update diffs strip the original prefix character from display
              const content =
                change.kind.type === 'update' &&
                (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
                  ? line.slice(1)
                  : line
              return (
                <div
                  key={i}
                  className={cn('flex px-3 py-px', bg)}
                  {...(testId ? { 'data-testid': testId } : {})}
                >
                  <span className="text-zinc-600 select-none w-8 text-right pr-3 shrink-0">
                    {i + 1}
                  </span>
                  <span className={cn('select-none shrink-0 w-4', color)}>{prefix}</span>
                  <span className={cn('whitespace-pre-wrap break-all', color)}>
                    {content || ' '}
                  </span>
                </div>
              )
            })}
            {needsTruncation && !showAll && hiddenCount > 0 && (
              <div className="px-3 py-0.5 text-zinc-600 text-[10px]">
                {t('toolViews.fileChange.moreLines', { count: hiddenCount })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground text-xs italic">
          {t('toolViews.fileChange.noDiffContent')}
        </div>
      )}

      {/* Show all toggle */}
      {needsTruncation && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="flex items-center gap-1 mt-1 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
          data-testid="show-all-button"
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-150', showAll && 'rotate-180')}
          />
          {showAll
            ? t('toolViews.common.showLess')
            : t('toolViews.common.showAllLines', { count: allLines.length })}
        </button>
      )}
    </div>
  )
}

export function FileChangeToolView({ input, error }: ToolViewProps) {
  const { t } = useI18n()
  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all">{error}</div>
    )
  }

  const changes = input.changes as FileChange[] | undefined

  if (!Array.isArray(changes) || changes.length === 0) {
    return (
      <div data-testid="file-change-tool-view" className="text-muted-foreground text-xs italic">
        {t('toolViews.fileChange.noChanges')}
      </div>
    )
  }

  return (
    <div data-testid="file-change-tool-view" className="space-y-4">
      {changes.map((change, i) => (
        <FileDiffSection key={`${change.path}-${i}`} change={change} />
      ))}
    </div>
  )
}
