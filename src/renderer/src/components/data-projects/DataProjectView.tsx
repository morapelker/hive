// The main-pane view of an open data project (lazy-loaded by MainPane, which places it before
// every board branch so it shows even while the Pinned Board is on). Layout:
//
//   ┌ environment bar ───────────────────────────────────────────────┐
//   │ DataProjectToolbar                                             │
//   │ [connection-lost banner]                                       │
//   │ SqlWorkspace | MongoWorkspace            │ DataAssistantPanel  │
//   └────────────────────────────────────────────────────────────────┘
//
// States before the workspace mounts: loading the list, removed (deleted here or elsewhere),
// connecting (spinner with the target), credentials needed (opens the prompt), connection error
// (redacted message + classified hint, Retry / Edit connection). Once a project connected in
// this app session its workspace stays mounted: a later drop shows a banner with Reconnect
// instead of tearing down tabs and editor contents. An idle disconnect is silent (the next query
// reconnects on its own).
//
// Keyboard, while the view is mounted (a window capture listener, so it also works with focus
// inside the editor or the grid, which the global shortcut map leaves alone; never from inside a
// dialog open over the view):
//   ⌘⇧J          toggle the AI assistant
//   ⌘T           new query tab (SQL) / Shell tab (MongoDB) — the "New Session" binding
//   ⌃Tab / ⌃⇧Tab  next / previous workspace tab
//   ⌃⌘] / ⌃⌘[    next / previous view of a table tab (Data / Structure / DDL) or collection tab
//   ⌘R / ⌘F       refresh / filter the active table — the "Run Project" binding and ⌘F (not in
//                 the editor, whose ⌘F searches the query); only when its view answers the
//                 table command, otherwise the key passes on untouched
// In Electron the main process swallows ⌘T and ⌘D and forwards them: ⌘T opens the tab here, and
// ⌘D goes back to the focused editor as a keydown (select next occurrence) instead of opening
// the app's file search. ⌘W is the workspaces' own (they close their active tab).

import { useEffect } from 'react'
import { Database, KeyRound, Loader2, RotateCw, Settings2, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { systemApi } from '@/api/system-api'
import { isDataClientTarget } from '@/hooks/useKeyboardShortcuts'
import { eventMatchesBinding } from '@/lib/keyboard-shortcuts'
import { isMac } from '@/lib/platform'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { DATA_ENGINE_INFO, type DataProject } from '@shared/data-projects/types'
import { DataAssistantPanel } from './assistant/DataAssistantPanel'
import { DataProjectIcon } from './DataProjectIcon'
import { DataProjectToolbar, isAssistantShortcut } from './DataProjectToolbar'
import {
  DataProjectConfirmHost,
  DataProjectWorkspace,
  cycleWorkspaceTab,
  openWorkspaceNewTab,
  sendTableCommand,
  stepWorkspaceView,
  type DataTableCommandDetail
} from './DataProjectWorkspaceHost'
import { connectionErrorHint, describeDataProjectTarget } from './data-project-ui'

export interface DataProjectViewProps {
  projectId: string
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]'

/** A modal (wizard, confirmation, settings, palette) is open over the view. */
const dialogOpen = (): boolean =>
  !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
  )

type KeyAction =
  | { kind: 'assistant' }
  | { kind: 'new-tab' }
  | { kind: 'cycle-tab'; step: 1 | -1 }
  | { kind: 'step-view'; step: 1 | -1 }
  | { kind: 'table'; command: DataTableCommandDetail['command'] }

/** The view's own shortcut `event` stands for, if any (see the header). */
function dataClientKeyAction(event: KeyboardEvent): KeyAction | null {
  if (isAssistantShortcut(event)) return { kind: 'assistant' }
  const bindings = useShortcutStore.getState()
  const newTab = bindings.getEffectiveBinding('session:new')
  if (newTab && eventMatchesBinding(event, newTab)) return { kind: 'new-tab' }
  const refresh = bindings.getEffectiveBinding('project:run')
  if (refresh && eventMatchesBinding(event, refresh)) return { kind: 'table', command: 'refresh' }
  const target = event.target as Element | null
  const mod = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (
    mod &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'KeyF' || event.key.toLowerCase() === 'f') &&
    !(typeof target?.closest === 'function' && target.closest('[data-db-editor]'))
  ) {
    return { kind: 'table', command: 'filter' }
  }
  if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
    return { kind: 'cycle-tab', step: event.shiftKey ? -1 : 1 }
  }
  // ⌃⌘[ / ⌃⌘] (⌃⌥ elsewhere: Ctrl+Meta is the Windows key); event.code survives layouts.
  const bracket =
    event.code === 'BracketRight' || event.key === ']'
      ? 1
      : event.code === 'BracketLeft' || event.key === '['
        ? -1
        : 0
  const chord = isMac()
    ? event.ctrlKey && event.metaKey && !event.altKey
    : event.ctrlKey && event.altKey && !event.metaKey
  if (bracket !== 0 && chord && !event.shiftKey) return { kind: 'step-view', step: bracket }
  return null
}

/** Runs `action`; false when nothing took it (a table command no view answered). */
function runKeyAction(project: DataProject, action: KeyAction): boolean {
  switch (action.kind) {
    case 'assistant':
      useDataProjectStore.getState().toggleAssistant(project.id)
      return true
    case 'new-tab':
      void openWorkspaceNewTab(project)
      return true
    case 'cycle-tab':
      void cycleWorkspaceTab(project, action.step)
      return true
    case 'step-view':
      void stepWorkspaceView(project, action.step)
      return true
    case 'table':
      return sendTableCommand({ projectId: project.id, command: action.command })
  }
}

/**
 * ⌘D reached us from the main process instead of the focused query editor: hand it back as a
 * keydown so the editor's own keymap runs (select next occurrence). Anywhere else in the client
 * it does nothing (there are no files to search). The modifier is CodeMirror's "Mod", detected
 * the way CodeMirror does it (navigator.platform), so its keymap always reads it as Mod-d.
 */
function redispatchSelectNextOccurrence(): void {
  const focused = document.activeElement
  if (!focused || !isDataClientTarget(focused)) return
  const modIsMeta = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  focused.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'd',
      code: 'KeyD',
      metaKey: modIsMeta,
      ctrlKey: !modIsMeta,
      bubbles: true,
      cancelable: true
    })
  )
}

export default function DataProjectView({ projectId }: DataProjectViewProps): React.JSX.Element {
  const project = useDataProjectStore((s) => s.projects.find((p) => p.id === projectId))
  const loaded = useDataProjectStore((s) => s.loaded)
  const loadError = useDataProjectStore((s) => s.error)
  const exists = project !== undefined
  const epoch = useDataProjectStore((s) => s.connectionEpoch[projectId] ?? 0)
  const assistantOpen = useDataProjectStore((s) => !!s.assistantOpenById[projectId])

  // The list may not be loaded yet (palette or restore before the sidebar mounted).
  useEffect(() => {
    if (!useDataProjectStore.getState().loaded) void useDataProjectStore.getState().load()
  }, [])

  // Connect on open, and again when the connection settings / secrets changed (epoch).
  useEffect(() => {
    if (!exists) return
    void useDataProjectStore.getState().ensureConnected(projectId)
  }, [projectId, exists, epoch])

  useEffect(() => {
    const currentProject = (): DataProject | undefined =>
      useDataProjectStore.getState().projects.find((p) => p.id === projectId)
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = dataClientKeyAction(event)
      if (!action) return
      // Not from inside a dialog (wizard, confirmation) open over the view.
      const target = event.target as Element | null
      if (typeof target?.closest === 'function' && target.closest(DIALOG_SELECTOR)) return
      const project = currentProject()
      if (!project || !runKeyAction(project, action)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    // ⌘T / ⌘D never arrive as keydowns in Electron: the main process forwards them.
    const offNewTab = systemApi.onNewSessionShortcut(() => {
      const project = currentProject()
      if (project && !dialogOpen()) runKeyAction(project, { kind: 'new-tab' })
    })
    const offFileSearch = systemApi.onFileSearchShortcut(() => {
      if (!dialogOpen()) redispatchSelectNextOccurrence()
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      offNewTab()
      offFileSearch()
    }
  }, [projectId])

  if (!project) {
    if (!loaded) return <CenteredSpinner label="Loading the connection…" />
    return loadError ? <LoadFailed message={loadError} /> : <RemovedState />
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="data-project-view"
      data-data-project-id={project.id}
      data-environment={project.environment}
    >
      <DataProjectToolbar project={project} />
      <ConnectionLostBanner project={project} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DataProjectBody project={project} />
        </div>
        {assistantOpen && (
          <DataAssistantPanel
            project={project}
            onClose={() => useDataProjectStore.getState().setAssistantOpen(project.id, false)}
          />
        )}
      </div>
      <DataProjectConfirmHost />
    </div>
  )
}

function DataProjectBody({ project }: { project: DataProject }): React.JSX.Element {
  const status = useDataProjectStore((s) => s.statuses[project.id])
  const credentialsMessage = useDataProjectStore((s) => s.credentialsRequired[project.id])
  const everConnected = useDataProjectStore((s) => !!s.everConnected[project.id])

  if (credentialsMessage !== undefined) {
    return <CredentialsNeeded project={project} message={credentialsMessage} />
  }
  if (everConnected) return <DataProjectWorkspace project={project} />
  if (status?.state === 'error') {
    return <ConnectionFailed project={project} message={status.error} />
  }
  return (
    <CenteredSpinner
      label={`Connecting to ${describeDataProjectTarget(project)}…`}
      detail={
        project.config.ssh?.enabled
          ? `Through the SSH tunnel via ${project.config.ssh.host}`
          : DATA_ENGINE_INFO[project.engine].label
      }
      testId="data-project-connecting"
    />
  )
}

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------

function CenteredSpinner({
  label,
  detail,
  testId = 'data-project-loading'
}: {
  label: string
  detail?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid={testId}
    >
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-[13px] text-foreground">{label}</p>
      {detail && <p className="text-[12px] text-muted-foreground">{detail}</p>}
    </div>
  )
}

function StatePanel({
  icon,
  title,
  children,
  actions,
  testId
}: {
  icon: React.ReactNode
  title: string
  children?: React.ReactNode
  actions?: React.ReactNode
  testId: string
}): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center overflow-auto p-6" data-testid={testId}>
      <div className="flex w-full max-w-lg flex-col items-center gap-3 text-center">
        {icon}
        <h3 className="text-[15px] font-medium">{title}</h3>
        {children}
        {actions && (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}

const editButton = (project: DataProject): React.JSX.Element => (
  <Button
    variant="outline"
    size="sm"
    onClick={() =>
      useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: project.id })
    }
    data-testid="data-project-state-edit"
  >
    <Settings2 className="size-3.5" />
    Edit connection
  </Button>
)

function ConnectionFailed({
  project,
  message
}: {
  project: DataProject
  message?: string
}): React.JSX.Element {
  const hint = connectionErrorHint(message, project.engine)
  return (
    <StatePanel
      testId="data-project-connection-error"
      icon={<TriangleAlert className="h-9 w-9 text-destructive opacity-80" />}
      title={`Could not connect to ${project.name}`}
      actions={
        <>
          <Button
            size="sm"
            onClick={() => void useDataProjectStore.getState().connect(project.id)}
            data-testid="data-project-state-retry"
          >
            <RotateCw className="size-3.5" />
            Retry
          </Button>
          {editButton(project)}
        </>
      }
    >
      <p className="text-[12px] text-muted-foreground">{describeDataProjectTarget(project)}</p>
      {message && (
        <pre
          className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-left font-mono text-[11px]"
          data-testid="data-project-connection-error-message"
        >
          {message}
        </pre>
      )}
      {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
    </StatePanel>
  )
}

function CredentialsNeeded({
  project,
  message
}: {
  project: DataProject
  message: string
}): React.JSX.Element {
  return (
    <StatePanel
      testId="data-project-credentials-needed"
      icon={<KeyRound className="h-9 w-9 text-muted-foreground opacity-70" />}
      title="Password needed"
      actions={
        <>
          <Button
            size="sm"
            onClick={() =>
              useDataProjectStore.getState().openCredentialsPrompt(project.id, message)
            }
            data-testid="data-project-state-enter-credentials"
          >
            <KeyRound className="size-3.5" />
            Enter password…
          </Button>
          {editButton(project)}
        </>
      }
    >
      <p className="text-[12px] text-muted-foreground">
        {message || `No usable password is stored for ${project.name}.`}
      </p>
    </StatePanel>
  )
}

function LoadFailed({ message }: { message: string }): React.JSX.Element {
  return (
    <StatePanel
      testId="data-project-load-error"
      icon={<TriangleAlert className="h-9 w-9 text-destructive opacity-80" />}
      title="Could not load the database connections"
      actions={
        <Button
          size="sm"
          onClick={() => void useDataProjectStore.getState().load()}
          data-testid="data-project-load-retry"
        >
          <RotateCw className="size-3.5" />
          Retry
        </Button>
      }
    >
      <p className="text-[12px] text-muted-foreground">{message}</p>
    </StatePanel>
  )
}

function RemovedState(): React.JSX.Element {
  return (
    <StatePanel
      testId="data-project-removed"
      icon={<Database className="h-9 w-9 text-muted-foreground opacity-50" />}
      title="This database connection was removed"
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => useDataProjectStore.getState().select(null)}
          data-testid="data-project-removed-close"
        >
          <X className="size-3.5" />
          Close
        </Button>
      }
    >
      <p className="text-[12px] text-muted-foreground">
        It was deleted here or on another device. Pick another project in the sidebar.
      </p>
    </StatePanel>
  )
}

/** Shown above a mounted workspace when an established connection failed. */
function ConnectionLostBanner({ project }: { project: DataProject }): React.JSX.Element | null {
  const status = useDataProjectStore((s) => s.statuses[project.id])
  const everConnected = useDataProjectStore((s) => !!s.everConnected[project.id])
  const credentials = useDataProjectStore((s) => s.credentialsRequired[project.id] !== undefined)
  if (!everConnected || credentials || status?.state !== 'error') return null
  const hint = connectionErrorHint(status.error, project.engine)
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/8 px-3 py-1.5 text-[12px]"
      role="alert"
      data-testid="data-project-connection-lost"
    >
      <DataProjectIcon engine={project.engine} icon={project.icon} iconColor={project.iconColor} />
      <span className="min-w-0 flex-1 truncate" title={status.error}>
        <span className="font-medium text-destructive">Connection lost.</span>{' '}
        <span className="text-muted-foreground">{hint ?? status.error ?? ''}</span>
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[12px]"
        onClick={() => void useDataProjectStore.getState().connect(project.id)}
        data-testid="data-project-reconnect"
      >
        <RotateCw className="size-3" />
        Reconnect
      </Button>
    </div>
  )
}
