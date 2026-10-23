// Sidebar presence of a data project (database connection):
// - DataProjectItem: a row in the merged project list, in ProjectItem's visual language (h-7
//   header row, 16px icon box, 13px semibold label, hover-revealed actions on the right). No
//   chevron: a data project has no worktrees, a click opens its database client in the main
//   pane (in front of the Pinned Board when that is on). Production gets a red inset edge.
// - PinnedDataProjectItem: the card in the sidebar's Pinned list.
// - DataProjectHeaderLabel: the title-bar label while a data project is open.
// - DataProjectMenuItems: the context menu shared by the row and the pinned card (Open, Edit
//   connection, Change icon, Safe mode ▸, Environment ▸, Pin, Duplicate, Copy URL, Disconnect,
//   Remove). Moving a production connection to a less strict safe mode asks first.
// The confirmation dialogs carry `data-db-dialog`: they can open from the sidebar while a
// worktree session is on screen, and Tab must move between their buttons, not flip that
// session's mode.

import { memo, useState } from 'react'
import {
  Copy,
  ExternalLink,
  Link2,
  Palette,
  Pin,
  PinOff,
  Plug,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
  Layers
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { HighlightedText } from '@/components/projects/HighlightedText'
import {
  CARD_CONTENT_COLUMN,
  CARD_PARENT_ROW,
  CARD_PARENT_ROW_ALIGN,
  CARD_TITLE_ACTIONS,
  CARD_TITLE_IS_DIM,
  CARD_TITLE_ROW,
  CARD_TITLE_ROW_LEFT,
  SECTION_HEADER_ACTIONS,
  SECTION_HEADER_ACTION_BUTTON,
  SECTION_HEADER_ICON_BOX,
  SECTION_HEADER_LABEL,
  SECTION_HEADER_LABEL_ROW,
  SECTION_HEADER_LABEL_WRAP,
  SECTION_HEADER_ROW,
  SECTION_HEADER_ROW_CLICKABLE,
  SECTION_HEADER_TITLE_SURFACE,
  SECTION_HEADER_WRAPPER_TOP_SPACING,
  WorkspaceCardSurface,
  getFlushWorktreeCardPaddingLeft,
  getProjectGroupHeaderPaddingLeft
} from '@/components/sidebar'
import { projectApi } from '@/api/project-api'
import { toast } from '@/lib/toast'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { buildConnectionUrl } from '@shared/data-projects/connection-url'
import {
  DATA_ENVIRONMENT_DEFAULTS,
  type DataConnectionState,
  type DataEnvironment,
  type DataProject,
  type DataSafeMode
} from '@shared/data-projects/types'
import { DataProjectIcon } from './DataProjectIcon'
import {
  CONNECTION_STATE_DOT,
  CONNECTION_STATE_LABEL,
  ENVIRONMENT_ORDER,
  SAFE_MODE_INFO,
  SAFE_MODE_ORDER,
  describeDataProjectTarget,
  describeDataProjectTooltip,
  environmentColor,
  isLessStrictSafeMode
} from './data-project-ui'

// ---------------------------------------------------------------------------------------------
// Safe mode changes (shared with the toolbar)
// ---------------------------------------------------------------------------------------------

/**
 * Changing a production connection to a less strict mode needs a confirmation (TablePlus asks
 * for the password; we ask explicitly). Returns `request(mode)` and the dialog to render.
 */
export function useSafeModeChange(project: DataProject): {
  request: (mode: DataSafeMode) => void
  dialog: React.JSX.Element
} {
  const setSafeMode = useDataProjectStore((s) => s.setSafeMode)
  const [pending, setPending] = useState<DataSafeMode | null>(null)

  const request = (mode: DataSafeMode): void => {
    if (mode === project.safeMode) return
    if (project.environment === 'production' && isLessStrictSafeMode(project.safeMode, mode)) {
      setPending(mode)
      return
    }
    void setSafeMode(project.id, mode)
  }

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent data-testid="data-project-safe-mode-confirm" data-db-dialog="">
        <AlertDialogHeader>
          <AlertDialogTitle>Loosen safe mode on production?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                <span className="font-semibold">{project.name}</span> is a production database.
                Switching from {SAFE_MODE_INFO[project.safeMode].label} to{' '}
                {pending ? SAFE_MODE_INFO[pending].label : ''} lets more statements run without a
                confirmation.
              </p>
              {pending && <p className="text-[12px]">{SAFE_MODE_INFO[pending].description}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus data-testid="data-project-safe-mode-confirm-cancel">
            Keep {SAFE_MODE_INFO[project.safeMode].label}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (pending) void setSafeMode(project.id, pending)
              setPending(null)
            }}
            data-testid="data-project-safe-mode-confirm-accept"
          >
            Switch to {pending ? SAFE_MODE_INFO[pending].label : ''}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { request, dialog }
}

// ---------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------

async function copyConnectionUrl(project: DataProject): Promise<void> {
  try {
    // Never with the password: "Copy URL" is safe to paste into a ticket or chat.
    await projectApi.copyToClipboard(buildConnectionUrl(project.engine, project.config))
    toast.success('Connection URL copied (without password)')
  } catch {
    toast.error('Failed to copy to clipboard')
  }
}

export interface DataProjectMenuItemsProps {
  project: DataProject
  connectionState: DataConnectionState
  onRequestSafeMode: (mode: DataSafeMode) => void
  onRemove: () => void
}

export function DataProjectMenuItems({
  project,
  connectionState,
  onRequestSafeMode,
  onRemove
}: DataProjectMenuItemsProps): React.JSX.Element {
  const store = useDataProjectStore.getState
  const live = connectionState === 'connected' || connectionState === 'connecting'
  return (
    <>
      <ContextMenuItem
        onClick={() => store().select(project.id)}
        data-testid="data-project-menu-open"
      >
        <ExternalLink className="mr-2 h-4 w-4" />
        Open
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => store().openWizard({ mode: 'edit', projectId: project.id })}
        data-testid="data-project-menu-edit"
      >
        <Settings2 className="mr-2 h-4 w-4" />
        Edit connection…
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => store().openIconDialog(project.id)}
        data-testid="data-project-menu-icon"
      >
        <Palette className="mr-2 h-4 w-4" />
        Change icon…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="data-project-menu-safe-mode">
          <ShieldCheck className="mr-2 h-4 w-4" />
          Safe mode
          <span className="ml-auto pl-3 text-[11px] text-muted-foreground">
            {SAFE_MODE_INFO[project.safeMode].label}
          </span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-64">
          <ContextMenuRadioGroup
            value={project.safeMode}
            onValueChange={(value) => onRequestSafeMode(value as DataSafeMode)}
          >
            {SAFE_MODE_ORDER.map((mode) => (
              <ContextMenuRadioItem
                key={mode}
                value={mode}
                data-testid={`data-project-menu-safe-mode-${mode}`}
              >
                <span className="flex flex-col">
                  <span className={cn('font-medium', SAFE_MODE_INFO[mode].tone)}>
                    {SAFE_MODE_INFO[mode].label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {SAFE_MODE_INFO[mode].short}
                  </span>
                </span>
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="data-project-menu-environment">
          <Layers className="mr-2 h-4 w-4" />
          Environment
          <span className="ml-auto pl-3 text-[11px] text-muted-foreground">
            {DATA_ENVIRONMENT_DEFAULTS[project.environment].label}
          </span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44">
          <ContextMenuRadioGroup
            value={project.environment}
            onValueChange={(value) =>
              void store().setEnvironment(project.id, value as DataEnvironment)
            }
          >
            {ENVIRONMENT_ORDER.map((environment) => (
              <ContextMenuRadioItem
                key={environment}
                value={environment}
                data-testid={`data-project-menu-environment-${environment}`}
              >
                <span
                  className="mr-2 inline-block size-2 rounded-full"
                  style={{ backgroundColor: DATA_ENVIRONMENT_DEFAULTS[environment].color }}
                />
                {DATA_ENVIRONMENT_DEFAULTS[environment].label}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => void store().setPinned(project.id, !project.pinned)}
        data-testid="data-project-menu-pin"
      >
        {project.pinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
        {project.pinned ? 'Unpin' : 'Pin'}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          void store()
            .duplicate(project.id)
            .then((copy) => copy && toast.success(`Created ${copy.name}`))
        }
        data-testid="data-project-menu-duplicate"
      >
        <Copy className="mr-2 h-4 w-4" />
        Duplicate
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => void copyConnectionUrl(project)}
        data-testid="data-project-menu-copy-url"
      >
        <Link2 className="mr-2 h-4 w-4" />
        Copy connection URL
      </ContextMenuItem>
      {live ? (
        <ContextMenuItem
          onClick={() => void store().disconnect(project.id)}
          data-testid="data-project-menu-disconnect"
        >
          <Unplug className="mr-2 h-4 w-4" />
          Disconnect
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          onClick={() => void store().connect(project.id)}
          data-testid="data-project-menu-connect"
        >
          <Plug className="mr-2 h-4 w-4" />
          Connect
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={onRemove}
        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
        data-testid="data-project-menu-remove"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Remove…
      </ContextMenuItem>
    </>
  )
}

export function RemoveDataProjectDialog({
  project,
  open,
  onOpenChange
}: {
  project: DataProject
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="data-project-remove-dialog" data-db-dialog="">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {project.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                The connection, its saved password, query history and saved queries are deleted from
                this Mac.
              </p>
              <p className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">
                {describeDataProjectTarget(project)}
              </p>
              <p>The database itself is not touched.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="data-project-remove-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              void useDataProjectStore
                .getState()
                .remove(project.id)
                .then((ok) => ok && toast.success(`Removed ${project.name}`))
            }}
            data-testid="data-project-remove-confirm"
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------------------------

export function ConnectionStatusDot({
  state,
  className,
  title
}: {
  state: DataConnectionState
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        CONNECTION_STATE_DOT[state],
        className
      )}
      title={title ?? CONNECTION_STATE_LABEL[state]}
      aria-label={CONNECTION_STATE_LABEL[state]}
      role="img"
      data-testid="data-project-status-dot"
      data-state={state}
    />
  )
}

function EnvironmentBadge({ project }: { project: DataProject }): React.JSX.Element | null {
  if (project.environment !== 'production' && project.environment !== 'staging') return null
  const color = environmentColor(project)
  return (
    <span
      className="shrink-0 rounded-[4px] px-1 py-px text-[9px] font-bold uppercase leading-none tracking-[0.06em]"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
      data-testid="data-project-environment-badge"
    >
      {project.environment === 'production' ? 'Prod' : 'Stg'}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Sidebar row
// ---------------------------------------------------------------------------------------------

export interface DataProjectItemProps {
  project: DataProject
  isFirst?: boolean
  nameMatchIndices?: number[]
  pathMatchIndices?: number[]
  isDraggable?: boolean
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent, id: string) => void
  onDragOver?: (e: React.DragEvent, id: string) => void
  onDrop?: (e: React.DragEvent, id: string) => void
  onDragEnd?: () => void
}

export const DataProjectItem = memo(function DataProjectItem({
  project,
  isFirst,
  nameMatchIndices,
  pathMatchIndices,
  isDraggable,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: DataProjectItemProps): React.JSX.Element {
  const isSelected = useDataProjectStore((s) => s.selectedDataProjectId === project.id)
  const connectionState = useDataProjectStore(
    (s) => s.statuses[project.id]?.state ?? 'disconnected'
  )
  // While worktrees are being picked for a connection, a database row is not a choice.
  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)
  const [removeOpen, setRemoveOpen] = useState(false)
  const safeMode = useSafeModeChange(project)
  const target = describeDataProjectTarget(project)
  const production = project.environment === 'production'
  const live = connectionState === 'connected' || connectionState === 'connecting'

  return (
    <div
      className={cn('flex flex-col', !isFirst && SECTION_HEADER_WRAPPER_TOP_SPACING)}
      data-data-project-group={project.id}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={connectionModeActive}>
          <div
            className={cn(
              SECTION_HEADER_ROW,
              SECTION_HEADER_ROW_CLICKABLE,
              'rounded-md',
              isSelected && 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground',
              isDragging && 'opacity-50',
              isDragOver && 'border-t border-ring',
              connectionModeActive && 'pointer-events-none opacity-50'
            )}
            style={{
              paddingLeft: getProjectGroupHeaderPaddingLeft(0),
              // Production is never subtle: a red inset edge on the row.
              ...(production ? { boxShadow: `inset 2px 0 0 ${environmentColor(project)}` } : {})
            }}
            draggable={!!isDraggable && !connectionModeActive}
            aria-disabled={connectionModeActive || undefined}
            onDragStart={onDragStart ? (e) => onDragStart(e, project.id) : undefined}
            onDragOver={onDragOver ? (e) => onDragOver(e, project.id) : undefined}
            onDrop={onDrop ? (e) => onDrop(e, project.id) : undefined}
            onDragEnd={onDragEnd}
            onClick={() => useDataProjectStore.getState().select(project.id)}
            title={describeDataProjectTooltip(project)}
            aria-current={isSelected ? 'page' : undefined}
            data-testid={`data-project-item-${project.id}`}
            data-selected={isSelected || undefined}
          >
            <div className={SECTION_HEADER_TITLE_SURFACE}>
              <div className={SECTION_HEADER_ICON_BOX}>
                <DataProjectIcon
                  engine={project.engine}
                  icon={project.icon}
                  iconColor={project.iconColor}
                  environment={project.environment}
                  environmentColorOverride={project.color}
                />
              </div>
              <div className={SECTION_HEADER_LABEL_WRAP}>
                <div className={SECTION_HEADER_LABEL_ROW}>
                  {nameMatchIndices ? (
                    <HighlightedText
                      text={project.name}
                      indices={nameMatchIndices}
                      className={SECTION_HEADER_LABEL}
                    />
                  ) : (
                    <span className={SECTION_HEADER_LABEL}>{project.name}</span>
                  )}
                  <EnvironmentBadge project={project} />
                  {connectionState !== 'disconnected' && (
                    <ConnectionStatusDot state={connectionState} />
                  )}
                </div>
                {pathMatchIndices && (
                  <HighlightedText
                    text={target}
                    indices={pathMatchIndices}
                    className="mt-1 block truncate text-[10px] leading-none text-muted-foreground"
                  />
                )}
              </div>
            </div>

            <div
              className={cn(
                SECTION_HEADER_ACTIONS,
                isSelected && 'can-hover:bg-worktree-sidebar-accent'
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={SECTION_HEADER_ACTION_BUTTON}
                aria-label={live ? `Disconnect ${project.name}` : `Connect ${project.name}`}
                title={live ? 'Disconnect' : 'Connect'}
                onClick={(e) => {
                  e.stopPropagation()
                  const store = useDataProjectStore.getState()
                  if (live) void store.disconnect(project.id)
                  else void store.connect(project.id)
                }}
                data-testid={`data-project-item-connect-${project.id}`}
              >
                {live ? <Unplug className="size-3" /> : <Plug className="size-3" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={SECTION_HEADER_ACTION_BUTTON}
                aria-label={`Edit ${project.name}`}
                title="Edit connection…"
                onClick={(e) => {
                  e.stopPropagation()
                  useDataProjectStore.getState().openWizard({ mode: 'edit', projectId: project.id })
                }}
                data-testid={`data-project-item-edit-${project.id}`}
              >
                <Settings2 className="size-3" />
              </Button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56" data-testid={`data-project-menu-${project.id}`}>
          <DataProjectMenuItems
            project={project}
            connectionState={connectionState}
            onRequestSafeMode={safeMode.request}
            onRemove={() => setRemoveOpen(true)}
          />
        </ContextMenuContent>
      </ContextMenu>
      <RemoveDataProjectDialog project={project} open={removeOpen} onOpenChange={setRemoveOpen} />
      {safeMode.dialog}
    </div>
  )
})

// ---------------------------------------------------------------------------------------------
// Pinned card
// ---------------------------------------------------------------------------------------------

export function PinnedDataProjectItem({ project }: { project: DataProject }): React.JSX.Element {
  const isSelected = useDataProjectStore((s) => s.selectedDataProjectId === project.id)
  const connectionState = useDataProjectStore(
    (s) => s.statuses[project.id]?.state ?? 'disconnected'
  )
  const [removeOpen, setRemoveOpen] = useState(false)
  const safeMode = useSafeModeChange(project)
  const production = project.environment === 'production'

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <WorkspaceCardSurface
            active={isSelected ? 'primary' : false}
            className="group/worktree-card"
            style={{
              paddingLeft: getFlushWorktreeCardPaddingLeft(0),
              ...(production ? { boxShadow: `inset 2px 0 0 ${environmentColor(project)}` } : {})
            }}
            onClick={() => useDataProjectStore.getState().select(project.id)}
            title={describeDataProjectTooltip(project)}
            data-testid={`pinned-data-project-${project.id}`}
          >
            <div className={cn(CARD_PARENT_ROW, CARD_PARENT_ROW_ALIGN)}>
              <span className="flex w-5 shrink-0 items-center justify-center pt-0.5">
                <ConnectionStatusDot state={connectionState} />
              </span>
              <div className={CARD_CONTENT_COLUMN}>
                <div className={CARD_TITLE_ROW}>
                  <div className={CARD_TITLE_ROW_LEFT}>
                    <DataProjectIcon
                      engine={project.engine}
                      icon={project.icon}
                      iconColor={project.iconColor}
                      environment={project.environment}
                      environmentColorOverride={project.color}
                    />
                    <span className={CARD_TITLE_IS_DIM}>{project.name}</span>
                    <EnvironmentBadge project={project} />
                  </div>
                  <div className={CARD_TITLE_ACTIONS}>
                    <button
                      type="button"
                      className="inline-flex size-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent/70 hover:text-foreground group-hover/worktree-card:opacity-100"
                      aria-label={`Unpin ${project.name}`}
                      title="Unpin"
                      onClick={(e) => {
                        e.stopPropagation()
                        void useDataProjectStore.getState().setPinned(project.id, false)
                      }}
                      data-testid={`pinned-data-project-unpin-${project.id}`}
                    >
                      <PinOff className="size-3" />
                    </button>
                  </div>
                </div>
                <span className="truncate text-[11px] leading-4 text-muted-foreground">
                  {describeDataProjectTarget(project)}
                </span>
              </div>
            </div>
          </WorkspaceCardSurface>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <DataProjectMenuItems
            project={project}
            connectionState={connectionState}
            onRequestSafeMode={safeMode.request}
            onRemove={() => setRemoveOpen(true)}
          />
        </ContextMenuContent>
      </ContextMenu>
      <RemoveDataProjectDialog project={project} open={removeOpen} onOpenChange={setRemoveOpen} />
      {safeMode.dialog}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Header label
// ---------------------------------------------------------------------------------------------

export function DataProjectHeaderLabel({ project }: { project: DataProject }): React.JSX.Element {
  const connectionState = useDataProjectStore(
    (s) => s.statuses[project.id]?.state ?? 'disconnected'
  )
  const target = describeDataProjectTarget(project)
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      title={describeDataProjectTooltip(project)}
      data-testid="header-data-project-info"
    >
      <DataProjectIcon
        engine={project.engine}
        icon={project.icon}
        iconColor={project.iconColor}
        environment={project.environment}
        environmentColorOverride={project.color}
      />
      <span className="truncate text-[12px] font-medium text-foreground">
        {project.name}
        <span className="font-normal text-muted-foreground"> {target}</span>
      </span>
      <EnvironmentBadge project={project} />
      <ConnectionStatusDot state={connectionState} />
    </span>
  )
}
