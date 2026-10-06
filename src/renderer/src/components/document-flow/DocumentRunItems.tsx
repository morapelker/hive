import { useMemo } from 'react'
import {
  Check,
  GitBranch,
  MessageCircleQuestion,
  RotateCcw,
  SkipForward,
  SquareArrowOutUpRight
} from 'lucide-react'
import { AgentStateDot } from '@/components/sidebar/AgentStateDot'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import type {
  DocumentRun,
  DocumentRunItem,
  DocumentVerificationMethod
} from '@shared/types/document-flow'
import { LaunchConfigBadge, TonePill, VerificationChips } from './DocumentFlowBadges'
import { openSession } from './document-flow-navigation'
import { effectiveLaunchConfig } from './document-flow-launch'
import {
  canEditVerification,
  isActiveRunStatus,
  isRequeueableItem,
  isSkippableItem,
  itemSessionTarget,
  itemStatusDisplay,
  needsUser,
  needsUserMessage,
  toggleVerificationMethod
} from './document-flow-ui'

const SECTION_LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

const MARK_DONE_TITLE = 'Treat the ticket as done and queue it for merging'
const MARK_DONE_WORKING_TITLE =
  'Its session is still working; wait for it to finish before marking the ticket done'

interface RunItemActions {
  /** Item actions only make sense while the orchestrator still drives the run. */
  enabled: boolean
  /**
   * The item's session is visibly busy (the user answered it, say): what it is doing has to
   * land before the ticket can be declared done, or an unfinished branch gets merged.
   */
  isSessionWorking: (item: DocumentRunItem) => boolean
  open: (item: DocumentRunItem) => void
  retry: (item: DocumentRunItem) => void
  markDone: (item: DocumentRunItem) => void
  skip: (item: DocumentRunItem) => void
  /** Flip one verification method of a ticket that has not launched yet. */
  toggleVerification: (item: DocumentRunItem, method: DocumentVerificationMethod) => void
}

function useRunItemActions(run: DocumentRun): RunItemActions {
  const retryItem = useDocumentFlowStore((s) => s.retryItem)
  const markItemDone = useDocumentFlowStore((s) => s.markItemDone)
  const skipItem = useDocumentFlowStore((s) => s.skipItem)
  const updateItem = useDocumentFlowStore((s) => s.updateItem)
  const closeDashboard = useDocumentFlowStore((s) => s.closeDashboard)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)

  return useMemo(() => {
    const report =
      (item: DocumentRunItem, action: string) =>
      (cause: unknown): void => {
        toast.error(
          `Could not ${action} ${item.key}: ${cause instanceof Error ? cause.message : String(cause)}`
        )
      }
    return {
      enabled: isActiveRunStatus(run.status),
      isSessionWorking: (item) => {
        const target = itemSessionTarget(run, item)
        const status = target ? sessionStatuses[target.sessionId]?.status : undefined
        return status === 'working' || status === 'planning'
      },
      open: (item) => {
        const target = itemSessionTarget(run, item)
        if (!target) return
        openSession(run.project_id, target.worktreeId, target.sessionId)
        closeDashboard()
      },
      retry: (item) => {
        retryItem(run.id, item.id).catch(report(item, 'retry'))
      },
      markDone: (item) => {
        markItemDone(run.id, item.id).catch(report(item, 'mark done'))
      },
      skip: (item) => {
        skipItem(run.id, item.id).catch(report(item, 'skip'))
      },
      toggleVerification: (item, method) => {
        updateItem(run.id, item.id, {
          verification: toggleVerificationMethod(item.verification, method)
        }).catch(report(item, 'change the verification of'))
      }
    }
  }, [run, retryItem, markItemDone, skipItem, updateItem, closeDashboard, sessionStatuses])
}

interface RunItemsProps {
  run: DocumentRun
  items: readonly DocumentRunItem[]
}

/** The items the run cannot get past without the user, with the question each one has. */
export function NeedsYouSection({ run, items }: RunItemsProps): React.JSX.Element | null {
  const actions = useRunItemActions(run)
  const waiting = items.filter(needsUser)
  if (waiting.length === 0) return null

  return (
    <section
      className="rounded-[8px] border border-amber-500/30 bg-amber-500/5"
      data-testid="docflow-needs-you"
    >
      <p className="flex items-center gap-1.5 px-3 pt-2.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
        <MessageCircleQuestion className="h-3.5 w-3.5" />
        Needs you ({waiting.length})
      </p>
      <div className="divide-y divide-amber-500/20">
        {waiting.map((item) => {
          const status = itemStatusDisplay(item, items)
          const canRequeue = actions.enabled && isRequeueableItem(item)
          const sessionWorking = canRequeue && actions.isSessionWorking(item)
          return (
            <div
              key={item.id}
              className="space-y-1.5 px-3 py-2.5"
              data-testid={`docflow-needs-you-${item.key}`}
            >
              <div className="flex items-center gap-2">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {item.key}
                </span>
                <span className="truncate text-[13px] font-medium text-foreground">
                  {item.title}
                </span>
                <TonePill tone={status.tone} className="shrink-0">
                  {status.label}
                </TonePill>
              </div>
              <p
                className="whitespace-pre-wrap break-words text-[12px] leading-snug text-foreground/90"
                data-testid={`docflow-needs-you-reason-${item.key}`}
              >
                {needsUserMessage(item)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {itemSessionTarget(run, item) && (
                  <Button
                    type="button"
                    size="sm"
                    data-testid={`docflow-needs-you-open-${item.key}`}
                    onClick={() => actions.open(item)}
                  >
                    Open session
                  </Button>
                )}
                {canRequeue && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title="Judge the session's result again, or relaunch the ticket"
                      data-testid={`docflow-needs-you-retry-${item.key}`}
                      onClick={() => actions.retry(item)}
                    >
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title={sessionWorking ? MARK_DONE_WORKING_TITLE : MARK_DONE_TITLE}
                      disabled={sessionWorking}
                      data-testid={`docflow-needs-you-done-${item.key}`}
                      onClick={() => actions.markDone(item)}
                    >
                      Mark done &amp; merge
                    </Button>
                  </>
                )}
                {actions.enabled && isSkippableItem(item) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    title="Leave this ticket out; tickets that depend on it stop waiting"
                    data-testid={`docflow-needs-you-skip-${item.key}`}
                    onClick={() => actions.skip(item)}
                  >
                    Skip
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// Every row is its own grid, so each track has a fixed or fractional size: an `auto` track would
// size per row and the columns would stop lining up.
const ROW_GRID_CLASS =
  'grid grid-cols-[14px_48px_minmax(0,1.5fr)_150px_minmax(0,1.2fr)_130px_186px_minmax(0,0.8fr)_104px] items-center gap-2 px-3'

/** Every ticket of the run in document order; the ones left out of the run come last. */
export function RunItemsTable({ run, items }: RunItemsProps): React.JSX.Element {
  const actions = useRunItemActions(run)
  const ordered = [
    ...items.filter((item) => item.selected),
    ...items.filter((item) => !item.selected)
  ]

  return (
    <section className="space-y-1.5" data-testid="docflow-items">
      <p className={SECTION_LABEL_CLASS}>Tickets</p>
      <div className="rounded-[8px] border border-border">
        <div
          className={cn(
            ROW_GRID_CLASS,
            'border-b border-border py-1.5 text-[11px] text-muted-foreground'
          )}
        >
          <span />
          <span>Task</span>
          <span>Title</span>
          <span>Status</span>
          <span>Detail</span>
          <span>Model</span>
          <span>Verify by</span>
          <span>Branch</span>
          <span />
        </div>
        <div className="divide-y divide-border/60">
          {ordered.map((item) => {
            const status = itemStatusDisplay(item, items)
            const canRequeue = actions.enabled && isRequeueableItem(item)
            const sessionWorking = canRequeue && actions.isSessionWorking(item)
            return (
              <div
                key={item.id}
                className={cn(ROW_GRID_CLASS, 'py-1.5 text-[12px]', !item.selected && 'opacity-50')}
                data-testid={`docflow-row-${item.key}`}
              >
                <AgentStateDot state={status.dot} />
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {item.key}
                </span>
                <span className="truncate text-foreground" title={item.title}>
                  {item.title}
                </span>
                <span className="min-w-0">
                  <TonePill
                    tone={status.tone}
                    className="max-w-full"
                    title={status.label}
                    testId={`docflow-row-status-${item.key}`}
                  >
                    <span className="truncate">{status.label}</span>
                  </TonePill>
                </span>
                <span
                  className="truncate text-muted-foreground"
                  title={item.status_detail ?? undefined}
                  data-testid={`docflow-row-detail-${item.key}`}
                >
                  {item.status_detail}
                </span>
                <span className="flex min-w-0 overflow-hidden">
                  <LaunchConfigBadge
                    config={effectiveLaunchConfig(item, run.config.defaultLaunch)}
                    inheritLabel="app default"
                  />
                </span>
                <span className="flex min-w-0 overflow-hidden">
                  {/* Still open while the ticket waits its turn; fixed once its brief was sent. */}
                  <VerificationChips
                    itemKey={item.key}
                    item={item}
                    disabled={run.config.verificationDisabled}
                    readOnly={!(actions.enabled && canEditVerification(run, item))}
                    onToggle={(method) => actions.toggleVerification(item, method)}
                    testIdPrefix="docflow-row-verify"
                  />
                </span>
                <span
                  className="flex min-w-0 items-center gap-1 text-muted-foreground"
                  title={item.branch_name ?? undefined}
                >
                  {item.branch_name && (
                    <>
                      <GitBranch className="h-3 w-3 shrink-0" />
                      <span className="truncate font-mono text-[11px]">{item.branch_name}</span>
                    </>
                  )}
                </span>
                <span className="flex items-center justify-end gap-0.5">
                  {itemSessionTarget(run, item) && (
                    <RowAction
                      label="Open session"
                      testId={`docflow-row-open-${item.key}`}
                      onClick={() => actions.open(item)}
                    >
                      <SquareArrowOutUpRight />
                    </RowAction>
                  )}
                  {canRequeue && (
                    <>
                      <RowAction
                        label="Retry"
                        testId={`docflow-row-retry-${item.key}`}
                        onClick={() => actions.retry(item)}
                      >
                        <RotateCcw />
                      </RowAction>
                      <RowAction
                        label="Mark done & merge"
                        title={sessionWorking ? MARK_DONE_WORKING_TITLE : undefined}
                        disabled={sessionWorking}
                        testId={`docflow-row-done-${item.key}`}
                        onClick={() => actions.markDone(item)}
                      >
                        <Check />
                      </RowAction>
                    </>
                  )}
                  {actions.enabled && isSkippableItem(item) && (
                    <RowAction
                      label="Skip"
                      testId={`docflow-row-skip-${item.key}`}
                      onClick={() => actions.skip(item)}
                    >
                      <SkipForward />
                    </RowAction>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function RowAction({
  label,
  title,
  disabled,
  testId,
  onClick,
  children
}: {
  label: string
  /** Replaces the label as tooltip, e.g. to say why the action is disabled. */
  title?: string
  disabled?: boolean
  testId: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className="text-muted-foreground hover:text-foreground"
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
