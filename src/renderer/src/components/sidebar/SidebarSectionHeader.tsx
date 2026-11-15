import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SidebarCountPill } from './SidebarCountPill'
import {
  SECTION_HEADER_ACTIONS,
  SECTION_HEADER_CHEVRON,
  SECTION_HEADER_CHEVRON_BOX,
  SECTION_HEADER_CHEVRON_COLLAPSED,
  SECTION_HEADER_ICON_BOX,
  SECTION_HEADER_LABEL,
  SECTION_HEADER_LABEL_ROW,
  SECTION_HEADER_LABEL_WRAP,
  SECTION_HEADER_ROW,
  SECTION_HEADER_ROW_CLICKABLE,
  SECTION_HEADER_TITLE_SURFACE,
  SECTION_HEADER_WRAPPER_STICKY,
  SECTION_HEADER_WRAPPER_STICKY_TOP,
  getProjectGroupHeaderPaddingLeft
} from './orca-sidebar'

/**
 * Orca sidebar section header ("Pinned", "In progress", repo/project headers).
 * Markup + classes ported verbatim from orca
 * `worktree-list/rows/SectionHeader.tsx:171-390` (h-7 row, size-4 icon box,
 * 13px semibold label, hover-revealed actions cluster with the size-5 chevron)
 * plus the count pill from the pre-#4761 `SectionMetricsBadge`.
 */
export type SidebarSectionHeaderProps = {
  /** Glyph rendered inside the 16px rounded-[4px] icon box; size it `size-3`
   * (generic) or `size-3.5` (repo glyphs) and carry its own tone class. */
  icon?: React.ReactNode
  label: React.ReactNode
  /** Renders the orca count pill after the label. */
  count?: number
  /** What the count pill is read out as; the pill's own default counts "workspaces". */
  countLabel?: string
  /** Pins the header (orca: 'sticky z-20 bg-worktree-sidebar -top-px'). */
  sticky?: boolean
  /** Project-group depth; paddingLeft = 10 + min(depth, 6) * 10 (orca indentation.ts). */
  depth?: number
  /** Extra hover-revealed actions placed before the chevron in the actions cluster. */
  actions?: React.ReactNode
  /** Collapse state; when provided together with onToggle, the chevron renders. */
  expanded?: boolean
  onToggle?: () => void
  className?: string
  /** Section content rendered below the header row (caller gates on `expanded`). */
  children?: React.ReactNode
}

export function SidebarSectionHeader({
  icon,
  label,
  count,
  countLabel,
  sticky = false,
  depth = 0,
  actions,
  expanded,
  onToggle,
  className,
  children
}: SidebarSectionHeaderProps): React.JSX.Element {
  const collapsible = typeof expanded === 'boolean' && typeof onToggle !== 'undefined'

  return (
    <div
      className={cn(
        sticky && cn(SECTION_HEADER_WRAPPER_STICKY, SECTION_HEADER_WRAPPER_STICKY_TOP),
        className
      )}
    >
      <div
        role={collapsible ? 'button' : undefined}
        tabIndex={collapsible ? 0 : undefined}
        aria-expanded={collapsible ? expanded : undefined}
        className={cn(SECTION_HEADER_ROW, SECTION_HEADER_ROW_CLICKABLE)}
        style={{ paddingLeft: getProjectGroupHeaderPaddingLeft(depth) }}
        onClick={onToggle}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggle?.()
                }
              }
            : undefined
        }
      >
        <div className={SECTION_HEADER_TITLE_SURFACE}>
          {icon ? (
            <div className={cn(SECTION_HEADER_ICON_BOX, 'text-foreground')}>{icon}</div>
          ) : null}

          <div className={SECTION_HEADER_LABEL_WRAP}>
            <div className={SECTION_HEADER_LABEL_ROW}>
              <div className={SECTION_HEADER_LABEL}>{label}</div>
              {typeof count === 'number' ? (
                <SidebarCountPill count={count} aria-label={countLabel} />
              ) : null}
            </div>
          </div>
        </div>

        {(actions || collapsible) && (
          <div className={SECTION_HEADER_ACTIONS}>
            {collapsible ? (
              <div
                className={SECTION_HEADER_CHEVRON_BOX}
                aria-hidden
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onToggle?.()
                }}
              >
                <ChevronDown
                  className={cn(
                    SECTION_HEADER_CHEVRON,
                    !expanded && SECTION_HEADER_CHEVRON_COLLAPSED
                  )}
                />
              </div>
            ) : null}
            {actions}
          </div>
        )}
      </div>

      {children}
    </div>
  )
}
