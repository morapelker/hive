// The open data project's toolbar: a full-width environment colour bar (thicker and red for
// production, with a PRODUCTION badge and a tinted strip, so it is impossible to miss), the
// project icon/name/host, the connection status (dot + menu with server details, Reconnect,
// Disconnect), the safe-mode menu (colour-coded; loosening production asks first), Processes,
// History, Saved queries, Console (the log of every statement sent; ⌃⌘C, TablePlus' console
// key), the AI assistant toggle (⌘⇧J) and Edit connection.

import { useEffect } from 'react'
import {
  Activity,
  Bookmark,
  Bot,
  ChevronDown,
  History,
  Loader2,
  Plug,
  RotateCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import {
  DATA_ENGINE_INFO,
  DATA_ENVIRONMENT_DEFAULTS,
  type DataConnectionStatus,
  type DataProject,
  type DataSafeMode
} from '@shared/data-projects/types'
import { DataProjectIcon } from './DataProjectIcon'
import { ConnectionStatusDot, useSafeModeChange } from './DataProjectItem'
import { openWorkspaceSpecialTab, type WorkspaceSpecialTab } from './DataProjectWorkspaceHost'
import { CONSOLE_SHORTCUT_LABEL, isConsoleShortcut } from './console/console-shortcut'
import {
  CONNECTION_STATE_LABEL,
  SAFE_MODE_INFO,
  SAFE_MODE_ORDER,
  describeDataProjectTarget,
  environmentColor
} from './data-project-ui'

/** ⌘⇧J (Ctrl+Shift+J elsewhere): free in the global map; TablePlus/DataGrip-style AI toggle. */
export const ASSISTANT_SHORTCUT_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘⇧J'
    : 'Ctrl+Shift+J'

export const isAssistantShortcut = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) &&
  event.shiftKey &&
  !event.altKey &&
  (event.key === 'j' || event.key === 'J' || event.code === 'KeyJ')

/** A modal (wizard, confirmation, settings, palette) is open over the view. */
const dialogOpen = (): boolean =>
  !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
  )

const toolbarButton =
  'h-6 gap-1 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground'

function formatSince(iso: string | undefined): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export interface DataProjectToolbarProps {
  project: DataProject
}

export function DataProjectToolbar({ project }: DataProjectToolbarProps): React.JSX.Element {
  // Select the stored object (stable reference); the default is built outside the selector.
  const storedStatus = useDataProjectStore((s) => s.statuses[project.id])
  const status: DataConnectionStatus = storedStatus ?? {
    dataProjectId: project.id,
    state: 'disconnected'
  }
  const assistantOpen = useDataProjectStore((s) => !!s.assistantOpenById[project.id])
  const safeMode = useSafeModeChange(project)
  const color = environmentColor(project)
  const production = project.environment === 'production'
  const flagged = production || project.environment === 'staging'
  const safeInfo = SAFE_MODE_INFO[project.safeMode]
  const busy = status.state === 'connecting'
  const live = status.state === 'connected' || busy

  const openSpecial = (kind: WorkspaceSpecialTab): void => {
    openWorkspaceSpecialTab(project, kind).catch((error) => {
      toast.error(error instanceof Error ? error.message : `Could not open ${kind}`)
    })
  }

  // ⌃⌘C opens (or focuses) the console log while this project is on screen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isConsoleShortcut(event) || dialogOpen()) return
      event.preventDefault()
      openWorkspaceSpecialTab(project, 'console').catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Could not open the console')
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [project])

  return (
    <div className="flex shrink-0 flex-col" data-testid="data-project-toolbar">
      <div
        className={cn('w-full shrink-0', production ? 'h-1' : 'h-[3px]')}
        style={{ backgroundColor: color }}
        data-testid="data-project-environment-bar"
        data-environment={project.environment}
        aria-hidden="true"
      />
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3"
        style={
          production
            ? { backgroundColor: `color-mix(in srgb, ${color} 9%, var(--card))` }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <DataProjectIcon
            engine={project.engine}
            icon={project.icon}
            iconColor={project.iconColor}
            size="md"
          />
          <span
            className="truncate text-[13px] font-semibold"
            data-testid="data-project-toolbar-name"
          >
            {project.name}
          </span>
          <span className="hidden truncate text-[12px] text-muted-foreground md:inline">
            {describeDataProjectTarget(project)}
          </span>
          {flagged && (
            <span
              className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]"
              style={{
                color: production ? '#ffffff' : color,
                backgroundColor: production
                  ? color
                  : `color-mix(in srgb, ${color} 18%, transparent)`
              }}
              data-testid="data-project-environment-badge-large"
            >
              {DATA_ENVIRONMENT_DEFAULTS[project.environment].label}
            </span>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={toolbarButton}
              data-testid="data-project-status-trigger"
              title={status.error ?? CONNECTION_STATE_LABEL[status.state]}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ConnectionStatusDot state={status.state} />
              )}
              <span className="hidden sm:inline">{CONNECTION_STATE_LABEL[status.state]}</span>
              {status.inTransaction && (
                <span className="rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                  TX
                </span>
              )}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-72"
            data-testid="data-project-status-menu"
          >
            <DropdownMenuLabel>{DATA_ENGINE_INFO[project.engine].label}</DropdownMenuLabel>
            <div className="flex flex-col gap-0.5 px-2 pb-1.5 text-[12px]">
              <StatusLine label="State" value={CONNECTION_STATE_LABEL[status.state]} />
              {status.serverVersion && (
                <StatusLine label="Server" value={status.serverVersion} mono />
              )}
              {status.currentDatabase && (
                <StatusLine label="Database" value={status.currentDatabase} mono />
              )}
              {formatSince(status.connectedAt) && (
                <StatusLine label="Since" value={formatSince(status.connectedAt) ?? ''} />
              )}
              {status.inTransaction && (
                <StatusLine label="Transaction" value="Open (uncommitted changes)" />
              )}
              {status.readOnlyUser && <StatusLine label="User" value="Read-only on the server" />}
              {status.notice && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  {status.notice}
                </p>
              )}
              {status.state === 'error' && status.error && (
                <p className="mt-1 break-words text-[11px] text-destructive">{status.error}</p>
              )}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void useDataProjectStore.getState().connect(project.id)}
              disabled={busy}
              data-testid="data-project-status-reconnect"
            >
              {live ? <RotateCw className="mr-2 h-4 w-4" /> : <Plug className="mr-2 h-4 w-4" />}
              {live ? 'Reconnect' : 'Connect'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void useDataProjectStore.getState().disconnect(project.id)}
              disabled={!live}
              data-testid="data-project-status-disconnect"
            >
              <Unplug className="mr-2 h-4 w-4" />
              Disconnect
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(toolbarButton, safeInfo.tone)}
              title={`Safe mode: ${safeInfo.label} — ${safeInfo.short}`}
              data-testid="data-project-safe-mode-trigger"
              data-safe-mode={project.safeMode}
            >
              <ShieldCheck className="size-3.5" />
              <span className="hidden sm:inline">{safeInfo.label}</span>
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-72"
            data-testid="data-project-safe-mode-menu"
          >
            <DropdownMenuLabel>Safe mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={project.safeMode}
              onValueChange={(value) => safeMode.request(value as DataSafeMode)}
            >
              {SAFE_MODE_ORDER.map((mode) => (
                <DropdownMenuRadioItem
                  key={mode}
                  value={mode}
                  data-testid={`data-project-safe-mode-${mode}`}
                >
                  <span className="flex flex-col">
                    <span className={cn('font-medium', SAFE_MODE_INFO[mode].tone)}>
                      {SAFE_MODE_INFO[mode].label}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {SAFE_MODE_INFO[mode].short}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="sm"
          className={toolbarButton}
          onClick={() => openSpecial('processes')}
          title={
            project.engine === 'sqlite'
              ? 'SQLite has no server processes'
              : 'Running queries on the server'
          }
          disabled={project.engine === 'sqlite'}
          data-testid="data-project-processes"
        >
          <Activity className="size-3.5" />
          <span className="hidden lg:inline">Processes</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={toolbarButton}
          onClick={() => openSpecial('history')}
          title="Query history"
          data-testid="data-project-history"
        >
          <History className="size-3.5" />
          <span className="hidden lg:inline">History</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={toolbarButton}
          onClick={() => openSpecial('saved')}
          title="Saved queries"
          data-testid="data-project-saved"
        >
          <Bookmark className="size-3.5" />
          <span className="hidden lg:inline">Saved</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={toolbarButton}
          onClick={() => openSpecial('console')}
          title={`Console: every statement sent to the server (${CONSOLE_SHORTCUT_LABEL})`}
          data-testid="data-project-console"
        >
          <ScrollText className="size-3.5" />
          <span className="hidden lg:inline">Console</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(toolbarButton, assistantOpen && 'bg-accent text-accent-foreground')}
          onClick={() => useDataProjectStore.getState().toggleAssistant(project.id)}
          title={`AI assistant (${ASSISTANT_SHORTCUT_LABEL})`}
          aria-pressed={assistantOpen}
          data-testid="data-project-assistant-toggle"
        >
          {assistantOpen ? <Sparkles className="size-3.5" /> : <Bot className="size-3.5" />}
          <span className="hidden lg:inline">Assistant</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-6 text-muted-foreground hover:text-foreground"
          onClick={() =>
            useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: project.id })
          }
          title="Edit connection…"
          aria-label="Edit connection"
          data-testid="data-project-edit-connection"
        >
          <Settings2 className="size-3.5" />
        </Button>
      </div>
      {safeMode.dialog}
    </div>
  )
}

function StatusLine({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate', mono && 'font-mono text-[11px]')} title={value}>
        {value}
      </span>
    </div>
  )
}
