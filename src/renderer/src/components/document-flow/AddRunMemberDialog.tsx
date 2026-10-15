import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { fireSetupScript } from '@/stores/useWorktreeStore'
import type { DocumentRun, DocumentRunMember } from '@shared/types/document-flow'
import { defaultBaseBranchLabel, runMemberCandidates } from './document-flow-ui'
import { NO_BASE_BRANCH_OPTIONS, useBaseBranchOptionsByPath } from './useBaseBranchOptions'

const SELECT_CLASS =
  'h-8 w-full rounded-md border border-input bg-background px-2.5 text-[12px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

interface AddRunMemberDialogProps {
  run: DocumentRun & { members: DocumentRunMember[] }
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Add repository" on the dashboard of a launched connection run: pick a git project and the
 * branch its integration branch is cut from (its current branch by default), and the run takes
 * it as if it had been a member from the start — the project joins the connection project, gets
 * an integration worktree in the run's instance and a worktree in every ticket instance at work,
 * and tickets launched from now on get one too. The new integration worktree's dependencies are
 * installed like a launch does.
 */
export function AddRunMemberDialog({
  run,
  open,
  onOpenChange
}: AddRunMemberDialogProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const addRunMember = useDocumentFlowStore((s) => s.addRunMember)
  const candidates = useMemo(
    () => runMemberCandidates(projects, run.members),
    [projects, run.members]
  )
  const [projectId, setProjectId] = useState<string>('')
  const [baseBranch, setBaseBranch] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const selected = candidates.find((candidate) => candidate.id === projectId) ?? candidates[0]
  const branches =
    useBaseBranchOptionsByPath(selected ? [selected.path] : [])[selected?.path ?? ''] ??
    NO_BASE_BRANCH_OPTIONS

  // Opened again: start from the first candidate and its current branch.
  useEffect(() => {
    if (open) {
      setProjectId('')
      setBaseBranch('')
    }
  }, [open])

  const submit = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      const detail = await addRunMember(run.id, selected.id, baseBranch || null)
      const member = detail.run.members?.find((candidate) => candidate.project_id === selected.id)
      // The server created the worktree, so nothing has installed its dependencies.
      if (member) {
        fireSetupScript(member.project_id, member.integration_worktree_id, member.integration_worktree_path)
      }
      toast.success(
        member
          ? `${selected.name} joined the run on ${member.integration_branch}`
          : `${selected.name} joined the run`
      )
      onOpenChange(false)
    } catch (cause) {
      toast.error(`Could not add ${selected.name}: ${errorMessage(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-[440px]" data-docflow-dialog="" data-testid="docflow-add-member-dialog">
        <DialogHeader>
          <DialogTitle>Add a repository to the run</DialogTitle>
          <DialogDescription>
            The repository joins {run.title || 'the run'} as if it had been a member from the
            start: it gets an integration branch cut from the base branch below, every ticket
            already at work gets a worktree in it, and tickets launched from now on do too.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-[12px] text-muted-foreground" data-testid="docflow-add-member-none">
            Every repository in the app is already a member of this run.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="docflow-add-member-project" className="text-[12px] text-foreground">
                Repository
              </label>
              <select
                id="docflow-add-member-project"
                data-testid="docflow-add-member-project"
                className={SELECT_CLASS}
                value={selected?.id ?? ''}
                disabled={busy}
                onChange={(event) => {
                  setProjectId(event.target.value)
                  setBaseBranch('')
                }}
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="docflow-add-member-branch" className="text-[12px] text-foreground">
                Base branch
              </label>
              <select
                id="docflow-add-member-branch"
                data-testid="docflow-add-member-branch"
                className={SELECT_CLASS}
                value={baseBranch}
                disabled={busy}
                onChange={(event) => setBaseBranch(event.target.value)}
              >
                <option value="">{defaultBaseBranchLabel(branches.current)}</option>
                {branches.names.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
              {branches.error && (
                <p className="text-[11px] text-destructive" data-testid="docflow-add-member-branch-error">
                  {branches.error}
                </p>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            data-testid="docflow-add-member-cancel"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !selected}
            data-testid="docflow-add-member-submit"
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add repository
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
