import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Link, Pin, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isMac } from '@/lib/platform'
import { useGhosttySuppression } from '@/hooks/useGhosttySuppression'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Switch } from '@/components/ui/switch'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import { DataProjectIcon } from '@/components/data-projects/DataProjectIcon'
import { AgentStateDot } from '@/components/sidebar/AgentStateDot'
import { CreateTaskIcon } from '@/components/connections/CreateTaskIcon'
import {
  applyCreateProgress,
  createTaskLabel,
  planCreateTasks,
  type CreateTask
} from '@/components/connections/connection-create-tasks'
import { toHighlightRuns } from '@/lib/highlight-runs'
import { toast } from '@/lib/toast'
import {
  formatOpenedAge,
  groupSwitcherProjects,
  rankSwitcherProjects,
  type SwitcherAgentState
} from '@/lib/project-switcher'
import {
  canConnectSwitcherProject,
  connectSwitcherProjects,
  setSwitcherConnectionPullsFirst,
  switcherConnectionPullsFirst
} from './connect-switcher-projects'
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
//
// Shift+Enter (or a Shift+click) picks the highlighted project as one of several instead of
// opening it: the query is cleared, the project moves to the "New connection" rows that stay
// on top of the list whatever is typed or scrolled, and the next one can be looked for.
// Cmd+Shift+Enter (Ctrl+Shift+Enter off macOS, or a click with the same keys held) picks it
// on its base branch: it joins the connection as it is, with no new worktree. On a picked
// project the key it was picked with takes it out again, and the other one changes how it
// joins.
//
// Once a project is picked, plain Enter (or a click) on a row ends the picking: the picked
// projects and that one are connected, as the New Connection dialog would
// (connect-switcher-projects) — each one pulled from origin, a new worktree in each, one
// connection over them, selected; a project picked on its base branch is neither pulled nor
// given a worktree. Cmd+Enter ends the picking too, but leaves the highlighted row out: only
// the picked projects are connected (it does not pin while any is picked). The list is
// replaced by the steps while that runs; when it fails the picker comes back, the projects
// still picked, with the reason above them. Only git projects can be picked, so while any is,
// connection projects and databases are not listed.
//
// The pull is the "Pull latest from origin" switch in the heading of the picked projects,
// there for as long as any is picked. It is the New Connection dialog's switch (one setting,
// `pullBeforeConnection`): on until it is switched off, in either place, and then off in both
// until it is switched back on. The "auto-pull before worktree" setting has no say in it.

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

const NO_ITEMS: SwitcherItem[] = []

/** The key that picks the highlighted project as one of several, as the footer shows it. */
const SELECT_KEY_LABEL = '⇧↵'

/** Shift+Enter, and no other modifier. */
const isSelectChord = (event: KeyboardEvent): boolean =>
  event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey

interface ModifierKeys {
  metaKey: boolean
  ctrlKey: boolean
}

/** Cmd held on macOS, Ctrl elsewhere, and not the other of the two. */
const hasCommandKey = (event: ModifierKeys): boolean =>
  isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

/**
 * The key that pins the highlighted project, as the footer and the pin buttons show it. With
 * projects picked it connects them instead.
 */
const pinKeyLabel = (): string => (isMac() ? '⌘↵' : 'ctrl ↵')

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere, and no other modifier. */
const isPinChord = (event: KeyboardEvent): boolean =>
  hasCommandKey(event) && !event.altKey && !event.shiftKey

/** The key that picks the highlighted project on its base branch, as the footer shows it. */
const baseSelectKeyLabel = (): string => (isMac() ? '⌘⇧↵' : 'ctrl ⇧↵')

/** Cmd+Shift+Enter on macOS, Ctrl+Shift+Enter elsewhere, and no other modifier. */
const isBaseSelectChord = (event: KeyboardEvent): boolean =>
  hasCommandKey(event) && event.shiftKey && !event.altKey

/** How a picked project joins the new connection: on a new worktree, or on its base branch. */
type PickMode = 'worktree' | 'base'

interface PickedProject {
  key: string
  mode: PickMode
}

const NO_PICKS: PickedProject[] = []

interface Highlight {
  /** The highlighted position, used while `key` is not in the list. */
  index: number
  /** The highlighted project. null: the first result (the switcher just opened, a new query). */
  key: string | null
}

const FIRST_ROW: Highlight = { index: 0, key: null }

/**
 * The highlighted row's index in `rows`, -1 for none. `firstResult` is where the results
 * start: the rows before it are the projects picked for a connection.
 *
 * The highlight stays on its project when the rows move (a pin changes the project's group, a
 * pick moves it to the top). When that project left the list (removed while the switcher is
 * open), the position decides, held inside the list. Without a project it is the first result;
 * when there is none, the last picked project, but only with nothing typed: after a query that
 * matched nothing, Enter must not connect what is picked.
 */
function resolveHighlight(
  rows: readonly SwitcherRow[],
  highlight: Highlight,
  firstResult: number,
  searching: boolean
): number {
  if (highlight.key !== null) {
    const byKey = rows.findIndex((row) => row.item.key === highlight.key)
    return byKey !== -1 ? byKey : Math.min(highlight.index, rows.length - 1)
  }
  if (firstResult < rows.length) return firstResult
  return searching ? -1 : rows.length - 1
}

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
  /** How the project was picked for a connection (a row of the group on top); null: not picked. */
  pickedAs: PickMode | null
  /** Projects are being picked: Cmd+Enter connects them, so the pin button does not name it. */
  selecting: boolean
  pinned: boolean
  worktreeCount: number
  agentState: SwitcherAgentState | undefined
  age: string
  onHover: (index: number) => void
  /**
   * A click on the row. `pickAs`: with Shift held the click picks like Shift+Enter, with Cmd
   * as well like Cmd+Shift+Enter; null opens or connects like Enter.
   */
  onChoose: (item: SwitcherItem, pickAs: PickMode | null) => void
  onTogglePin: (item: SwitcherItem, pinned: boolean) => void
  onDeselect: (item: SwitcherItem) => void
}

const SwitcherRowView = memo(function SwitcherRowView({
  row,
  index,
  active,
  searching,
  pickedAs,
  selecting,
  pinned,
  worktreeCount,
  agentState,
  age,
  onHover,
  onChoose,
  onTogglePin,
  onDeselect
}: SwitcherRowViewProps): React.JSX.Element {
  const { item } = row
  const selected = pickedAs !== null
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
      data-picked={selected ? 'true' : undefined}
      // Hover follows real pointer movement only: rows scrolling under a resting pointer
      // (arrow keys) must not take the highlight.
      onMouseMove={() => onHover(index)}
      onClick={(event) =>
        onChoose(item, !event.shiftKey ? null : hasCommandKey(event) ? 'base' : 'worktree')
      }
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
      {/* What the new connection gets of a picked project. */}
      {pickedAs && (
        <span
          data-testid="project-switcher-row-pick-mode"
          data-mode={pickedAs}
          title={
            pickedAs === 'base'
              ? 'Joins the connection on its base branch, with no new worktree'
              : 'Joins the connection on a new worktree'
          }
          className={cn(
            'inline-flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-none',
            pickedAs === 'base'
              ? 'border-foreground/25 text-foreground/80'
              : 'border-border text-muted-foreground'
          )}
        >
          {pickedAs === 'base' && <GitBranch aria-hidden="true" className="size-2.5" />}
          {pickedAs === 'base' ? 'base branch' : 'new worktree'}
        </span>
      )}
      {/* A picked project's button takes it out of the new connection. */}
      {selected ? (
        <button
          type="button"
          tabIndex={-1}
          data-testid="project-switcher-row-deselect"
          aria-label={`Remove from the new connection: ${item.name}`}
          title={`Remove from the new connection (${
            pickedAs === 'base' ? baseSelectKeyLabel() : SELECT_KEY_LABEL
          })`}
          onClick={(event) => {
            event.stopPropagation()
            onDeselect(item)
          }}
          className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      ) : (
        // Pins or unpins without opening the project. A pinned row always shows it (filled:
        // the pinned marker); the others on the highlighted row and under the pointer.
        <button
          type="button"
          // The field keeps the focus (the panel's onMouseDown); Tab never lands here.
          tabIndex={-1}
          data-testid="project-switcher-row-pin"
          data-pinned={pinned ? 'true' : 'false'}
          aria-label={`${pinLabel}: ${item.name}`}
          title={selecting ? pinLabel : `${pinLabel} (${pinKeyLabel()})`}
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
      )}
    </div>
  )
})

function ProjectSwitcherPanel(): React.JSX.Element {
  const closeSwitcher = useProjectSwitcherStore((s) => s.close)
  const close = useCallback((): void => closeSwitcher(), [closeSwitcher])
  const { items, pinnedKeys, worktreeCounts, agentStates } = useSwitcherProjects()

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<Highlight>(FIRST_ROW)
  // The projects picked with Shift+Enter or Cmd+Shift+Enter, in the order they were picked.
  const [picks, setPicks] = useState<PickedProject[]>(NO_PICKS)
  // The steps of the connection being created; null whenever the picker is showing.
  const [createTasks, setCreateTasks] = useState<CreateTask[] | null>(null)
  // Why the last attempt created nothing, shown over the picker it came back to.
  const [createError, setCreateError] = useState<string | null>(null)
  // One "now" for the whole time the overlay is open: ages do not tick while reading.
  const [now] = useState(() => Date.now())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // The "Pull latest from origin" switch, shown while any project is picked.
  const pullFirst = useSettingsStore((s) => s.pullBeforeConnection)

  const searching = query.trim().length > 0
  const creating = createTasks !== null
  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys])

  // A picked project that was removed while the switcher is open is no longer picked.
  const selectedItems = useMemo(() => {
    if (picks.length === 0) return NO_ITEMS
    const byKey = new Map(items.map((item) => [item.key, item]))
    return picks.flatMap(({ key }) => {
      const item = byKey.get(key)
      return item && canConnectSwitcherProject(item) ? [item] : []
    })
  }, [items, picks])
  const selectedSet = useMemo(() => new Set(selectedItems.map((item) => item.key)), [selectedItems])
  /** How each picked project joins the connection. */
  const pickModes = useMemo(() => new Map(picks.map(({ key, mode }) => [key, mode])), [picks])
  const selecting = selectedItems.length > 0
  /** Where the results start in `rows`: the picked projects come first. */
  const firstResult = selectedItems.length

  // What can still be chosen. Once a project is picked: the others that can join it.
  const candidates = useMemo(
    () =>
      selecting
        ? items.filter((item) => canConnectSwitcherProject(item) && !selectedSet.has(item.key))
        : items,
    [items, selecting, selectedSet]
  )

  const rows = useMemo<SwitcherRow[]>(() => {
    const picked = selectedItems.map((item) => ({
      item,
      nameIndices: NO_INDICES,
      pathIndices: NO_INDICES
    }))
    if (searching) {
      return [
        ...picked,
        ...rankSwitcherProjects(candidates, query).map((match) => ({
          item: match.project,
          nameIndices: match.nameIndices,
          pathIndices: match.pathIndices
        }))
      ]
    }
    const groups = groupSwitcherProjects(candidates, pinnedKeys)
    return [
      ...picked,
      ...(['pinned', 'recent', 'all'] as const).flatMap((id) =>
        groups[id].map((item, i) => ({
          item,
          nameIndices: NO_INDICES,
          pathIndices: NO_INDICES,
          groupStart: i === 0 ? { id, count: groups[id].length } : undefined
        }))
      )
    ]
  }, [selectedItems, candidates, pinnedKeys, query, searching])

  const highlighted = useMemo(
    () => resolveHighlight(rows, highlight, firstResult, searching),
    [rows, highlight, firstResult, searching]
  )

  // The sidebar loads every project's worktrees when it mounts. Opened with the sidebar
  // collapsed since launch, the counts and pinned order need the same one query.
  useEffect(() => {
    void useWorktreeStore.getState().hydrateAllWorktrees()
  }, [])

  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Keep the highlight in view; at the first result also show the heading above it.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || highlighted < 0) return
    if (highlighted === firstResult) {
      list.scrollTop = 0
      return
    }
    // A picked row is outside the list, in the group above it.
    const row = document.getElementById(`project-switcher-option-${highlighted}`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted, firstResult, rows])

  const open = useCallback(
    (item: SwitcherItem): void => {
      close()
      openSwitcherProject(item)
    },
    [close]
  )

  // The connection is created whether or not the switcher is still open to show it: closed
  // meanwhile (Escape, another overlay), a failure is said in a toast instead.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const connect = useCallback(
    (members: SwitcherItem[], modes: ReadonlyMap<string, PickMode>): void => {
      const projects = members.flatMap((item) =>
        item.kind === 'git'
          ? [
              {
                id: item.source.id,
                name: item.source.name,
                path: item.source.path,
                ...(modes.get(item.key) === 'base' ? { useBase: true } : {})
              }
            ]
          : []
      )
      // Should it fail, the picker comes back with every member picked and the highlight on
      // the last one: Enter tries the same projects again.
      setPicks(members.map((item) => ({ key: item.key, mode: modes.get(item.key) ?? 'worktree' })))
      setQuery('')
      setHighlight({ index: members.length - 1, key: members[members.length - 1].key })
      setCreateError(null)
      // Decided once, so the steps listed are the steps taken.
      const autoPull = switcherConnectionPullsFirst()
      setCreateTasks(planCreateTasks(projects, autoPull))
      void connectSwitcherProjects(projects, {
        autoPull,
        onProgress: (progress) => {
          if (mounted.current) setCreateTasks((tasks) => applyCreateProgress(tasks, progress))
        },
        onError: (error) => {
          if (mounted.current) setCreateError(error)
          else toast.error(error)
        }
      }).then((connectionId) => {
        if (!mounted.current) return
        if (connectionId) close()
        else setCreateTasks(null)
      })
    },
    [close]
  )

  // Read through a ref so the window listener is attached once per open.
  const latest = useRef({
    rows,
    highlighted,
    pinnedSet,
    selectedItems,
    selectedSet,
    pickModes,
    creating,
    query,
    open,
    connect,
    close
  })
  latest.current = {
    rows,
    highlighted,
    pinnedSet,
    selectedItems,
    selectedSet,
    pickModes,
    creating,
    query,
    open,
    connect,
    close
  }

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

  // A picked row's remove button, and the key the project was picked with pressed on it again.
  const deselect = useCallback((item: SwitcherItem): void => {
    const { rows, selectedSet, creating } = latest.current
    if (creating || !selectedSet.has(item.key)) return
    setCreateError(null)
    setPicks((current) => current.filter((pick) => pick.key !== item.key))
    // The highlight goes back into the list with the project.
    const index = rows.findIndex((row) => row.item.key === item.key)
    setHighlight({ index: Math.max(0, index), key: item.key })
  }, [])

  // Shift+Enter or a Shift+click ('worktree'), with Cmd as well ('base'). Nothing is opened
  // and the switcher stays open.
  const togglePicked = useCallback(
    (item: SwitcherItem, mode: PickMode): void => {
      const { selectedSet, pickModes, creating } = latest.current
      if (creating || !canConnectSwitcherProject(item)) return
      if (selectedSet.has(item.key)) {
        if (pickModes.get(item.key) === mode) {
          deselect(item)
          return
        }
        // Picked the other way: it stays where it is and joins this way instead.
        setCreateError(null)
        setPicks((current) =>
          current.map((pick) => (pick.key === item.key ? { ...pick, mode } : pick))
        )
        return
      }
      setCreateError(null)
      setPicks((current) =>
        current.some((pick) => pick.key === item.key)
          ? current
          : [...current, { key: item.key, mode }]
      )
      // Ready for the next project: an empty field, the highlight on the first one left.
      setQuery('')
      setHighlight(FIRST_ROW)
    },
    [deselect]
  )

  // Plain Enter or a click. With projects picked it ends the picking: they are connected,
  // together with this one. A single project (the only picked one, chosen itself) is opened.
  const choose = useCallback((item: SwitcherItem): void => {
    const { selectedItems, selectedSet, pickModes, creating, open, connect } = latest.current
    if (creating) return
    const members =
      selectedItems.length === 0 || selectedSet.has(item.key)
        ? selectedItems
        : [...selectedItems, item]
    if (members.length < 2) open(item)
    else connect(members, pickModes)
  }, [])

  // Cmd+Enter with projects picked: the picking ends with them alone, whatever row is
  // highlighted. A connection takes two, so a single picked project is opened, as Enter on
  // it opens it.
  const choosePicked = useCallback((): void => {
    const { selectedItems, pickModes, creating, open, connect } = latest.current
    if (creating || selectedItems.length === 0) return
    if (selectedItems.length < 2) open(selectedItems[0])
    else connect(selectedItems, pickModes)
  }, [])

  const chooseOrPick = useCallback(
    (item: SwitcherItem, pickAs: PickMode | null): void => {
      if (pickAs) togglePicked(item, pickAs)
      else choose(item)
    },
    [choose, togglePicked]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { rows, highlighted, pinnedSet, creating, close } = latest.current
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
        if (creating || rows.length === 0) return
        const step = event.key === 'ArrowDown' ? 1 : -1
        // Nothing highlighted: a query matched nothing under the picked projects, which are
        // above.
        if (highlighted < 0) {
          if (step === -1) highlightRow(rows.length - 1)
          return
        }
        highlightRow(Math.max(0, Math.min(rows.length - 1, highlighted + step)))
        return
      }
      if (event.key === 'Enter') {
        swallow()
        const row = rows[highlighted] as SwitcherRow | undefined
        if (creating) return
        // Cmd+Enter connects the picked projects without the highlighted one, so it needs no
        // row (a query that matched nothing). With none picked it pins or unpins. A held key
        // does not flip the pin back and forth, nor go on from the Cmd+Shift+Enter before it.
        if (isPinChord(event)) {
          if (event.repeat) return
          if (latest.current.selectedItems.length > 0) choosePicked()
          else if (row) togglePin(row.item, !pinnedSet.has(row.item.key))
          return
        }
        if (!row) return
        // Shift+Enter picks the project as one of several, Cmd+Shift+Enter picks it on its
        // base branch; on a picked one they take it out or change how it joins. A held key
        // does not go on to pick the next ones.
        if (isSelectChord(event) || isBaseSelectChord(event)) {
          if (!event.repeat) togglePicked(row.item, isSelectChord(event) ? 'worktree' : 'base')
          return
        }
        // Plain Enter opens, or connects what is picked. With any other modifier it does
        // nothing here.
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        // Held from the Shift+Enter before it, Enter does not go on to connect.
        if (event.repeat && latest.current.selectedItems.length > 0) return
        choose(row.item)
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
  }, [highlightRow, togglePin, togglePicked, choose, choosePicked])

  const highlightedRow = rows[highlighted] as SwitcherRow | undefined
  const highlightedSelected = !!highlightedRow && selectedSet.has(highlightedRow.item.key)
  /** How the highlighted row is picked; null: it is not. */
  const highlightedPickedAs =
    highlightedRow && highlightedSelected
      ? (pickModes.get(highlightedRow.item.key) ?? 'worktree')
      : null
  /** How many projects Enter on the highlighted row connects; under 2 it opens the row. */
  const connectCount = !highlightedRow
    ? 0
    : selectedItems.length + (selecting && !highlightedSelected ? 1 : 0)
  const resultCount = rows.length - firstResult

  const handleQueryChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    if (creating) return
    setQuery(event.target.value)
    // The first result is highlighted after every keystroke.
    setHighlight(FIRST_ROW)
  }

  const renderRow = (row: SwitcherRow, index: number): React.JSX.Element => (
    <SwitcherRowView
      row={row}
      index={index}
      active={index === highlighted}
      searching={searching}
      pickedAs={index < firstResult ? (pickModes.get(row.item.key) ?? 'worktree') : null}
      selecting={selecting}
      pinned={pinnedSet.has(row.item.key)}
      worktreeCount={worktreeCounts.get(row.item.key) ?? 0}
      agentState={agentStates.get(row.item.key)}
      age={formatOpenedAge(row.item.lastOpenedAt, now)}
      onHover={highlightRow}
      onChoose={chooseOrPick}
      onTogglePin={togglePin}
      onDeselect={deselect}
    />
  )

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
        {/* The panel starts 14% down: held inside the window, the list gives up its height to
            the picked projects and an error above it, and the footer stays in view. */}
        <div className="flex max-h-[calc(86vh-1.5rem)] flex-col overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={handleQueryChange}
              readOnly={creating}
              placeholder={
                creating
                  ? 'Creating the connection…'
                  : selecting
                    ? 'Add another project…'
                    : 'Go to project…'
              }
              className="h-10 min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-label="Go to project"
              aria-expanded="true"
              aria-controls={
                selecting && !creating
                  ? 'project-switcher-selected project-switcher-list'
                  : 'project-switcher-list'
              }
              aria-autocomplete="list"
              aria-activedescendant={
                !creating && highlightedRow ? `project-switcher-option-${highlighted}` : undefined
              }
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="project-switcher-input"
            />
            {!creating && (
              <span
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                data-testid="project-switcher-count"
                aria-live="polite"
              >
                {searching
                  ? `${resultCount} of ${candidates.length}`
                  : `${candidates.length} ${candidates.length === 1 ? 'project' : 'projects'}`}
              </span>
            )}
          </div>

          {createError && !creating && (
            <div
              role="alert"
              className="shrink-0 border-b border-border bg-destructive/10 px-4 py-2 text-[12px] text-destructive"
              data-testid="project-switcher-create-error"
            >
              <div className="font-medium">Connection not created</div>
              <div className="whitespace-pre-wrap break-words">{createError}</div>
            </div>
          )}

          {createTasks && (
            <ul
              className="max-h-[min(60vh,30rem)] min-h-0 overflow-y-auto p-1.5"
              aria-live="polite"
              data-testid="project-switcher-create-progress"
            >
              {createTasks.map((task) => (
                <li
                  key={`${task.step}-${task.projectId}`}
                  className="flex h-8 items-center gap-2.5 px-2.5 text-[13px]"
                  data-testid={`project-switcher-create-task-${task.step}-${task.projectId}`}
                  data-status={task.status}
                >
                  <CreateTaskIcon status={task.status} />
                  <span
                    className={cn('truncate', task.status === 'pending' && 'text-muted-foreground')}
                  >
                    {createTaskLabel(task)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* The picked projects: above the list, so they stay in view whatever is typed or
              scrolled. */}
          {selecting && !creating && (
            <div
              id="project-switcher-selected"
              role="listbox"
              aria-label="Projects of the new connection"
              className="max-h-[9.5rem] shrink-0 overflow-y-auto border-b border-border p-1.5"
              data-testid="project-switcher-selected"
            >
              <div
                role="presentation"
                className="flex items-center justify-between gap-3 px-2.5 pb-1 pt-1 text-[11px] font-medium text-muted-foreground"
              >
                <div
                  role="presentation"
                  className="flex items-center gap-1.5"
                  data-testid="project-switcher-group-selected"
                >
                  <span>New connection</span>
                  <span className="tabular-nums opacity-70">{selectedItems.length}</span>
                </div>
                <label
                  className="flex cursor-pointer items-center gap-1.5"
                  title="Pull each project's base branch (usually main) from origin before creating its worktree, so the connection starts up to date"
                >
                  <Switch
                    size="sm"
                    // The field keeps the focus (the panel's onMouseDown); Tab never lands here.
                    tabIndex={-1}
                    checked={pullFirst}
                    onCheckedChange={setSwitcherConnectionPullsFirst}
                    data-testid="project-switcher-auto-pull-switch"
                  />
                  <span>Pull latest from origin</span>
                </label>
              </div>
              {rows.slice(0, firstResult).map((row, index) => (
                <div key={row.item.key} role="presentation">
                  {renderRow(row, index)}
                </div>
              ))}
            </div>
          )}

          {!creating && (
            <div
              ref={listRef}
              id="project-switcher-list"
              role="listbox"
              aria-label="Projects"
              className="max-h-[min(60vh,30rem)] min-h-0 overflow-y-auto p-1.5"
              data-testid="project-switcher-list"
            >
              {resultCount === 0 && (
                <div
                  className="px-3 py-6 text-center text-[13px] text-muted-foreground"
                  data-testid="project-switcher-empty"
                >
                  {searching
                    ? `No project matches “${query.trim()}”`
                    : selecting
                      ? 'No other project to add'
                      : 'No projects yet'}
                </div>
              )}
              {rows.slice(firstResult).map((row, i) => (
                <div key={row.item.key} role="presentation">
                  {row.groupStart && (
                    <div
                      role="presentation"
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium text-muted-foreground',
                        i === 0 ? 'pt-1' : 'pt-3'
                      )}
                      data-testid={`project-switcher-group-${row.groupStart.id}`}
                    >
                      <span>{GROUP_LABELS[row.groupStart.id]}</span>
                      <span className="tabular-nums opacity-70">{row.groupStart.count}</span>
                    </div>
                  )}
                  {renderRow(row, firstResult + i)}
                </div>
              ))}
            </div>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            {creating ? (
              <span data-testid="project-switcher-creating-hint">
                {createTasks.every((task) => task.step === 'base')
                  ? 'Connecting the base branches'
                  : createTasks.some((task) => task.step === 'base')
                    ? 'Creating the worktrees, then the connection'
                    : 'Creating a worktree in each project, then the connection'}
              </span>
            ) : (
              <>
                <span>
                  <kbd className={KBD_CLASS}>↑↓</kbd> navigate
                </span>
                <span data-testid="project-switcher-enter-hint">
                  <kbd className={KBD_CLASS}>↵</kbd>{' '}
                  {connectCount >= 2 ? `connect ${connectCount} projects` : 'open'}
                </span>
                {highlightedRow && canConnectSwitcherProject(highlightedRow.item) && (
                  <>
                    <span data-testid="project-switcher-select-hint">
                      <kbd className={KBD_CLASS}>{SELECT_KEY_LABEL}</kbd>{' '}
                      {highlightedPickedAs === 'worktree'
                        ? 'remove'
                        : highlightedPickedAs === 'base'
                          ? 'new worktree'
                          : selecting
                            ? 'add'
                            : 'pick several'}
                    </span>
                    <span data-testid="project-switcher-base-hint">
                      <kbd className={KBD_CLASS}>{baseSelectKeyLabel()}</kbd>{' '}
                      {highlightedPickedAs === 'base'
                        ? 'remove'
                        : highlightedPickedAs === 'worktree'
                          ? 'base branch'
                          : selecting
                            ? 'add base branch'
                            : 'pick base branch'}
                    </span>
                  </>
                )}
                {/* With projects picked the key connects them, whatever is highlighted. */}
                {selecting ? (
                  <span data-testid="project-switcher-connect-picked-hint">
                    <kbd className={KBD_CLASS}>{pinKeyLabel()}</kbd>{' '}
                    {selectedItems.length >= 2
                      ? `connect ${selectedItems.length} picked`
                      : 'open picked'}
                  </span>
                ) : (
                  highlightedRow && (
                    <span data-testid="project-switcher-pin-hint">
                      <kbd className={KBD_CLASS}>{pinKeyLabel()}</kbd>{' '}
                      {pinnedSet.has(highlightedRow.item.key) ? 'unpin' : 'pin'}
                    </span>
                  )
                )}
              </>
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
