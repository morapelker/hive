import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

export function EditToolView({ input, error }: ToolViewProps) {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)

  const oldString = (input.oldString || input.old_string || '') as string
  const newString = (input.newString || input.new_string || '') as string

  if (error) {
    return (
      <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all">{error}</div>
    )
  }

  const oldLines = oldString ? oldString.split('\n') : []
  const newLines = newString ? newString.split('\n') : []
  const totalLines = oldLines.length + newLines.length
  const needsTruncation = totalLines > MAX_PREVIEW_LINES

  let displayedOld = oldLines
  let displayedNew = newLines
  if (needsTruncation && !showAll) {
    const half = Math.floor(MAX_PREVIEW_LINES / 2)
    displayedOld = oldLines.slice(0, Math.min(oldLines.length, half))
    const remaining = MAX_PREVIEW_LINES - displayedOld.length
    displayedNew = newLines.slice(0, Math.min(newLines.length, remaining))
  }

  return (
    <div data-testid="edit-tool-view">
      {/* Change summary */}
      {(oldLines.length > 0 || newLines.length > 0) && (
        <div className="text-[10px] mb-1.5 flex items-center gap-2">
          {oldLines.length > 0 && (
            <span className="text-red-400/70">
              -
              {t('toolViews.edit.lineCount', {
                count: oldLines.length,
                label:
                  oldLines.length === 1
                    ? t('toolViews.edit.lineSingular')
                    : t('toolViews.edit.linePlural')
              })}
            </span>
          )}
          {newLines.length > 0 && (
            <span className="text-green-400/70">
              +
              {t('toolViews.edit.lineCount', {
                count: newLines.length,
                label:
                  newLines.length === 1
                    ? t('toolViews.edit.lineSingular')
                    : t('toolViews.edit.linePlural')
              })}
            </span>
          )}
        </div>
      )}

      {/* Diff block */}
      <div className="bg-zinc-900/50 rounded-md overflow-hidden">
        <div className="font-mono text-xs overflow-x-auto">
          {/* Removed lines */}
          {displayedOld.map((line, i) => (
            <div
              key={`old-${i}`}
              className="flex bg-red-500/10 px-3 py-px"
              data-testid="diff-removed"
            >
              <span className="text-zinc-600 select-none w-8 text-right pr-3 shrink-0">
                {i + 1}
              </span>
              <span className="text-red-400 select-none shrink-0 w-4">-</span>
              <span className="text-red-400 whitespace-pre-wrap break-all">{line || ' '}</span>
            </div>
          ))}
          {needsTruncation && !showAll && displayedOld.length < oldLines.length && (
            <div className="px-3 py-0.5 text-zinc-600 text-[10px]">
              {t('toolViews.edit.moreRemoved', { count: oldLines.length - displayedOld.length })}
            </div>
          )}

          {/* Added lines */}
          {displayedNew.map((line, i) => (
            <div
              key={`new-${i}`}
              className="flex bg-green-500/10 px-3 py-px"
              data-testid="diff-added"
            >
              <span className="text-zinc-600 select-none w-8 text-right pr-3 shrink-0">
                {i + 1}
              </span>
              <span className="text-green-400 select-none shrink-0 w-4">+</span>
              <span className="text-green-400 whitespace-pre-wrap break-all">{line || ' '}</span>
            </div>
          ))}
          {needsTruncation && !showAll && displayedNew.length < newLines.length && (
            <div className="px-3 py-0.5 text-zinc-600 text-[10px]">
              {t('toolViews.edit.moreAdded', { count: newLines.length - displayedNew.length })}
            </div>
          )}
        </div>
      </div>

      {/* Empty diff */}
      {oldLines.length === 0 && newLines.length === 0 && (
        <div className="text-muted-foreground text-xs italic">{t('toolViews.edit.noChanges')}</div>
      )}

      {/* Show all button */}
      {needsTruncation && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="flex items-center gap-1 mt-2 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
          data-testid="show-all-button"
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform duration-150', showAll && 'rotate-180')}
          />
          {showAll
            ? t('toolViews.common.showLess')
            : t('toolViews.common.showAllLines', { count: totalLines })}
        </button>
      )}
    </div>
  )
}
