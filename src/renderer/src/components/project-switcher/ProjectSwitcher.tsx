import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, Pin, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isMac } from '@/lib/platform'
import { useGhosttySuppression } from '@/hooks/useGhosttySuppression'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import { DataProjectIcon } from '@/components/data-projects/DataProjectIcon'
import { AgentStateDot } from '@/components/sidebar/AgentStateDot'
import { toHighlightRuns } from '@/lib/highlight-runs'
import {
  formatOpenedAge,
  groupSwitcherProjects,
  rankSwitcherProjects,
  type SwitcherAgentState
} from '@/lib/project-switcher'
import { openSwitcherProject } from './open-switcher-project'
import { setSwitcherProjectPinned, switcherPinLabel } from './pin-switcher-project'
import { useSwitcherProjects, type SwitcherItem } from './useSwitcherProjects'

// "Go to project": an overlay that reaches any project on this Mac by typing a few letters.
//
// Nothing typed: Pinned, Recent, All projects. Text typed: one ranked list (the rules are in
// lib/project-switcher). Opened from the sidebar's "Go to project" row and the command
// palette's "Switch to Project" (useProjectSwitcherStore.toggle).
//
// Keys are taken on `window` in the capture phase, ahead of every document-level handler of
// the app (shortcuts, vim mode, jump hints, a sidebar Escape): while the switcher is open,
// plain keys only edit the query and Escape only closes the switcher. Keys with Cmd / Ctrl /
// Alt pass through, so app shortcuts keep working.
//
// Cmd+Enter (Ctrl+Enter off macOS) and a row's pin button pin or unpin a project without
// opening it: the switcher stays open, so several projects can be pinned in a row. The
// highlight belongs to a project, not to a position: when a pin moves the project to another
// group, the highlight goes with it.

type GroupId = 'pinned' | 'recent' | 'all'

const GROUP_LABELS: Record<GroupId, string> = {
  pinned: 'Pinned',
  recent: 'Recent',
  all: 'All projects'
}

interface SwitcherRow {
  item: SwitcherItem
  nameIndices: number[]
  pathIndices: number[]
  /** Set on the first row of a group when nothing is typed. */
  groupStart?: { id: GroupId; count: number }
}

const NO_INDICES: number[] = []

const KBD_CLASS = 'rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]'

/** The key that pins the highlighted project, as the footer and the pin buttons show it. */
const pinKeyLabel = (): string => (isMac() ? '⌘↵' : 'ctrl ↵')

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere, and no other modifier. */
const isPinChord = (event: KeyboardEvent): boolean =>
  (isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey

interface Highlight {
  /** The highlighted position, used while `key` is not in the list. */
  index: number
  /** The highlighted project. null: the position alone decides (first result, a new query). */
  key: string | null
}

const FIRST_ROW: Highlight = { index: 0, key: null }

function Highlighted({
  text,
  indices
}: {
  text: string
  indices: number[]
}): React.JSX.Element | string {
  if (indices.length === 0) return text
  return (
    <>
      {toHighlightRuns(text, indices).map((run, i) =>
        run.hit ? (
          <mark
            key={i}
            className="bg-transparent font-semibold text-foreground underline decoration-foreground/45 underline-offset-[3px]"
          >
            {run.text}
          </mark>
        ) : (
          run.text
        )
      )}
    </>
  )
}

function ProjectIcon({ item }: { item: SwitcherItem }): React.JSX.Element {
  if (item.kind === 'data') {
    return (
      <DataProjectIcon
        engine={item.source.engine}
        icon={item.source.icon}
        iconColor={item.source.iconColor}
        environment={item.source.environment}
        environmentColorOverride={item.source.color}
        size="sm"
      />
    )
  }
  if (item.kind === 'connection') {
    return <Link className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return (
    <LanguageIcon
      language={item.source.language}
      customIcon={item.source.custom_icon}
      detectedIcon={item.source.detected_icon}
    />
  )
}

interface SwitcherRowViewProps {
  row: SwitcherRow
  index: number
  active: boolean
  searching: boolean
  pinned: boolean
  worktreeCount: number
  agentState: SwitcherAgentState | undefined
  age: string
  onHover: (index: number) => void
  onOpen: (item: SwitcherItem) => void
  onTogglePin: (item: SwitcherItem, pinned: boolean) => void
}

const SwitcherRowView = memo(function SwitcherRowView({
  row,
  index,
  active,
  searching,
  pinned,
  worktreeCount,
  agentState,
  age,
  onHover,
  onOpen,
  onTogglePin
}: SwitcherRowViewProps): React.JSX.Element {
  const { item } = row
  const countNoun = item.kind === 'connection' ? 'connection' : 'worktree'
  const pinLabel = switcherPinLabel(item, pinned)
  return (
    <div
      id={`project-switcher-option-${index}`}
      role="option"
      aria-selected={active}
      data-testid="project-switcher-row"
      data-project-key={item.key}
      data-active={active ? 'true' : undefined}
      // Hover follows real pointer movement only: rows scrolling under a resting pointer
      // (arrow keys) must not take the highlight.
      onMouseMove={() => onHover(index)}
      onClick={() => onOpen(item)}
      className={cn(
        'group/row flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]',
        // Off-screen rows of a 400-project list skip layout and paint.
        '[contain-intrinsic-size:auto_2rem] [content-visibility:auto]',
        active && 'bg-accent'
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ProjectIcon item={item} />
      </span>
      <span
        data-testid="project-switcher-row-name"
        className={cn(
          'max-w-[55%] shrink-0 truncate font-medium',
          searching && row.nameIndices.length > 0 ? 'text-foreground/75' : 'text-foreground'
        )}
      >
        <Highlighted text={item.name} indices={row.nameIndices} />
      </span>
      {/* The end of a path says the most: when it does not fit, its start is cut (rtl puts
          the ellipsis on the left; the inner ltr span keeps the characters in order). */}
      <span
        data-testid="project-switcher-row-path"
        title={item.path}
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-[11.5px] text-muted-foreground [direction:rtl]"
      >
        <span dir="ltr" className="[unicode-bidi:isolate]">
          <Highlighted text={item.path} indices={row.pathIndices} />
        </span>
      </span>
      {worktreeCount > 1 && (
        <span
          data-testid="project-switcher-row-worktrees"
          aria-label={`${worktreeCount} ${countNoun}s`}
          title={`${worktreeCount} ${countNoun}s`}
          className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border px-1.5 text-[9px] font-medium tabular-nums leading-none text-muted-foreground"
        >
          {worktreeCount}
        </span>
      )}
      {agentState && (
        <span data-testid="project-switcher-row-agent" data-state={agentState} className="shrink-0">
          <AgentStateDot state={agentState} size="md" />
        </span>
      )}
      {age && (
        <span
          data-testid="project-switcher-row-age"
          title={`Last opened ${new Date(item.lastOpenedAt).toLocaleString()}`}
          className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
        >
          {age}
        </span>
      )}
      {/* Pins or unpins without opening the project. A pinned row always shows it (filled:
          the pinned marker); the others on the highlighted row and under the pointer. */}
      <button
        type="button"
        // The field keeps the focus (the panel's onMouseDown); Tab never lands here.
        tabIndex={-1}
        data-testid="project-switcher-row-pin"
        data-pinned={pinned ? 'true' : 'false'}
        aria-label={`${pinLabel}: ${item.name}`}
        title={`${pinLabel} (${pinKeyLabel()})`}
        onClick={(event) => {
          event.stopPropagation()
          onTogglePin(item, !pinned)
        }}
        className={cn(
          '-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground',
          'hover:bg-foreground/10 hover:text-foreground',
          !pinned && !active && 'opacity-0 group-hover/row:opacity-100'
        )}
      >
        {pinned ? (
          <Pin
            data-testid="project-switcher-row-pinned"
            role="img"
            aria-label="Pinned"
            className="size-3 fill-current"
          />
        ) : (
          <Pin aria-hidden="true" className="size-3" />
        )}
      </button>
    </div>
  )
})

function ProjectSwitcherPanel(): React.JSX.Element {
  const closeSwitcher = useProjectSwitcherStore((s) => s.close)
  const close = useCallback((): void => closeSwitcher(), [closeSwitcher])
  const { items, pinnedKeys, worktreeCounts, agentStates } = useSwitcherProjects()

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<Highlight>(FIRST_ROW)
  // One "now" for the whole time the overlay is open: ages do not tick while reading.
  const [now] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const searching = query.trim().length > 0
  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys])

  const rows = useMemo<SwitcherRow[]>(() => {
    if (searching) {
      return rankSwitcherProjects(items, query).map((match) => ({
        item: match.project,
        nameIndices: match.nameIndices,
        pathIndices: match.pathIndices
      }))
    }
    const groups = groupSwitcherProjects(items, pinnedKeys)
    return (['pinned', 'recent', 'all'] as const).flatMap((id) =>
      groups[id].map((item, i) => ({
        item,
        nameIndices: NO_INDICES,
        pathIndices: NO_INDICES,
        groupStart: i === 0 ? { id, count: groups[id].length } : undefined
      }))
    )
  }, [items, pinnedKeys, query, searching])

  // The highlight stays on its project when the rows move (a pin changes the project's group).
  // Without one, or when it left the list (removed while the switcher is open), the position
  // decides, held inside the list.
  const highlighted = useMemo(() => {
    const byKey =
      highlight.key === null ? -1 : rows.findIndex((row) => row.item.key === highlight.key)
    return byKey !== -1 ? byKey : Math.min(highlight.index, Math.max(0, rows.length - 1))
  }, [rows, highlight])

  // The sidebar loads every project's worktrees when it mounts. Opened with the sidebar
  // collapsed since launch, the counts and pinned order need the same one query.
  useEffect(() => {
    void useWorktreeStore.getState().hydrateAllWorktrees()
  }, [])

  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Keep the highlight in view; at the first row also show the heading above it.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    if (highlighted === 0) {
      list.scrollTop = 0
      return
    }
    const row = list.querySelector<HTMLElement>(`#project-switcher-option-${highlighted}`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted, rows])

  const open = useCallback(
    (item: SwitcherItem): void => {
      close()
      openSwitcherProject(item)
    },
    [close]
  )

  // Read through a ref so the window listener is attached once per open.
  const latest = useRef({ rows, highlighted, pinnedSet, open, close })
  latest.current = { rows, highlighted, pinnedSet, open, close }

  const highlightRow = useCallback((index: number): void => {
    const row = latest.current.rows[index]
    setHighlight(row ? { index, key: row.item.key } : FIRST_ROW)
  }, [])

  // Nothing is navigated and the switcher stays open. The row changes when the pin is stored
  // (a failed pin leaves it as it was; the action shows the error toast).
  const togglePin = useCallback((item: SwitcherItem, pinned: boolean): void => {
    // The highlight goes with the project to the group it lands in.
    const index = latest.current.rows.findIndex((row) => row.item.key === item.key)
    setHighlight({ index: Math.max(0, index), key: item.key })
    void setSwitcherProjectPinned(item, pinned)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { rows, highlighted, pinnedSet, open, close } = latest.current
      const swallow = (): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      // Text being composed (an IME) owns its keys, Enter and Escape included.
      if (event.isComposing) {
        event.stopImmediatePropagation()
        return
      }
      if (event.key === 'Escape') {
        swallow()
        close()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        swallow()
        const step = event.key === 'ArrowDown' ? 1 : -1
        highlightRow(Math.max(0, Math.min(rows.length - 1, highlighted + step)))
        return
      }
      if (event.key === 'Enter') {
        swallow()
        const row = rows[highlighted]
        if (!row) return
        // Cmd+Enter pins or unpins. A held key does not flip the pin back and forth.
        if (isPinChord(event)) {
          if (!event.repeat) togglePin(row.item, !pinnedSet.has(row.item.key))
          return
        }
        // Plain Enter opens. With any other modifier it does nothing here.
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        open(row.item)
        return
      }
      if (event.key === 'Tab') {
        // The field keeps the focus: there is nothing else to tab to.
        swallow()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // A plain key edits the query and nothing else: no document-level handler sees it.
      // Should the focus have left the field, the key brings it back and is typed there.
      event.stopImmediatePropagation()
      const input = inputRef.current
      if (input && document.activeElement !== input) input.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [highlightRow, togglePin])

  const highlightedRow = rows[highlighted] as SwitcherRow | undefined

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value)
    // The first result is highlighted after every keystroke.
    setHighlight(FIRST_ROW)
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]"
        data-testid="project-switcher-backdrop"
        onMouseDown={(event) => {
          // Keeps the click from moving the focus before `close` puts it back.
          event.preventDefault()
          close()
        }}
      />
      <div
        className="fixed left-1/2 top-[14%] z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
        data-testid="project-switcher"
        role="dialog"
        aria-label="Go to project"
        aria-modal="true"
        // A click on the panel's chrome (headings, footer) leaves the caret in the field.
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) event.preventDefault()
        }}
      >
        <div className="flex flex-col overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)]">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleQueryChange}
              placeholder="Go to project…"
              className="h-10 min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-label="Go to project"
              aria-expanded="true"
              aria-controls="project-switcher-list"
              aria-autocomplete="list"
              aria-activedescendant={
                rows.length > 0 ? `project-switcher-option-${highlighted}` : undefined
              }
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="project-switcher-input"
            />
            <span
              className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
              data-testid="project-switcher-count"
              aria-live="polite"
            >
              {searching
                ? `${rows.length} of ${items.length}`
                : `${items.length} ${items.length === 1 ? 'project' : 'projects'}`}
            </span>
          </div>

          <div
            ref={listRef}
            id="project-switcher-list"
            role="listbox"
            aria-label="Projects"
            className="max-h-[min(60vh,30rem)] overflow-y-auto p-1.5"
            data-testid="project-switcher-list"
          >
            {rows.length === 0 && (
              <div
                className="px-3 py-6 text-center text-[13px] text-muted-foreground"
                data-testid="project-switcher-empty"
              >
                {searching ? `No project matches “${query.trim()}”` : 'No projects yet'}
              </div>
            )}
            {rows.map((row, index) => (
              <div key={row.item.key} role="presentation">
                {row.groupStart && (
                  <div
                    role="presentation"
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium text-muted-foreground',
                      index === 0 ? 'pt-1' : 'pt-3'
                    )}
                    data-testid={`project-switcher-group-${row.groupStart.id}`}
                  >
                    <span>{GROUP_LABELS[row.groupStart.id]}</span>
                    <span className="tabular-nums opacity-70">{row.groupStart.count}</span>
                  </div>
                )}
                <SwitcherRowView
                  row={row}
                  index={index}
                  active={index === highlighted}
                  searching={searching}
                  pinned={pinnedSet.has(row.item.key)}
                  worktreeCount={worktreeCounts.get(row.item.key) ?? 0}
                  agentState={agentStates.get(row.item.key)}
                  age={formatOpenedAge(row.item.lastOpenedAt, now)}
                  onHover={highlightRow}
                  onOpen={open}
                  onTogglePin={togglePin}
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-4 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              <kbd className={KBD_CLASS}>↑↓</kbd> navigate
            </span>
            <span>
              <kbd className={KBD_CLASS}>↵</kbd> open
            </span>
            {highlightedRow && (
              <span data-testid="project-switcher-pin-hint">
                <kbd className={KBD_CLASS}>{pinKeyLabel()}</kbd>{' '}
                {pinnedSet.has(highlightedRow.item.key) ? 'unpin' : 'pin'}
              </span>
            )}
            <span>
              <kbd className={KBD_CLASS}>esc</kbd> close
            </span>
          </div>
        </div>
      </div>
    </>
  )
}

/** Mounted once in AppLayout; renders nothing until the switcher is opened. */
export function ProjectSwitcher(): React.JSX.Element | null {
  const isOpen = useProjectSwitcherStore((s) => s.isOpen)
  useGhosttySuppression('project-switcher', isOpen)

  // One overlay at a time: the command palette or the file search opening replaces it.
  const commandPaletteOpen = useCommandPaletteStore((s) => s.isOpen)
  const fileSearchOpen = useFileSearchStore((s) => s.isOpen)
  useEffect(() => {
    if (commandPaletteOpen || fileSearchOpen) {
      // The overlay that opened has the focus now: it is not handed back.
      useProjectSwitcherStore.getState().close({ restoreFocus: false })
    }
  }, [commandPaletteOpen, fileSearchOpen])

  if (!isOpen) return null
  return <ProjectSwitcherPanel />
}
