import {
  isConnectionRun,
  type DocumentRun,
  type DocumentRunMember
} from '@shared/types/document-flow'
import { gitApi } from '@/api/git-api'
import { pushAttachedPRUpdates } from '@/lib/connection-pr'
import { resolvePRContentGeneration } from '@/lib/pr-content-provider'
import { runCreatePRPipeline } from '@/lib/pr-pipeline'
import { useGitStore } from '@/stores/useGitStore'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

// The ticket of a launched run offers a PR button: a pull request from the run's integration
// branch into the branch it was cut from. A git run has one integration branch, so one PR; a
// connection run has one per member repository, so one PR each, created together. Every PR
// goes through the same pipeline as a ticket's PR (push, generated content, `gh pr create`,
// attach to the worktree), one notification card per repository.

/** One repository a run's PR button opens a pull request in. */
export interface DocumentRunPRTarget {
  worktreeId: string
  worktreePath: string
  projectId: string
  /** The member repository, named on the card and in notifications; null for a git run. */
  projectName: string | null
  projectPath: string | null
  /** Without a remote prefix, e.g. `main`: what `gh pr create --base` takes. */
  baseBranch: string
  /**
   * The commit the integration branch was cut from. The "anything to PR?" check counts from
   * it: the bare base name may not resolve locally (a base that exists only as
   * `origin/<base>` counts as 0 commits ahead, not as an error).
   */
  baseSha: string | null
  branchName: string
}

export interface DocumentRunPRResult {
  target: DocumentRunPRTarget
  ok: boolean
  prNumber?: number
  prUrl?: string
  /** The branch already had a PR: its updates were pushed instead. */
  existing?: boolean
  error?: string
}

const stripRemote = (branch: string): string => branch.replace(/^origin\//, '')

function memberTarget(member: DocumentRunMember): DocumentRunPRTarget {
  return {
    worktreeId: member.integration_worktree_id,
    worktreePath: member.integration_worktree_path,
    projectId: member.project_id,
    projectName: member.project_name,
    projectPath: member.project_path,
    baseBranch: stripRemote(member.base_branch),
    baseSha: member.base_sha,
    branchName: member.integration_branch
  }
}

/**
 * The repositories a run's PR button makes pull requests in: the members of a connection run,
 * the one integration worktree of a git run. Empty until the run is launched.
 */
export function documentRunPRTargets(
  run: DocumentRun,
  projects: readonly { id: string; path: string }[] = useProjectStore.getState().projects
): DocumentRunPRTarget[] {
  if (isConnectionRun(run)) return run.members.map(memberTarget)
  if (
    !run.integration_worktree_id ||
    !run.integration_worktree_path ||
    !run.integration_branch ||
    !run.base_branch
  ) {
    return []
  }
  return [
    {
      worktreeId: run.integration_worktree_id,
      worktreePath: run.integration_worktree_path,
      projectId: run.project_id,
      projectName: null,
      projectPath: projects.find((project) => project.id === run.project_id)?.path ?? null,
      baseBranch: stripRemote(run.base_branch),
      baseSha: run.base_sha,
      branchName: run.integration_branch
    }
  ]
}

async function createTargetPR(
  run: DocumentRun,
  target: DocumentRunPRTarget,
  generation: ReturnType<typeof resolvePRContentGeneration>
): Promise<DocumentRunPRResult> {
  const prefix = target.projectName ? `${target.projectName}: ` : ''
  const { show } = usePRNotificationStore.getState()
  const gitStore = useGitStore.getState()
  gitStore.setCreatingPR(target.worktreeId, true)
  try {
    if (!gitStore.remoteInfo.get(target.worktreeId)) {
      await gitStore.checkRemoteInfo(target.worktreeId, target.worktreePath)
    }
    if (!useGitStore.getState().remoteInfo.get(target.worktreeId)?.supportsPR) {
      const error = 'no GitHub or GitLab remote — PR skipped'
      show({ status: 'info', message: `${prefix}${error}`, worktreeId: target.worktreeId })
      return { target, ok: false, error }
    }

    const attached = useGitStore.getState().attachedPR.get(target.worktreeId) ?? null
    if (attached) {
      await pushAttachedPRUpdates(
        {
          worktreeId: target.worktreeId,
          worktreePath: target.worktreePath,
          branchName: target.branchName,
          attachedPR: attached
        },
        prefix
      )
      return { target, ok: true, existing: true, prNumber: attached.number, prUrl: attached.url }
    }

    // Nothing merged into the integration branch yet: say so instead of letting `gh` fail
    // after the content was generated. Counted from the base commit, which always resolves;
    // without one the check is skipped rather than trusting a count the base name may fake.
    let commitsAhead: number | null = null
    if (target.baseSha) {
      try {
        commitsAhead = (await gitApi.getRangeDiff(target.worktreePath, target.baseSha)).commitCount
      } catch {
        commitsAhead = null
      }
    }
    if (commitsAhead === 0) {
      const error = `nothing to PR — no commits ahead of ${target.baseBranch}`
      show({ status: 'warning', message: `${prefix}${error}`, worktreeId: target.worktreeId })
      return { target, ok: false, error }
    }

    const notifId = show({
      status: 'loading',
      message: `${prefix}Creating pull request...`,
      branchName: target.branchName,
      worktreeId: target.worktreeId
    })
    const result = await runCreatePRPipeline({
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      projectPath: target.projectPath,
      baseBranch: target.baseBranch,
      title: '',
      body: '',
      fallbackTitle: run.title,
      provider: generation?.provider ?? null,
      model: generation?.model,
      effort: generation?.effort,
      notifId,
      labelPrefix: prefix
    })
    return { target, ...result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    show({
      status: 'error',
      message: `${prefix}Failed to create pull request`,
      description: error,
      worktreeId: target.worktreeId
    })
    return { target, ok: false, error }
  } finally {
    useGitStore.getState().setCreatingPR(target.worktreeId, false)
  }
}

/**
 * Open a pull request from every integration branch of the run into its base branch, all at
 * once, one notification card each with the PR's link. A branch that already has a PR gets
 * its new commits pushed instead. Repositories fail independently.
 */
export async function createDocumentRunPRs(run: DocumentRun): Promise<DocumentRunPRResult[]> {
  const targets = documentRunPRTargets(run)
  if (targets.length === 0) return []
  const settings = useSettingsStore.getState()
  const generation = resolvePRContentGeneration(
    settings.prContentModel,
    settings.defaultAgentSdk ?? 'claude-code',
    settings.availableAgentSdks
  )
  return Promise.all(targets.map((target) => createTargetPR(run, target, generation)))
}
