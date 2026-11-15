import { forwardRef, useState } from 'react'
import { Link, Loader2, Pin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMinuteClock } from '@/hooks/useMinuteClock'
import { useProjectAgentState } from '@/hooks/useProjectAgentState'
import { setProjectPinned } from '@/lib/project-pin'
import { formatOpenedAge, type ProjectAgentState } from '@/lib/recent-projects'
import { LanguageIcon } from './LanguageIcon'
import {
  AgentStateDot,
  SECTION_HEADER_ICON_BOX,
  SECTION_TONE_NEUTRAL,
  getProjectGroupHeaderPaddingLeft
} from '@/components/sidebar'

export interface RecentProjectRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The project's id: names the row and its parts for tests. */
  rowId: string
  name: string
  /** Shown on hover over the name (a path, a database target). */
  tooltip?: string
  icon: React.ReactNode
  /** When the project was last opened, in ms. */
  openedAt: number
  selected: boolean
  agentState: ProjectAgentState
  /** Pins the project. Without it the row has no pin button. */
  onPin?: () => void
  pinning?: boolean
  /** Replaces the name while the project is being renamed from this row. */
  nameEditor?: React.ReactNode
}

/**
 * One line of the sidebar's Recent section: icon, name, an agent indicator when one of the
 * project's agents is working or waiting on the user, and how long ago the project was opened.
 * On hover (or keyboard focus) the age gives way to a pin button.
 *
 * Presentation only: the owner supplies what a click, a right-click and the pin do. It forwards
 * its ref and props to the row element, so it can be a context-menu trigger.
 */
export const RecentProjectRow = forwardRef<HTMLDivElement, RecentProjectRowProps>(
  function RecentProjectRow(
    {
      rowId,
      name,
      tooltip,
      icon,
      openedAt,
      selected,
      agentState,
      onPin,
      pinning = false,
      nameEditor,
      className,
      style,
      ...rest
    },
    ref
  ): React.JSX.Element {
    const now = useMinuteClock()
    const age = formatOpenedAge(openedAt, now)
    const agentLabel =
      agentState === 'question' ? 'An agent is waiting for you' : 'An agent is working'

    return (
      <div
        ref={ref}
        {...rest}
        className={cn(
          'group relative flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left transition-colors',
          selected
            ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
            : 'hover:bg-worktree-sidebar-foreground/8',
          className
        )}
        style={{ paddingLeft: getProjectGroupHeaderPaddingLeft(0), ...style }}
        aria-current={selected ? 'page' : undefined}
        data-recent-project={rowId}
        data-testid={`recent-project-${rowId}`}
      >
        <div className={cn(SECTION_HEADER_ICON_BOX, SECTION_TONE_NEUTRAL)}>{icon}</div>

        {nameEditor ?? (
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none"
            title={tooltip}
            data-testid={`recent-project-name-${rowId}`}
          >
            {name}
          </span>
        )}

        {agentState && (
          <span
            className="flex shrink-0 items-center"
            title={agentLabel}
            data-testid={`recent-project-agent-${rowId}`}
            data-state={agentState}
          >
            <AgentStateDot state={agentState} size="sm" />
          </span>
        )}

        {/* The age and, in its place on hover, the pin button. Where nothing hovers (touch)
            both show side by side. */}
        <span className="relative flex h-5 shrink-0 items-center justify-end gap-1">
          <span
            className={cn(
              'min-w-5 text-right text-[11px] leading-none tabular-nums text-muted-foreground',
              onPin &&
                'can-hover:group-hover:invisible can-hover:group-has-[button:focus-visible]:invisible'
            )}
            title={`Opened ${new Date(openedAt).toLocaleString()}`}
            data-testid={`recent-project-age-${rowId}`}
          >
            {age}
          </span>
          {onPin && (
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default can-hover:pointer-events-none can-hover:absolute can-hover:right-0 can-hover:opacity-0 can-hover:group-hover:pointer-events-auto can-hover:group-hover:opacity-100 can-hover:focus-visible:pointer-events-auto"
              aria-label={`Pin ${name} to board`}
              title="Pin to board"
              disabled={pinning}
              onClick={(e) => {
                e.stopPropagation()
                onPin()
              }}
              data-testid={`recent-project-pin-${rowId}`}
            >
              {pinning ? <Loader2 className="size-3 animate-spin" /> : <Pin className="size-3" />}
            </button>
          )}
        </span>
      </div>
    )
  }
)

interface RecentGitProject {
  id: string
  name: string
  path: string
  kind?: 'git' | 'connection'
  language: string | null
  custom_icon: string | null
  detected_icon: string | null
  last_accessed_at: string
}

export interface RecentGitProjectRowProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'title'
> {
  project: RecentGitProject
  selected: boolean
  nameEditor?: React.ReactNode
}

/**
 * The Recent row of a git or connection project: its icon, the state of its agents, and a pin
 * button that puts the whole project on the Pinned Board. ProjectItem renders it as the trigger
 * of the project's own right-click menu.
 */
export const RecentGitProjectRow = forwardRef<HTMLDivElement, RecentGitProjectRowProps>(
  function RecentGitProjectRow({ project, selected, nameEditor, ...rest }, ref): React.JSX.Element {
    const isConnectionProject = project.kind === 'connection'
    const agentState = useProjectAgentState(project.id, isConnectionProject ? 'connection' : 'git')
    const [pinning, setPinning] = useState(false)

    const handlePin = (): void => {
      if (pinning) return
      setPinning(true)
      // Once pinned the project leaves Recent and this row with it.
      void setProjectPinned(project, true).finally(() => setPinning(false))
    }

    return (
      <RecentProjectRow
        ref={ref}
        {...rest}
        rowId={project.id}
        name={project.name}
        tooltip={project.path}
        icon={
          isConnectionProject ? (
            <Link className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <LanguageIcon
              language={project.language}
              customIcon={project.custom_icon}
              detectedIcon={project.detected_icon}
            />
          )
        }
        openedAt={Date.parse(project.last_accessed_at) || 0}
        selected={selected}
        agentState={agentState}
        onPin={handlePin}
        pinning={pinning}
        nameEditor={nameEditor}
      />
    )
  }
)
