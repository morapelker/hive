import { useCallback, useMemo, useState } from 'react'
import {
  Check,
  FilePenLine,
  FileX,
  GitBranch,
  MessageCircleQuestion,
  Radar,
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
  DocumentRunLaunchConfig,
  DocumentVerificationMethod
} from '@shared/types/document-flow'
import {
  LaunchConfigBadge,
  LaunchConfigChip,
  TonePill,
  VerificationChips
} from './DocumentFlowBadges'
import { LaunchConfigPopover } from './LaunchConfigPopover'
import { openSession } from './document-flow-navigation'
import {
  effectiveLaunchConfig,
  mergeLaunchConfigs,
  quickLaunchChoices,
  sameLaunchConfig
} from './document-flow-launch'
import {
  canEditLaunchConfig,
  canEditVerification,
  canRetryDocumentUpdate,
  canSkipDocumentUpdate,
  describeItemBranches,
  isActiveRunStatus,
  isPausedItem,
  isRequeueableItem,
  isSkippableItem,
  itemDetailDisplay,
  itemSessionTarget,
  itemStatusDisplay,
  needsUser,
  needsUserMessage,
  pluralize,
  toggleVerificationMethod
} from './document-flow-ui'

const SECTION_LABEL_CLASS = 'text-xs font-medium uppercase tracking-wider text-muted-foreground'

const MARK_DONE_TITLE = 'Treat the ticket as done and queue it for merging'
const MARK_DONE_WORKING_TITLE =
  'Its session is still working; wait for it to finish before marking the ticket done'

export interface RunItemActions {
  /** Item actions only make sense while the orchestrator still drives the run. */
  enabled: boolean
  /** The label of `open`. */
  openLabel: string
  /**
   * The item's session is visibly busy (the user answered it, say): what it is doing has to
   * land before the ticket can be declared done, or an unfinished branch gets merged.
   */
  isSessionWorking: (item: DocumentRunItem) => boolean
  open: (item: DocumentRunItem) => void
  retry: (item: DocumentRunItem) => void
  markDone: (item: DocumentRunItem) => void
  skip: (item: DocumentRunItem) => void
  /**
   * Put a merged item's failed or skipped document update back in the document edit lane, and
   * take one out of it.
   */
  retryDocumentUpdate: ((item: DocumentRunItem) => void) | null
  skipDocumentUpdate: ((item: DocumentRunItem) => void) | null
  /**
   * Ask a paused session now whether the monitors or wake-ups it holds the ticket with are
   * still needed, instead of at the end of its hold: the hold is expired, and the orchestrator
   * sends the wrap-up question on its next pass.
   */
  wrapUp: (item: DocumentRunItem) => void
  /** Flip one verification method of a ticket that has not launched yet. */
  toggleVerification: (item: DocumentRunItem, method: DocumentVerificationMethod) => void
  /** Change the model and effort of a ticket that has not launched yet; null = the run default. */
  setLaunchConfig: (
    item: DocumentRunItem,
    launchConfig: DocumentRunLaunchConfig | null
  ) => Promise<void>
  /** Give every ticket in `targets` the same model; each failure is reported on its own. */
  applyLaunchConfig: (
    targets: readonly DocumentRunItem[],
    launchConfig: DocumentRunLaunchConfig | null
  ) => Promise<void>
}

export function useRunItemActions(run: DocumentRun): RunItemActions {
  const retryItem = useDocumentFlowStore((s) => s.retryItem)
  const markItemDone = useDocumentFlowStore((s) => s.markItemDone)
  const skipItem = useDocumentFlowStore((s) => s.skipItem)
  const retryDocumentUpdate = useDocumentFlowStore((s) => s.retryDocumentUpdate)
  const skipDocumentUpdate = useDocumentFlowStore((s) => s.skipDocumentUpdate)
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
      openLabel: 'Open session',
      isSessionWorking: (item) => {
        const target = itemSessionTarget(run, item)
        const status = target ? sessionStatuses[target.sessionId]?.status : undefined
        return status === 'working' || status === 'planning'
      },
      open: (item) => {
        const target = itemSessionTarget(run, item)
        if (!target) return
        openSession(run.project_id, target.worktreeId, target.sessionId, target.connectionId)
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
      retryDocumentUpdate: (item) => {
        retryDocumentUpdate(run.id, item.id).catch(report(item, 'retry the document update of'))
      },
      skipDocumentUpdate: (item) => {
        skipDocumentUpdate(run.id, item.id).catch(report(item, 'skip the document update of'))
      },
      wrapUp: (item) => {
        updateItem(run.id, item.id, { wait_until: new Date().toISOString() }).catch(
          report(item, 'ask for the wrap-up of')
        )
      },
      toggleVerification: (item, method) => {
        updateItem(run.id, item.id, {
          verification: toggleVerificationMethod(item.verification, method)
        }).catch(report(item, 'change the verification of'))
      },
      setLaunchConfig: (item, launch_config) =>
        updateItem(run.id, item.id, { launch_config }).then(
          () => undefined,
          report(item, 'change the model of')
        ),
      applyLaunchConfig: async (targets, launch_config) => {
        await Promise.all(
          targets.map((item) =>
            updateItem(run.id, item.id, { launch_config }).then(
              () => undefined,
              report(item, 'change the model of')
            )
          )
        )
      }
    }
  }, [
    run,
    retryItem,
    markItemDone,
    skipItem,
    retryDocumentUpdate,
    skipDocumentUpdate,
    updateItem,
    closeDashboard,
    sessionStatuses
  ])
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
// size per row and the columns would stop lining up. The model track holds a badge, and on a
// ticket that has not launched the one-tap models too, which wrap under it.
const ROW_GRID_CLASS =
  'grid grid-cols-[14px_48px_minmax(0,1.5fr)_140px_minmax(0,1fr)_210px_186px_minmax(0,0.7fr)_104px] items-center gap-2 px-3'

const MODEL_TITLE = 'Change model and effort (until the ticket launches)'

/** Every ticket of the run in document order; the ones left out of the run come last. */
export function RunItemsTable({ run, items }: RunItemsProps): React.JSX.Element {
  const actions = useRunItemActions(run)
  const ordered = [
    ...items.filter((item) => item.selected),
    ...items.filter((item) => !item.selected)
  ]

  // The model of a ticket that has not launched is still open, like its verification. A model
  // any ticket settled on becomes a one-tap choice on every such row, and stays one for this
  // dashboard even when no ticket uses it any more. A model still being picked is held back:
  // the picker saves every step on the way to it. Same bookkeeping as the wizard preview.
  const [pickingItemIds, setPickingItemIds] = useState<readonly string[]>([])
  const [knownLaunchConfigs, setKnownLaunchConfigs] = useState<readonly DocumentRunLaunchConfig[]>(
    []
  )
  const setItemPicking = useCallback((itemId: string, picking: boolean): void => {
    setPickingItemIds((current) => {
      if (current.includes(itemId) === picking) return current
      return picking ? [...current, itemId] : current.filter((id) => id !== itemId)
    })
  }, [])
  const settledLaunchConfigs = mergeLaunchConfigs(
    knownLaunchConfigs,
    items.filter((item) => !pickingItemIds.includes(item.id)).map((item) => item.launch_config)
  )
  if (settledLaunchConfigs !== knownLaunchConfigs) setKnownLaunchConfigs(settledLaunchConfigs)
  // A ticket left out of the run has no board ticket and never launches: nothing to choose.
  const modelEditable = actions.enabled
    ? items.filter((item) => item.selected && canEditLaunchConfig(run, item))
    : []
  const quickChoices =
    modelEditable.length > 0
      ? quickLaunchChoices(settledLaunchConfigs, run.config.defaultLaunch)
      : []

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
            const detail = itemDetailDisplay(item, items)
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
                  className={cn(
                    'truncate',
                    detail.tone === 'warning'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground'
                  )}
                  title={detail.title ?? undefined}
                  data-testid={`docflow-row-detail-${item.key}`}
                >
                  {detail.text}
                </span>
                <ModelCell
                  run={run}
                  item={item}
                  editable={modelEditable.includes(item)}
                  others={modelEditable.filter(
                    (other) =>
                      other.id !== item.id &&
                      !sameLaunchConfig(other.launch_config, item.launch_config)
                  )}
                  quickChoices={quickChoices}
                  actions={actions}
                  onPickingChange={setItemPicking}
                />
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
                {/* A connection run names the branch in every member in the tooltip */}
                <span
                  className="flex min-w-0 items-center gap-1 text-muted-foreground"
                  title={describeItemBranches(run, item) ?? item.branch_name ?? undefined}
                  data-testid={`docflow-row-branch-${item.key}`}
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
                  {actions.enabled && isPausedItem(item) && (
                    <RowAction
                      label="Ask to wrap up"
                      title="Ask the session now whether its monitors are still needed, and to stop them if not"
                      testId={`docflow-row-wrap-up-${item.key}`}
                      onClick={() => actions.wrapUp(item)}
                    >
                      <Radar />
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
                  {/* The document update of a merged ticket: its own Retry and Skip, which
                      leave the merge and the ticket's status alone */}
                  {actions.retryDocumentUpdate && canRetryDocumentUpdate(run, item) && (
                    <RowAction
                      label="Retry document update"
                      testId={`docflow-row-retry-doc-${item.key}`}
                      onClick={() => actions.retryDocumentUpdate?.(item)}
                    >
                      <FilePenLine />
                    </RowAction>
                  )}
                  {actions.skipDocumentUpdate && canSkipDocumentUpdate(run, item) && (
                    <RowAction
                      label="Skip document update"
                      testId={`docflow-row-skip-doc-${item.key}`}
                      onClick={() => actions.skipDocumentUpdate?.(item)}
                    >
                      <FileX />
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

interface ModelCellProps {
  run: DocumentRun
  item: DocumentRunItem
  /** The ticket has not launched: its model can be changed, and copied to the others. */
  editable: boolean
  /** The other tickets that have not launched and are on a different model. */
  others: readonly DocumentRunItem[]
  quickChoices: ReturnType<typeof quickLaunchChoices>
  actions: RunItemActions
  onPickingChange: (itemId: string, picking: boolean) => void
}

/**
 * The model a ticket launches with. Read-only once launched; before that, the badge opens the
 * picker (which starts from the model the ticket would get, so one change of effort is one
 * step), the one-tap models sit under it, and the picker offers the same model to every other
 * ticket that has not launched.
 */
function ModelCell({
  run,
  item,
  editable,
  others,
  quickChoices,
  actions,
  onPickingChange
}: ModelCellProps): React.JSX.Element {
  const effective = effectiveLaunchConfig(item, run.config.defaultLaunch)
  const onItemPickingChange = useCallback(
    (picking: boolean) => onPickingChange(item.id, picking),
    [onPickingChange, item.id]
  )
  const badge = (
    <LaunchConfigBadge
      config={effective}
      inheritLabel="app default"
      testId={`docflow-row-model-${item.key}`}
    />
  )
  if (!editable) return <span className="flex min-w-0 overflow-hidden">{badge}</span>

  // The pressed chip already names the model; the trigger then only keeps its arrows.
  const usesQuickChoice = quickChoices.some((choice) =>
    sameLaunchConfig(choice.config, item.launch_config)
  )
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <LaunchConfigPopover
        itemKey={item.key}
        value={effective}
        badge={!usesQuickChoice && badge}
        inheritLabel="Run default"
        clearLabel="Use run default"
        title={MODEL_TITLE}
        testIdPrefix="docflow-row-model"
        onChange={(launch_config) => actions.setLaunchConfig(item, launch_config)}
        onPickingChange={onItemPickingChange}
        footer={
          others.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              title="Every ticket that has not launched yet gets this model too"
              data-testid={`docflow-row-model-apply-${item.key}`}
              onClick={() => void actions.applyLaunchConfig(others, item.launch_config)}
            >
              {item.launch_config
                ? `Also use for ${pluralize(others.length, 'other pending ticket')}`
                : `Use the run default for ${pluralize(others.length, 'other pending ticket')}`}
            </Button>
          )
        }
      />
      {quickChoices.length > 0 && (
        <span
          role="group"
          aria-label={`Quick models for ${item.key}`}
          data-testid={`docflow-row-quick-models-${item.key}`}
          className="flex min-w-0 flex-wrap items-center gap-1"
        >
          {quickChoices.map((choice, index) => {
            const pressed = sameLaunchConfig(choice.config, item.launch_config)
            return (
              <LaunchConfigChip
                key={choice.key}
                choice={choice}
                pressed={pressed}
                testId={`docflow-row-quick-model-${item.key}-${index}`}
                onClick={() => void actions.setLaunchConfig(item, pressed ? null : choice.config)}
              />
            )
          })}
        </span>
      )}
    </span>
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
