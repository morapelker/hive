import { gitApi } from '@/api/git-api'
import { runCreatePRPipeline } from '@/lib/pr-pipeline'
import type { PRContentProvider } from '@/lib/pr-content-provider'
import { useGitStore } from '@/stores/useGitStore'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The slice of a connection member the PR flow needs */
export interface ConnectionPRMember {
  worktree_id: string
  project_id: string
  project_name: string
  worktree_path: string
  worktree_branch: string
}

export interface MemberAssessment {
  worktreeId: string
  worktreePath: string
  projectId: string
  projectName: string
  projectPath: string | null
  branchName: string
  isDefaultWorktree: boolean
  isGitHub: boolean
  hasUncommitted: boolean
  /** Commits ahead of defaultBase (`getRangeDiff`) — 0 on backend errors */
  commitsAhead: number
  /** Commits ahead of the tracking branch — guards against false 0s above */
  trackingAhead: number
  /** Base branch without remote prefix, e.g. 'main' */
  defaultBase: string
  attachedPR: { number: number; url: string } | null
  assessmentFailed: boolean
}

export interface MemberPRPlan {
  assessment: MemberAssessment
  baseBranch: string
  include: boolean
}

export interface CreateConnectionPRsOptions {
  plans: MemberPRPlan[]
  /** Members hidden from the modal — archive prompts fire for the clean ones */
  ineligible: MemberAssessment[]
  title: string
  body: string
  provider: PRContentProvider | null
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function isPRWorthy(assessment: MemberAssessment): boolean {
  return !assessment.assessmentFailed && (assessment.hasUncommitted || assessment.commitsAhead > 0)
}

export function isArchivePromptable(assessment: MemberAssessment): boolean {
  return (
    !assessment.assessmentFailed &&
    !assessment.hasUncommitted &&
    assessment.commitsAhead === 0 &&
    assessment.trackingAhead === 0 &&
    !assessment.isDefaultWorktree
  )
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

async function assessMember(member: ConnectionPRMember): Promise<MemberAssessment> {
  const gitStore = useGitStore.getState()
  const worktrees = useWorktreeStore.getState().worktreesByProject.get(member.project_id) ?? []
  const projectPath =
    useProjectStore.getState().projects.find((p) => p.id === member.project_id)?.path ?? null
  const isDefaultWorktree = worktrees.find((w) => w.id === member.worktree_id)?.is_default ?? false
  const persistedBase = gitStore.prTargetBranch.get(member.worktree_id)
  const defaultBase =
    persistedBase?.replace(/^origin\//, '') ??
    worktrees.find((w) => w.is_default)?.branch_name ??
    'main'

  const base: MemberAssessment = {
    worktreeId: member.worktree_id,
    worktreePath: member.worktree_path,
    projectId: member.project_id,
    projectName: member.project_name,
    projectPath,
    branchName: member.worktree_branch,
    isDefaultWorktree,
    isGitHub: false,
    hasUncommitted: false,
    commitsAhead: 0,
    trackingAhead: 0,
    defaultBase,
    attachedPR: gitStore.attachedPR.get(member.worktree_id) ?? null,
    assessmentFailed: false
  }

  try {
    if (!gitStore.remoteInfo.get(member.worktree_id)) {
      await gitStore.checkRemoteInfo(member.worktree_id, member.worktree_path)
    }
    const isGitHub = useGitStore.getState().remoteInfo.get(member.worktree_id)?.isGitHub ?? false

    const [hasUncommitted, rangeDiff] = await Promise.all([
      gitApi.hasUncommittedChanges(member.worktree_path),
      gitApi.getRangeDiff(member.worktree_path, defaultBase),
      gitStore.loadFileStatuses(member.worktree_path, { force: true }),
      gitStore.loadBranchInfo(member.worktree_path, { force: true })
    ])
    const trackingAhead =
      useGitStore.getState().branchInfoByWorktree.get(member.worktree_path)?.ahead ?? 0

    return {
      ...base,
      isGitHub,
      hasUncommitted,
      commitsAhead: rangeDiff.commitCount,
      trackingAhead
    }
  } catch {
    // Failed members are neither shown in the modal nor archive-prompted
    return { ...base, assessmentFailed: true }
  }
}

export async function assessConnectionMembers(
  members: ConnectionPRMember[]
): Promise<MemberAssessment[]> {
  return Promise.all(members.map(assessMember))
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Commit the shared message in each member, sequentially so the global
 * isCommitting flag and per-path status refreshes don't race.
 */
export async function commitConnectionMembers(
  members: MemberAssessment[],
  message: string
): Promise<Map<string, { success: boolean; error?: string }>> {
  const results = new Map<string, { success: boolean; error?: string }>()
  for (const member of members) {
    try {
      const result = await useGitStore.getState().commit(member.worktreePath, message)
      results.set(member.worktreeId, { success: result.success, error: result.error })
    } catch (err) {
      results.set(member.worktreeId, {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// PR creation
// ---------------------------------------------------------------------------

export function emitArchivePrompts(assessments: MemberAssessment[]): void {
  const { show } = usePRNotificationStore.getState()
  for (const assessment of assessments.filter(isArchivePromptable)) {
    show({
      status: 'info',
      message: `Nothing to PR in ${assessment.projectName}`,
      description: 'No changes and no commits ahead — you can archive this worktree',
      worktreeId: assessment.worktreeId,
      showArchiveButton: true
    })
  }
}

async function pushAttachedPRUpdates(assessment: MemberAssessment, prefix: string): Promise<void> {
  const { show, update } = usePRNotificationStore.getState()
  const pr = assessment.attachedPR
  if (!pr) return

  const notifId = show({
    status: 'loading',
    message: `${prefix}Pushing updates to PR #${pr.number}...`,
    worktreeId: assessment.worktreeId
  })
  try {
    let willPush = false
    try {
      willPush = await gitApi.needsPush(assessment.worktreePath)
    } catch {
      // Assume no push needed
    }
    if (willPush) {
      const pushResult = await gitApi.push(assessment.worktreePath)
      if (!pushResult.success) {
        throw new Error(pushResult.error ?? 'Push failed')
      }
    }
    update(notifId, {
      status: 'info',
      message: willPush
        ? `${prefix}Pushed updates to PR #${pr.number}`
        : `${prefix}PR #${pr.number} is up to date`,
      prUrl: pr.url,
      prNumber: pr.number,
      worktreeId: assessment.worktreeId
    })
  } catch (err) {
    update(notifId, {
      status: 'error',
      message: `${prefix}Failed to push updates to PR #${pr.number}`,
      description: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Create a PR for every included member, one notification card each.
 * Members fail independently; clean ineligible members get archive prompts
 * once the whole batch settles.
 */
export async function createConnectionPRs(options: CreateConnectionPRsOptions): Promise<void> {
  const { plans, ineligible, title, body, provider } = options
  const { show } = usePRNotificationStore.getState()

  await Promise.allSettled(
    plans.map(async (plan) => {
      const assessment = plan.assessment
      const prefix = `${assessment.projectName}: `

      if (!assessment.isGitHub) {
        // Committed in the commit phase, but there is no remote to PR against
        if (assessment.hasUncommitted || assessment.commitsAhead > 0) {
          show({
            status: 'info',
            message: `${prefix}committed — no GitHub remote, PR skipped`,
            worktreeId: assessment.worktreeId
          })
        }
        return
      }

      if (!plan.include) return

      if (assessment.attachedPR) {
        await pushAttachedPRUpdates(assessment, prefix)
        return
      }

      if (assessment.commitsAhead <= 0) {
        show({
          status: 'warning',
          message: `${prefix}skipped — no commits ahead of ${plan.baseBranch}`,
          worktreeId: assessment.worktreeId
        })
        return
      }

      const notifId = show({
        status: 'loading',
        message: `${prefix}Creating pull request...`,
        worktreeId: assessment.worktreeId
      })
      await runCreatePRPipeline({
        worktreeId: assessment.worktreeId,
        worktreePath: assessment.worktreePath,
        projectPath: assessment.projectPath,
        baseBranch: plan.baseBranch,
        title,
        body,
        fallbackTitle: assessment.branchName,
        provider,
        notifId,
        labelPrefix: prefix
      })
    })
  )

  emitArchivePrompts(ineligible)
}
