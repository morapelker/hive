import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCheck, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { runKindNoun } from '@/components/document-flow/document-flow-ui'
import {
  loadMergedChildrenPlan,
  moveMergedChildrenToDone,
  type MergedChild,
  type MergedChildrenPlan,
  type MergedChildrenTarget
} from '@/lib/document-flow/run-merged-children'
import { runTitle } from '@/lib/document-flow/ticket-run-membership'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useRunMergedChildrenStore } from '@/stores/useRunMergedChildrenStore'

type PlanState =
  | { status: 'loading' }
  | { status: 'ready'; plan: MergedChildrenPlan }
  | { status: 'error'; message: string }

const Code = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <code className="whitespace-nowrap rounded bg-muted px-1">{children}</code>
)

/** The branch (and, on a connection project, the repositories) a ticket's worktrees are of. */
function worktreeNames(child: MergedChild): string {
  const [first] = child.worktrees
  const repositories = child.worktrees.flatMap((w) => (w.projectName ? [w.projectName] : []))
  return repositories.length > 0 ? `${first.branch} in ${repositories.join(', ')}` : first.branch
}

/** What happens to the ticket's worktree, under its name in the list. */
function WorktreeLine({ child, archive }: { child: MergedChild; archive: boolean }): React.JSX.Element {
  const inDone = child.ticketIds.length === 0 ? 'Already in Done · ' : ''
  if (child.worktrees.length > 0) {
    return (
      <span className="text-[11px] text-muted-foreground">
        {inDone}
        {archive ? 'Archives' : 'Keeps'} <Code>{worktreeNames(child)}</Code>
      </span>
    )
  }
  if (child.worktreeKept) {
    return (
      <span className="text-[11px] text-amber-500">
        {inDone}Worktree kept: {child.worktreeKept}
      </span>
    )
  }
  return <span className="text-[11px] text-muted-foreground">No worktree left to archive</span>
}

/**
 * The board's "Move merged tickets to Done" dialog, opened from the context menu of a run's
 * own ticket (see run-merged-children.ts): it lists the run's tickets that are merged into the
 * integration branch and finished with, says for each what becomes of its worktree, and names
 * the merged ones that are held back. Confirming moves the checked tickets to Done and
 * archives their worktrees; the run's ticket and its branch stay as they are.
 */
export function RunMergedChildrenDialog(): React.JSX.Element {
  const target = useRunMergedChildrenStore((s) => s.target)
  const close = useRunMergedChildrenStore((s) => s.close)
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] max-w-md flex-col"
        data-testid="run-merged-children-dialog"
      >
        {/* Mounted per opening: each starts from a fresh check of the run's branches */}
        {target && <MergedChildrenBody key={target.runId} target={target} onClose={close} />}
      </DialogContent>
    </Dialog>
  )
}

function MergedChildrenBody({
  target,
  onClose
}: {
  target: MergedChildrenTarget
  onClose: () => void
}): React.JSX.Element {
  const run = useDocumentFlowStore((s) => s.runsById[target.runId]?.run)
  const [state, setState] = useState<PlanState>({ status: 'loading' })
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [archive, setArchive] = useState(true)
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadMergedChildrenPlan(target).then(
      (plan) => {
        if (cancelled) return
        setState(
          plan ? { status: 'ready', plan } : { status: 'error', message: 'The run no longer exists.' }
        )
      },
      (err) => {
        if (cancelled) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [target])

  const plan = state.status === 'ready' ? state.plan : null
  const children = plan?.children ?? []
  const held = plan?.held ?? []
  const checked = children.filter((child) => !unchecked.has(child.itemId))
  // With the worktrees kept, a ticket that is in Done already has nothing left to do
  const chosen = checked.filter(
    (child) => child.ticketIds.length > 0 || (archive && child.worktrees.length > 0)
  )
  const ticketCount = chosen.filter((child) => child.ticketIds.length > 0).length
  const archivable = checked.reduce((count, child) => count + child.worktrees.length, 0)
  const anyWorktree = children.some((child) => child.worktrees.length > 0)
  const noun = runKindNoun(run)
  const branch = run?.integration_branch ?? null

  const toggle = (itemId: string, on: boolean): void => {
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (on) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const handleConfirm = async (): Promise<void> => {
    if (chosen.length === 0) return
    setMoving(true)
    try {
      await moveMergedChildrenToDone(target, chosen, { archiveWorktrees: archive })
      onClose()
    } catch (err) {
      toast.error(
        `Could not move the tickets: ${err instanceof Error ? err.message : String(err)}`
      )
      setMoving(false)
    }
  }

  const confirmLabel =
    ticketCount > 0
      ? `Move ${ticketCount} to Done`
      : `Archive ${archivable} worktree${archivable === 1 ? '' : 's'}`

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 pr-6 text-sm">
          <CheckCheck className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            Move merged tickets to Done
            {run && <span className="font-normal text-muted-foreground"> — {runTitle(run)}</span>}
          </span>
        </DialogTitle>
        <DialogDescription className="text-xs">
          The tickets of this {noun} that are merged
          {branch ? (
            <>
              {' '}
              into <Code>{branch}</Code>
            </>
          ) : null}{' '}
          and finished with move to Done. The {noun}&rsquo;s own ticket
          {branch ? (
            <>
              {' '}
              and <Code>{branch}</Code> stay
            </>
          ) : (
            ' stays'
          )}{' '}
          as {branch ? 'they are' : 'it is'}.
        </DialogDescription>
      </DialogHeader>

      {state.status === 'loading' && (
        <div
          className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
          data-testid="run-merged-children-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking the merged branches...
        </div>
      )}

      {state.status === 'error' && (
        <p
          className="flex items-start gap-1.5 text-xs text-amber-500"
          data-testid="run-merged-children-error"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">Could not check the branches: {state.message}</span>
        </p>
      )}

      {plan && children.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="run-merged-children-empty">
          No merged ticket of this {noun} is waiting to be moved.
        </p>
      )}

      {children.length > 0 && (
        <ul
          className="min-h-0 flex-1 space-y-1 overflow-y-auto scrollbar-sleek rounded-md border border-border/60 bg-muted/10 p-1.5"
          data-testid="run-merged-children-list"
        >
          {children.map((child) => {
            const on = !unchecked.has(child.itemId)
            return (
              <li key={child.itemId}>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-accent/40',
                    !on && 'opacity-60'
                  )}
                  data-testid={`run-merged-child-${child.itemId}`}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={on}
                    disabled={moving}
                    onCheckedChange={(next) => toggle(child.itemId, next)}
                    aria-label={child.label}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="break-words text-xs">{child.label}</span>
                    <WorktreeLine child={child} archive={archive} />
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {anyWorktree && (
        <label className="flex shrink-0 cursor-pointer items-start gap-2 text-xs">
          <Checkbox
            className="mt-0.5"
            checked={archive}
            disabled={moving}
            onCheckedChange={setArchive}
            data-testid="run-merged-children-archive"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>
              Archive their worktrees{archive && archivable > 0 ? ` (${archivable})` : ''}
            </span>
            <span className="text-[11px] text-muted-foreground">
              Removes each worktree and deletes its branch
              {branch ? (
                <>
                  : the work is on <Code>{branch}</Code>
                </>
              ) : null}
              .
            </span>
          </span>
        </label>
      )}

      {held.length > 0 && (
        <div
          className="flex min-h-0 shrink-0 items-start gap-1.5 text-xs text-amber-500"
          data-testid="run-merged-children-held"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
            <span>
              Merged, but left as {held.length === 1 ? 'it is' : `they are (${held.length})`}:
            </span>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto scrollbar-sleek rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
              {held.map((entry) => (
                <li key={entry.itemId} className="break-words">
                  {entry.label} ({entry.reason})
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={moving}>
          {children.length > 0 ? 'Cancel' : 'Close'}
        </Button>
        {children.length > 0 && (
          <Button
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={moving || chosen.length === 0}
            data-testid="run-merged-children-confirm"
          >
            {moving ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <CheckCheck className="mr-1 h-3 w-3" />
            )}
            {confirmLabel}
          </Button>
        )}
      </div>
    </>
  )
}
