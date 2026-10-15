import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DocumentRun } from '@shared/types/document-flow'
import { createDocumentRunPRs, documentRunPRTargets } from '@/lib/document-flow/run-prs'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useGitStore } from '@/stores/useGitStore'
import { useProjectStore } from '@/stores/useProjectStore'

/** The PR a ticket row carries; a git run's ticket shares its integration worktree's PR. */
export interface TicketPRFields {
  github_pr_number: number | null
  github_pr_url: string | null
}

export interface DocumentRunPRLink {
  worktreeId: string
  /** The member repository for a connection run; null for a git run. */
  projectName: string | null
  number: number
  url: string
}

export interface DocumentRunPRs {
  run: DocumentRun | null
  /** Empty until the run is launched: then there is nothing to make a PR from. */
  targets: ReturnType<typeof documentRunPRTargets>
  /** The PRs the integration branches already have, in target order. */
  links: DocumentRunPRLink[]
  /** A PR is being created or pushed for at least one target. */
  creating: boolean
  /** "Create PR" / "Create PRs" until every target has one; then "Update PR(s)". */
  label: string
  create: () => Promise<void>
}

/**
 * What the PR row of a run knows (the ticket card's links, the dashboard's button): the
 * repositories to PR in, the PRs they already have (from the integration worktrees' attached
 * PRs, or the ticket's own PR fields for a git run whose worktree is gone), and whether a PR is
 * on its way.
 */
export function useDocumentRunPRs(runId: string, ticket: TicketPRFields): DocumentRunPRs {
  const run = useDocumentFlowStore((s) => s.runsById[runId]?.run ?? null)
  const projects = useProjectStore((s) => s.projects)
  const targets = useMemo(
    () => (run ? documentRunPRTargets(run, projects) : []),
    [run, projects]
  )
  const worktreeIds = useMemo(() => targets.map((target) => target.worktreeId), [targets])
  const attached = useGitStore(
    useShallow((s) => worktreeIds.map((id) => s.attachedPR.get(id) ?? null))
  )
  const creatingFlags = useGitStore(
    useShallow((s) => worktreeIds.map((id) => s.creatingPRByWorktreeId.get(id) ?? false))
  )

  const links = useMemo<DocumentRunPRLink[]>(() => {
    const result: DocumentRunPRLink[] = []
    targets.forEach((target, index) => {
      let pr = attached[index]
      if (!pr && target.projectName === null && ticket.github_pr_number && ticket.github_pr_url) {
        pr = { number: ticket.github_pr_number, url: ticket.github_pr_url }
      }
      if (pr) {
        result.push({
          worktreeId: target.worktreeId,
          projectName: target.projectName,
          number: pr.number,
          url: pr.url
        })
      }
    })
    return result
  }, [targets, attached, ticket.github_pr_number, ticket.github_pr_url])

  const creating = creatingFlags.some(Boolean)
  const plural = targets.length > 1
  const label =
    targets.length > 0 && links.length === targets.length
      ? plural
        ? 'Update PRs'
        : 'Update PR'
      : plural
        ? 'Create PRs'
        : 'Create PR'

  const create = useCallback(async () => {
    if (!run) return
    await createDocumentRunPRs(run)
  }, [run])

  return { run, targets, links, creating, label, create }
}
