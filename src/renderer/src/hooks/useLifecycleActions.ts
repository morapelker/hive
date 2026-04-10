import { useState, useEffect, useCallback } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { toast } from '@/lib/toast'

interface AttachedPR {
  number: number
  url: string
}

interface PRListItem {
  number: number
  title: string
  author: string
  headRefName: string
}

interface LifecycleActions {
  // State
  attachedPR: AttachedPR | null
  hasAttachedPR: boolean
  prLiveState: { state?: string; title?: string } | null
  isGitHub: boolean
  isMergingPR: boolean
  isArchiving: boolean
  branchInfo: { name?: string; tracking?: string | null } | null
  remoteBranches: { name: string }[]
  prTargetBranch: string | undefined
  reviewTargetBranch: string | undefined
  isCleanTree: boolean
  isDefault: boolean

  // Actions
  createCodeReview: (targetBranch?: string) => Promise<string | null>
  mergePR: () => Promise<boolean>
  archiveWorktree: () => Promise<boolean>
  attachPR: (prNumber: number) => void
  detachPR: () => void
  openPRInBrowser: () => void
  copyPRUrl: () => void
  loadPRList: () => Promise<PRListItem[]>
  loadPRState: () => Promise<void>
  setPrTargetBranch: (branch: string) => void
  setReviewTargetBranch: (branch: string) => void
}

// Resolve projectId from worktreeId by searching worktreesByProject
function resolveProjectId(worktreeId: string): string | null {
  const worktreeStore = useWorktreeStore.getState()
  for (const [projId, wts] of worktreeStore.worktreesByProject) {
    if (wts.some((w) => w.id === worktreeId)) {
      return projId
    }
  }
  return null
}

// Resolve worktree object from worktreeId
function resolveWorktree(worktreeId: string) {
  const worktreeStore = useWorktreeStore.getState()
  for (const worktrees of worktreeStore.worktreesByProject.values()) {
    const match = worktrees.find((w) => w.id === worktreeId)
    if (match) return match
  }
  return null
}

// Resolve project path for a worktreeId
function resolveProjectPath(worktreeId: string): string | null {
  const projectId = resolveProjectId(worktreeId)
  if (!projectId) return null
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  return project?.path ?? null
}

const noopString = async () => null
const noopBool = async () => false
const noopVoid = () => {}
const noopPRList = async (): Promise<PRListItem[]> => []
const noopLoadState = async () => {}

export function useLifecycleActions(worktreeId: string | null): LifecycleActions {
  // --- Store subscriptions ---
  const worktree = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) return match
    }
    return null
  })

  const remoteInfo = useGitStore((s) =>
    worktreeId ? s.remoteInfo.get(worktreeId) : undefined
  )

  const storeAttachedPR = useGitStore((s) =>
    worktreeId ? s.attachedPR.get(worktreeId) : undefined
  )

  const storePrTargetBranch = useGitStore((s) =>
    worktreeId ? s.prTargetBranch.get(worktreeId) : undefined
  )

  const storeReviewTargetBranch = useGitStore((s) =>
    worktreeId ? s.reviewTargetBranch.get(worktreeId) : undefined
  )

  const branchInfo = useGitStore((s) =>
    worktree?.path ? s.branchInfoByWorktree.get(worktree.path) ?? null : null
  )

  const fileStatuses = useGitStore((s) =>
    worktree?.path ? s.fileStatusesByWorktree.get(worktree.path) : undefined
  )

  // --- Derived state ---
  const isGitHub = remoteInfo?.isGitHub ?? false
  const attachedPR = storeAttachedPR ?? null
  const hasAttachedPR = !!storeAttachedPR
  const isCleanTree = !fileStatuses || fileStatuses.length === 0
  const isDefault = worktree?.is_default ?? false

  // --- Local state ---
  const [isMergingPR, setIsMergingPR] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [prLiveState, setPrLiveState] = useState<{ state?: string; title?: string } | null>(null)
  const [remoteBranches, setRemoteBranches] = useState<{ name: string }[]>([])

  // --- Ensure remote info is loaded for this worktree (needed for isGitHub check) ---
  useEffect(() => {
    if (!worktreeId || !worktree?.path || remoteInfo) return
    useGitStore.getState().checkRemoteInfo(worktreeId, worktree.path)
  }, [worktreeId, worktree?.path, remoteInfo])

  // --- Load remote branches when worktree path changes ---
  useEffect(() => {
    if (!worktree?.path) {
      setRemoteBranches([])
      return
    }
    window.gitOps.listBranchesWithStatus(worktree.path).then((result) => {
      if (result.success) {
        const filtered = result.branches.filter((b: { isRemote: boolean }) => b.isRemote)

        // Pin the default branch (e.g. origin/main) to the top
        if (worktreeId) {
          const projectId = resolveProjectId(worktreeId)
          if (projectId) {
            const defaultWt = useWorktreeStore.getState().getDefaultWorktree(projectId)
            if (defaultWt?.branch_name) {
              const defaultRemoteName = `origin/${defaultWt.branch_name}`
              filtered.sort((a, b) => {
                if (a.name === defaultRemoteName) return -1
                if (b.name === defaultRemoteName) return 1
                return 0
              })
            }
          }
        }

        setRemoteBranches(filtered)
      }
    })
  }, [worktree?.path, worktreeId])

  // --- Clear live state when attached PR changes ---
  useEffect(() => {
    setPrLiveState(null)
  }, [storeAttachedPR?.number])

  // --- Actions ---

  const createCodeReview = useCallback(async (targetBranch?: string): Promise<string | null> => {
    if (!worktreeId || !worktree?.path) return null

    const projectId = resolveProjectId(worktreeId)
    if (!projectId) {
      toast.error('Could not find project for worktree')
      return null
    }

    const currentBranchInfo = useGitStore.getState().branchInfoByWorktree.get(worktree.path)
    const currentReviewTarget = useGitStore.getState().reviewTargetBranch.get(worktreeId)
    const target = targetBranch || currentReviewTarget || currentBranchInfo?.tracking || 'origin/main'
    const branchName = currentBranchInfo?.name || 'unknown'

    let reviewTemplate = ''
    try {
      const tmpl = await window.fileOps.readPrompt('review.md')
      if (tmpl.success && tmpl.content) {
        reviewTemplate = tmpl.content
      }
    } catch {
      // readPrompt failed, use fallback
    }

    const prompt = reviewTemplate
      ? [
          reviewTemplate,
          '',
          '---',
          '',
          `Compare the current branch (${branchName}) against ${target}.`,
          `Use \`git diff ${target}...HEAD\` to see all changes.`
        ].join('\n')
      : [
          `Please review the changes on branch "${branchName}" compared to ${target}.`,
          `Use \`git diff ${target}...HEAD\` to get the full diff.`,
          'Focus on: bugs, logic errors, and code quality.'
        ].join('\n')

    const sessionStore = useSessionStore.getState()
    const result = await sessionStore.createSession(worktreeId, projectId)
    if (!result.success || !result.session) {
      toast.error('Failed to create review session')
      return null
    }

    await sessionStore.updateSessionName(
      result.session.id,
      `Code Review — ${branchName} vs ${target}`
    )
    sessionStore.setPendingMessage(result.session.id, prompt)

    // Register the review session so ticket cards can show "Reviewing" indicator
    useWorktreeStatusStore.getState().setReviewSession(worktreeId, result.session.id)

    return result.session.id
  }, [worktreeId, worktree?.path])

  const mergePR = useCallback(async (): Promise<boolean> => {
    if (!worktreeId || !worktree?.path) return false
    const pr = useGitStore.getState().attachedPR.get(worktreeId)
    if (!pr?.number) return false

    setIsMergingPR(true)
    try {
      const result = await window.gitOps.prMerge(worktree.path, pr.number)
      if (result.success) {
        toast.success('PR merged successfully')
        setPrLiveState((prev) => ({ state: 'MERGED', title: prev?.title }))
        return true
      } else {
        toast.error(`Merge failed: ${result.error}`)
        return false
      }
    } catch {
      toast.error('Failed to merge PR')
      return false
    } finally {
      setIsMergingPR(false)
    }
  }, [worktreeId, worktree?.path])

  const archiveWorktreeAction = useCallback(async (): Promise<boolean> => {
    if (!worktreeId) return false
    const wt = resolveWorktree(worktreeId)
    if (!wt) return false
    const projectPath = resolveProjectPath(worktreeId)
    if (!projectPath) return false

    setIsArchiving(true)
    try {
      const result = await useWorktreeStore
        .getState()
        .archiveWorktree(worktreeId, wt.path, wt.branch_name, projectPath)

      if (!result.success && result.error) {
        toast.error(result.error)
      }
      return result.success
    } finally {
      setIsArchiving(false)
    }
  }, [worktreeId])

  const attachPRAction = useCallback(
    (prNumber: number) => {
      if (!worktreeId || !remoteInfo?.url) return
      const cleanUrl = remoteInfo.url.replace(/\.git$/, '')
      const prUrl = `${cleanUrl}/pull/${prNumber}`
      useGitStore.getState().attachPR(worktreeId, prNumber, prUrl)
    },
    [worktreeId, remoteInfo?.url]
  )

  const detachPRAction = useCallback(() => {
    if (!worktreeId) return
    useGitStore.getState().detachPR(worktreeId)
    setPrLiveState(null)
  }, [worktreeId])

  const openPRInBrowser = useCallback(() => {
    if (!storeAttachedPR?.url) return
    window.systemOps.openInChrome(storeAttachedPR.url)
  }, [storeAttachedPR?.url])

  const copyPRUrl = useCallback(() => {
    if (!storeAttachedPR?.url) return
    navigator.clipboard.writeText(storeAttachedPR.url)
    toast.success('PR URL copied')
  }, [storeAttachedPR?.url])

  const loadPRList = useCallback(async (): Promise<PRListItem[]> => {
    if (!worktreeId) return []
    const projectPath = resolveProjectPath(worktreeId)
    if (!projectPath) return []

    const currentBranchInfo = useGitStore.getState().branchInfoByWorktree.get(
      resolveWorktree(worktreeId)?.path ?? ''
    )
    const currentBranch = currentBranchInfo?.name ?? ''

    try {
      const res = await window.gitOps.listPRs(projectPath)
      if (res.success) {
        const sorted = [...res.prs].sort((a, b) => {
          const aMatch = a.headRefName === currentBranch ? 1 : 0
          const bMatch = b.headRefName === currentBranch ? 1 : 0
          if (aMatch !== bMatch) return bMatch - aMatch
          return b.number - a.number
        })
        return sorted
      } else {
        toast.error(res.error || 'Failed to load PRs')
        return []
      }
    } catch {
      toast.error('Failed to load PRs')
      return []
    }
  }, [worktreeId])

  const loadPRState = useCallback(async (): Promise<void> => {
    if (!worktreeId) return
    const pr = useGitStore.getState().attachedPR.get(worktreeId)
    if (!pr) return
    const projectPath = resolveProjectPath(worktreeId)
    if (!projectPath) return

    try {
      const res = await window.gitOps.getPRState(projectPath, pr.number)
      if (res.success) {
        setPrLiveState({ state: res.state, title: res.title })
      }
    } catch {
      // non-critical
    }
  }, [worktreeId])

  const setPrTargetBranchAction = useCallback(
    (branch: string) => {
      if (!worktreeId) return
      useGitStore.getState().setPrTargetBranch(worktreeId, branch)
    },
    [worktreeId]
  )

  const setReviewTargetBranchAction = useCallback(
    (branch: string) => {
      if (!worktreeId) return
      useGitStore.getState().setReviewTargetBranch(worktreeId, branch)
    },
    [worktreeId]
  )

  // When worktreeId is null, return safe defaults with no-op actions
  if (!worktreeId) {
    return {
      attachedPR: null,
      hasAttachedPR: false,
      prLiveState: null,
      isGitHub: false,
      isMergingPR: false,
      isArchiving: false,
      branchInfo: null,
      remoteBranches: [],
      prTargetBranch: undefined,
      reviewTargetBranch: undefined,
      isCleanTree: true,
      isDefault: false,
      createCodeReview: noopString,
      mergePR: noopBool,
      archiveWorktree: noopBool,
      attachPR: noopVoid,
      detachPR: noopVoid,
      openPRInBrowser: noopVoid,
      copyPRUrl: noopVoid,
      loadPRList: noopPRList,
      loadPRState: noopLoadState,
      setPrTargetBranch: noopVoid,
      setReviewTargetBranch: noopVoid
    }
  }

  return {
    // State
    attachedPR,
    hasAttachedPR,
    prLiveState,
    isGitHub,
    isMergingPR,
    isArchiving,
    branchInfo,
    remoteBranches,
    prTargetBranch: storePrTargetBranch,
    reviewTargetBranch: storeReviewTargetBranch,
    isCleanTree,
    isDefault,

    // Actions
    createCodeReview,
    mergePR,
    archiveWorktree: archiveWorktreeAction,
    attachPR: attachPRAction,
    detachPR: detachPRAction,
    openPRInBrowser,
    copyPRUrl,
    loadPRList,
    loadPRState,
    setPrTargetBranch: setPrTargetBranchAction,
    setReviewTargetBranch: setReviewTargetBranchAction
  }
}
