// "Move projects to the dev folder": the one dialog of Settings › General's "Move projects…".
// It draws the state kept in lib/dev-folder/store and sends every click to
// lib/dev-folder/move-projects: the wait for the plan, the list with one checkbox per project
// that can move, the run with the project being moved marked, and the account of the run.
//
// Keyboard, as the app's other confirmations: focus rests on the way out (Cancel, then
// Close), so Enter and Escape leave without moving anything, and "Move N projects" is reached
// with Tab or the mouse. While projects are being moved the dialog cannot be left by Escape,
// by a click outside or by its close button: only "Cancel remaining" is offered, and it lets
// the project being moved finish.
import { useEffect, useRef } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Loader2,
  Minus,
  XCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  cancelRemainingDevFolderMove,
  closeDevFolderMove,
  recheckDevFolderMove,
  startDevFolderMove,
  toggleDevFolderMoveRow
} from '@/lib/dev-folder/move-projects'
import { isSameOrInsidePath, parentFolderOf } from '@/lib/dev-folder/moved-paths'
import {
  isMovableCandidate,
  selectedDevFolderRows,
  useDevFolderMoveStore,
  type DevFolderMovePhase,
  type DevFolderMoveRow
} from '@/lib/dev-folder/store'
import { cn } from '@/lib/utils'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useTerminalTabStore } from '@/stores/useTerminalTabStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// The answers of the server are typed, not checked field by field: a text that is not one
// reads as no text.
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

// The same for what the other stores of the window hold: a list that is not one reads as empty.
const listOf = <T,>(value: readonly T[] | null | undefined): readonly T[] =>
  Array.isArray(value) ? value : []

const folderNameOf = (path: string): string =>
  path
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .pop() ?? path

const nameOf = (row: DevFolderMoveRow): string =>
  textOf(row.candidate.projectName) || folderNameOf(textOf(row.candidate.fromPath))

const counted = (count: number): string => (count === 1 ? '1 project' : `${count} projects`)

/** The rows under the folder they sit in, folders in the order their first project is listed. */
function rowsBySource(rows: readonly DevFolderMoveRow[]): [string, DevFolderMoveRow[]][] {
  const groups = new Map<string, DevFolderMoveRow[]>()
  for (const row of rows) {
    const source = textOf(row.candidate.source)
    const group = groups.get(source)
    if (group) group.push(row)
    else groups.set(source, [row])
  }
  return Array.from(groups)
}

/**
 * Why a project that was not moved was not, in one sentence. A move that answered says so
 * itself; a project the plan ruled out carries the plan's sentence; the rest never had a
 * move asked for.
 */
function notMovedSentence(row: DevFolderMoveRow): string {
  if (row.status === 'failed') return textOf(row.result?.detail) || 'Its move failed.'
  if (row.status === 'skipped') {
    return (
      textOf(row.result?.detail) || textOf(row.candidate.detail) || 'This project cannot be moved.'
    )
  }
  if (row.status === 'running') return 'It is being moved.'
  return row.selected ? 'Its move was not started.' : 'Not selected.'
}

/**
 * A project that could have moved and that the person unticked before the run: it was never
 * asked for, so the account of the run does not list it among what went wrong.
 */
const isLeftOut = (row: DevFolderMoveRow): boolean =>
  row.status === 'pending' && !row.selected && isMovableCandidate(row.candidate)

/**
 * The folders the move of a project takes along: its checkout, with the worktrees inside it,
 * and the worktrees that sit next to the checkout in the same folder. One of those stays
 * behind when the dev folder already has its name; it is counted all the same, because a
 * warning too many costs nothing and one too few costs what was typed.
 */
function movingFoldersOf(row: DevFolderMoveRow, worktrees: readonly { path: string }[]): string[] {
  const from = textOf(row.candidate.fromPath)
  const parent = parentFolderOf(from)
  const folders = [from]
  for (const worktree of worktrees) {
    const path = textOf(worktree?.path)
    if (parent && path && path !== from && parentFolderOf(path) === parent) folders.push(path)
  }
  return folders
}

type SessionLists = ReadonlyMap<string, readonly { agent_sdk?: string | null }[]>

/**
 * The worktrees or connections (by id) that have a terminal session, as one text: a store
 * selector that answers the same text does not draw the dialog again.
 */
const idsWithTerminalSession = (sessions: SessionLists | undefined): string =>
  Array.from(sessions instanceof Map ? (sessions as SessionLists) : [])
    .filter(([, list]) => listOf(list).some((session) => session?.agent_sdk === 'terminal'))
    .map(([id]) => id)
    .join('\n')

function StatusIcon({ row }: { row: DevFolderMoveRow }): React.JSX.Element {
  switch (row.status) {
    case 'running':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
    case 'moved':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
    case 'skipped':
      return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
    default:
      return row.selected ? (
        <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" />
      ) : (
        <Minus className="h-4 w-4 shrink-0 text-muted-foreground/50" />
      )
  }
}

function FromTo({ from, to }: { from: string; to: string }): React.JSX.Element {
  return (
    <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
      <span className="block break-all">{from}</span>
      <span className="flex items-start gap-1">
        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" aria-label="to" />
        <span className="break-all">{to}</span>
      </span>
    </span>
  )
}

/** A project in the list the person confirms: a checkbox when it can move, the reason when not. */
function ConfirmRow({
  row,
  disabled
}: {
  row: DevFolderMoveRow
  disabled: boolean
}): React.JSX.Element {
  const id = row.candidate.projectId
  if (!isMovableCandidate(row.candidate)) {
    return (
      <div
        className="flex items-start gap-2 rounded p-2"
        data-testid={`dev-folder-move-row-${id}`}
        data-status={row.status}
      >
        <Minus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-muted-foreground">{nameOf(row)}</span>
          <span className="block text-xs text-muted-foreground">{notMovedSentence(row)}</span>
        </span>
      </div>
    )
  }
  return (
    <label
      className={cn(
        'flex items-start gap-2 rounded p-2',
        disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted'
      )}
      data-testid={`dev-folder-move-row-${id}`}
      data-status={row.status}
    >
      <Checkbox
        className="mt-0.5"
        checked={row.selected}
        disabled={disabled}
        onCheckedChange={() => toggleDevFolderMoveRow(id)}
        aria-label={`Move ${nameOf(row)}`}
        data-testid={`dev-folder-move-check-${id}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{nameOf(row)}</span>
        <FromTo from={textOf(row.candidate.fromPath)} to={textOf(row.candidate.toPath)} />
      </span>
    </label>
  )
}

/**
 * A project while the run is going (`over` false) and in the account of the run. While the
 * run is going, a project whose turn has not come says nothing yet.
 */
function OutcomeRow({ row, over }: { row: DevFolderMoveRow; over: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const moved = row.status === 'moved'
  const beingMoved = row.status === 'running'
  // The list is longer than the dialog shows: it follows the project being moved. Not every
  // DOM has the call, hence the second question mark.
  useEffect(() => {
    if (beingMoved) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [beingMoved])
  const waiting = !over && row.status === 'pending' && row.selected
  const warnings = moved
    ? (row.result?.warnings ?? []).filter(
        (warning): warning is string => typeof warning === 'string' && warning.length > 0
      )
    : []
  return (
    <div
      ref={ref}
      className="flex items-start gap-2 rounded p-2"
      data-testid={`dev-folder-move-row-${row.candidate.projectId}`}
      data-status={row.status}
    >
      <span className="mt-0.5">
        <StatusIcon row={row} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm',
            moved || row.status === 'running' ? 'font-medium' : 'text-muted-foreground'
          )}
        >
          {nameOf(row)}
        </span>
        {moved && (
          <span className="block break-all font-mono text-xs text-muted-foreground">
            {textOf(row.result?.toPath) || textOf(row.candidate.toPath)}
          </span>
        )}
        {row.status === 'running' && (
          <span className="block text-xs text-muted-foreground">Moving…</span>
        )}
        {!moved && row.status !== 'running' && !waiting && (
          <span
            className={cn(
              'block text-xs',
              row.status === 'failed' ? 'text-red-500' : 'text-muted-foreground'
            )}
          >
            {notMovedSentence(row)}
          </span>
        )}
        {warnings.map((warning, index) => (
          <span key={index} className="mt-1 flex items-start gap-1 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{warning}</span>
          </span>
        ))}
      </span>
    </div>
  )
}

function SourceHeading({ source }: { source: string }): React.JSX.Element {
  return (
    <h4 className="break-all px-2 font-mono text-[11px] font-medium text-muted-foreground">
      {source}
    </h4>
  )
}

function Notice({
  tone,
  testId,
  children
}: {
  tone: 'error' | 'warning'
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-md border px-3 py-2 text-xs',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
      )}
      data-testid={testId}
    >
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/** The sentence under the title: what the dialog is about to do, is doing, or did. */
function leadOf(
  phase: DevFolderMovePhase,
  devFolder: string,
  rows: readonly DevFolderMoveRow[]
): string {
  const into = devFolder ? ` into ${devFolder}` : ' into the dev folder'
  if (phase === 'planning') return 'Looking for projects in the folders used before.'
  if (phase === 'confirm') {
    return `Moves each project folder${into} and updates its path everywhere in Hive.`
  }
  if (phase === 'running') {
    const queue = selectedDevFolderRows(rows)
    const stays = 'The dialog stays open until the project being moved is done.'
    if (queue.length <= 1) return `Moving ${counted(queue.length)}${into}. ${stays}`
    // The projects are moved in the order of the list, so the one being moved comes right
    // after those that have their answer.
    const answered = queue.filter(
      (row) => row.status !== 'pending' && row.status !== 'running'
    ).length
    return `Moving project ${Math.min(answered + 1, queue.length)} of ${queue.length}${into}. ${stays}`
  }
  // The account of a run starts with what still sits where it was, against the person's
  // wish: the projects they left unticked are not part of the run and are counted apart.
  const moved = rows.filter((row) => row.status === 'moved').length
  const notMoved = rows.filter((row) => row.status !== 'moved' && !isLeftOut(row)).length
  const to = devFolder ? ` to ${devFolder}` : ''
  if (notMoved === 0) return moved === 0 ? 'No project was moved.' : `Moved ${counted(moved)}${to}.`
  const left = `${counted(notMoved)} ${notMoved === 1 ? 'was' : 'were'} not moved.`
  return moved === 0 ? left : `${left} ${counted(moved)} moved${to}.`
}

export function DevFolderMoveDialog(): React.JSX.Element {
  const phase = useDevFolderMoveStore((state) => state.phase)
  const plan = useDevFolderMoveStore((state) => state.plan)
  const rows = useDevFolderMoveStore((state) => state.rows)
  const rechecking = useDevFolderMoveStore((state) => state.rechecking)
  const cancelRequested = useDevFolderMoveStore((state) => state.cancelRequested)
  const error = useDevFolderMoveStore((state) => state.error)
  const dirtyFiles = useFileViewerStore((state) => state.dirtyFiles)
  const worktreesByProject = useWorktreeStore((state) => state.worktreesByProject)
  const ghostty = useSettingsStore((state) => state.embeddedTerminalBackend) === 'ghostty'
  const terminalTabs = useTerminalTabStore((state) => state.tabsByWorktree)
  const terminalWorktrees = useSessionStore((state) =>
    idsWithTerminalSession(state.sessionsByWorktree)
  )
  const terminalConnections = useSessionStore((state) =>
    idsWithTerminalSession(state.sessionsByConnection)
  )
  const connections = useConnectionStore((state) => state.connections)
  const dismissRef = useRef<HTMLButtonElement>(null)

  const running = phase === 'running'
  const selected = selectedDevFolderRows(rows)
  const leftOut = rows.filter(isLeftOut)
  const notMoved = rows.filter((row) => row.status !== 'moved' && !isLeftOut(row))
  const moved = rows.filter((row) => row.status === 'moved')
  const worktreesOf = (row: DevFolderMoveRow): readonly { id: string; path: string }[] =>
    listOf(worktreesByProject?.get?.(row.candidate.projectId))
  // Moving a project closes the file tabs of every folder that moves with it, and what was
  // typed in them and not saved goes with them: said before the click, while the files can
  // still be saved.
  const unsavedEdits =
    phase === 'confirm' &&
    selected.some((row) => {
      const folders = movingFoldersOf(row, worktreesOf(row))
      return Array.from(dirtyFiles).some((path) =>
        folders.some((folder) => isSameOrInsidePath(path, folder))
      )
    })
  // A project with a command running in a terminal is held back, but the commands of a
  // Ghostty terminal cannot be seen from here: the person is told to look for themselves. A
  // terminal session of a connection starts in the folder of the connection's first member.
  const terminalsOpenIn = (worktreeId: string): boolean =>
    listOf(terminalTabs?.get?.(worktreeId)).length > 0 ||
    terminalWorktrees.split('\n').includes(worktreeId) ||
    listOf(connections).some(
      (connection) =>
        connection?.members?.[0]?.worktree_id === worktreeId &&
        terminalConnections.split('\n').includes(connection.id)
    )
  const uncheckedTerminals =
    phase === 'confirm' &&
    ghostty &&
    selected.some((row) => worktreesOf(row).some((worktree) => terminalsOpenIn(worktree?.id)))

  // Each phase puts other buttons under the keyboard. Focus goes back to the way out, so an
  // Enter meant for the previous phase never starts a move.
  useEffect(() => {
    dismissRef.current?.focus()
  }, [phase])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) closeDevFolderMove()
      }}
    >
      <DialogContent
        className={cn(
          'flex max-h-[85vh] max-w-lg flex-col overflow-hidden',
          running && '[&>button:last-child]:hidden'
        )}
        data-testid="dev-folder-move-dialog"
        data-phase={phase}
        // Tab moves between the dialog's controls, not the mode of the session behind it.
        data-tab-navigates=""
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          dismissRef.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          const target = event.target instanceof Element ? event.target : null
          // A toast's buttons sit outside the dialog; using them is not closing it.
          if (running || target?.closest('[data-sonner-toaster]')) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Move projects to the dev folder</DialogTitle>
          <DialogDescription className="break-words" data-testid="dev-folder-move-lead">
            {leadOf(phase, textOf(plan?.devFolder), rows)}
          </DialogDescription>
        </DialogHeader>

        {phase === 'planning' && (
          <p
            className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
            data-testid="dev-folder-move-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking each project.
          </p>
        )}

        {error && phase !== 'planning' && (
          <Notice tone="error" testId="dev-folder-move-error">
            {error}
          </Notice>
        )}

        {phase === 'confirm' && rows.length === 0 && !error && (
          <p className="py-4 text-sm text-muted-foreground" data-testid="dev-folder-move-empty">
            No project is left in a folder used before.
          </p>
        )}

        {(phase === 'confirm' || phase === 'running') && rows.length > 0 && (
          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto"
            data-testid="dev-folder-move-list"
          >
            {rowsBySource(rows).map(([source, group]) => (
              <section key={source} className="space-y-1" data-testid="dev-folder-move-source">
                <SourceHeading source={source} />
                {group.map((row) =>
                  phase === 'confirm' ? (
                    <ConfirmRow key={row.candidate.projectId} row={row} disabled={rechecking} />
                  ) : (
                    <OutcomeRow key={row.candidate.projectId} row={row} over={false} />
                  )
                )}
              </section>
            ))}
          </div>
        )}

        {phase === 'summary' && (
          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto"
            data-testid="dev-folder-move-list"
          >
            {notMoved.length > 0 && (
              <section className="space-y-1" data-testid="dev-folder-move-not-moved">
                <h4 className="px-2 text-xs font-medium text-muted-foreground">Not moved</h4>
                {notMoved.map((row) => (
                  <OutcomeRow key={row.candidate.projectId} row={row} over />
                ))}
              </section>
            )}
            {moved.length > 0 && (
              <section className="space-y-1" data-testid="dev-folder-move-moved">
                <h4 className="px-2 text-xs font-medium text-muted-foreground">Moved</h4>
                {moved.map((row) => (
                  <OutcomeRow key={row.candidate.projectId} row={row} over />
                ))}
              </section>
            )}
            {leftOut.length > 0 && (
              <p
                className="px-2 text-xs text-muted-foreground"
                data-testid="dev-folder-move-left-out"
              >
                {leftOut.length === 1
                  ? '1 project was not selected and stays where it is.'
                  : `${leftOut.length} projects were not selected and stay where they are.`}
              </p>
            )}
          </div>
        )}

        {unsavedEdits && (
          <Notice tone="warning" testId="dev-folder-move-unsaved">
            Unsaved edits in open files of these projects will be lost. Cancel, save them, then open
            this dialog again.
          </Notice>
        )}

        {uncheckedTerminals && (
          <Notice tone="warning" testId="dev-folder-move-terminals">
            Terminals of these projects are not checked for running commands. Stop what runs in them
            first.
          </Notice>
        )}

        <DialogFooter>
          {running ? (
            <Button
              type="button"
              variant="outline"
              disabled={cancelRequested}
              onClick={cancelRemainingDevFolderMove}
              data-testid="dev-folder-move-cancel-remaining"
            >
              {cancelRequested ? 'Stopping after this project…' : 'Cancel remaining'}
            </Button>
          ) : (
            <Button
              ref={dismissRef}
              type="button"
              variant={phase === 'summary' ? 'default' : 'outline'}
              onClick={closeDevFolderMove}
              data-testid="dev-folder-move-close"
            >
              {phase === 'summary' ? 'Close' : 'Cancel'}
            </Button>
          )}
          {(phase === 'confirm' || phase === 'summary') && (
            <Button
              type="button"
              variant="outline"
              disabled={rechecking}
              onClick={() => void recheckDevFolderMove()}
              data-testid="dev-folder-move-recheck"
            >
              {rechecking && <Loader2 className="animate-spin" />}
              Check again
            </Button>
          )}
          {phase === 'confirm' && (
            <Button
              type="button"
              disabled={selected.length === 0 || rechecking}
              onClick={() => void startDevFolderMove()}
              data-testid="dev-folder-move-start"
            >
              {selected.length === 0 ? 'Move projects' : `Move ${counted(selected.length)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
