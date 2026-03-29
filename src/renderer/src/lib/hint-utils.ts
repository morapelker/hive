import { useHintStore, type HintActionMode } from '@/stores/useHintStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { gitToast } from '@/lib/toast'

export const FIRST_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const SECOND_CHARS = 'abcefghijklmnoqrstuvwxyz23456789'

export interface HintTarget {
  kind: 'worktree' | 'plus' | 'project' | 'pinned-worktree' | 'pinned-connection' | 'connection'
  worktreeId?: string
  connectionId?: string
  projectId?: string
}

/**
 * Build the first-char sequence, optionally starting with a preferred character
 * and excluding specified characters.
 */
function buildFirstChars(preferredFirstChar?: string, excludeFirstChars?: string): string {
  let chars = FIRST_CHARS
  if (excludeFirstChars) {
    chars = chars
      .split('')
      .filter((c) => !excludeFirstChars.includes(c))
      .join('')
  }
  if (!preferredFirstChar || !chars.includes(preferredFirstChar)) return chars
  return preferredFirstChar + chars.replace(preferredFirstChar, '')
}

export function assignHints(
  targets: HintTarget[],
  preferredFirstChar?: string,
  excludeFirstChars?: string
): {
  hintMap: Map<string, string>
  hintTargetMap: Map<string, HintTarget>
} {
  const hintMap = new Map<string, string>()
  const hintTargetMap = new Map<string, HintTarget>()
  const firstChars = buildFirstChars(preferredFirstChar, excludeFirstChars)

  targets.forEach((target, index) => {
    const firstIndex = Math.floor(index / SECOND_CHARS.length)
    const secondIndex = index % SECOND_CHARS.length

    if (firstIndex >= firstChars.length) return

    const code = firstChars[firstIndex] + SECOND_CHARS[secondIndex]
    let key: string
    if (target.kind === 'plus') {
      key = `plus:${target.projectId}`
    } else if (target.kind === 'project') {
      key = `project:${target.projectId}`
    } else if (target.kind === 'pinned-worktree') {
      key = `pinned-wt:${target.worktreeId}`
    } else if (target.kind === 'pinned-connection') {
      key = `pinned-conn:${target.connectionId}`
    } else if (target.kind === 'connection') {
      key = `conn:${target.connectionId}`
    } else {
      key = target.worktreeId!
    }

    hintMap.set(key, code)
    hintTargetMap.set(key, target)
  })

  return { hintMap, hintTargetMap }
}

export function assignSessionHints(sessionIds: string[]): {
  sessionHintMap: Map<string, string>
  sessionHintTargetMap: Map<string, string>
} {
  const sessionHintMap = new Map<string, string>()
  const sessionHintTargetMap = new Map<string, string>()

  sessionIds.forEach((id, index) => {
    if (index >= SECOND_CHARS.length) return
    const code = 'S' + SECOND_CHARS[index]
    sessionHintMap.set(id, code)
    sessionHintTargetMap.set(code, id)
  })

  return { sessionHintMap, sessionHintTargetMap }
}

/**
 * Build hint targets for vim normal mode (no filter active).
 * Two-pass approach for stable hint codes:
 *   Pass 1: all project + plus targets (in display order)
 *   Pass 2: all worktree targets (regardless of expanded state)
 * This ensures expanding/collapsing a project never reshuffles hint codes.
 */
export function buildNormalModeTargets(
  projects: Array<{ id: string; name: string }>,
  worktreesByProject: Map<string, Array<{ id: string; project_id: string }>>
): HintTarget[] {
  const targets: HintTarget[] = []
  // Pass 1: all project + plus targets
  for (const project of projects) {
    targets.push({ kind: 'project', projectId: project.id })
    targets.push({ kind: 'plus', projectId: project.id })
  }
  // Pass 2: all worktree targets (regardless of expanded/collapsed state)
  for (const project of projects) {
    const wts = worktreesByProject.get(project.id) ?? []
    for (const wt of wts) {
      targets.push({ kind: 'worktree', worktreeId: wt.id, projectId: project.id })
    }
  }
  return targets
}

/**
 * Build hint targets for pinned items and connections.
 * Order: pinned worktrees → pinned connections → connections.
 */
export function buildPinnedAndConnectionTargets(
  pinnedWorktreeIds: Set<string>,
  pinnedConnectionIds: Set<string>,
  connectionIds: string[],
  worktreeProjectMap: Map<string, string>
): HintTarget[] {
  const targets: HintTarget[] = []

  for (const worktreeId of pinnedWorktreeIds) {
    const projectId = worktreeProjectMap.get(worktreeId)
    targets.push({ kind: 'pinned-worktree', worktreeId, projectId })
  }

  for (const connectionId of pinnedConnectionIds) {
    targets.push({ kind: 'pinned-connection', connectionId })
  }

  for (const connectionId of connectionIds) {
    if (!pinnedConnectionIds.has(connectionId)) {
      targets.push({ kind: 'connection', connectionId })
    }
  }

  return targets
}

/**
 * Determine whether a hint badge should be visible.
 * Shows when: hint exists AND (filter input is focused OR vim mode is 'normal').
 */
export function shouldShowHintBadge(
  hint: string | undefined,
  inputFocused: boolean,
  vimMode: string
): boolean {
  return !!hint && (inputFocused || vimMode === 'normal')
}

export function dispatchHintAction(key: string, actionMode: HintActionMode = 'select'): void {
  // Pin/archive — ignore project/plus/session targets
  if (actionMode === 'pin' || actionMode === 'archive') {
    if (key.startsWith('plus:') || key.startsWith('project:')) return

    if (actionMode === 'pin') {
      if (key.startsWith('pinned-wt:')) {
        const id = key.slice('pinned-wt:'.length)
        usePinnedStore.getState().unpinWorktree(id)
        return
      }

      if (key.startsWith('pinned-conn:') || key.startsWith('conn:')) {
        const id = key.startsWith('pinned-conn:')
          ? key.slice('pinned-conn:'.length)
          : key.slice('conn:'.length)
        const { pinnedConnectionIds, pinConnection, unpinConnection } = usePinnedStore.getState()
        if (pinnedConnectionIds.has(id)) {
          unpinConnection(id)
        } else {
          pinConnection(id)
        }
        return
      }

      // Regular worktree
      const target = useHintStore.getState().hintTargetMap.get(key)
      if (!target || target.kind !== 'worktree' || !target.worktreeId) return
      const { pinnedWorktreeIds, pinWorktree, unpinWorktree } = usePinnedStore.getState()
      if (pinnedWorktreeIds.has(target.worktreeId)) {
        unpinWorktree(target.worktreeId)
      } else {
        pinWorktree(target.worktreeId)
      }
      return
    }

    // actionMode === 'archive'
    // Connections: no-op (too destructive for keyboard shortcut)
    if (key.startsWith('pinned-conn:') || key.startsWith('conn:')) return

    // Resolve worktreeId for both pinned-wt and regular worktree keys
    let worktreeId: string | undefined
    let projectId: string | undefined
    if (key.startsWith('pinned-wt:')) {
      worktreeId = key.slice('pinned-wt:'.length)
      const target = useHintStore.getState().hintTargetMap.get(key)
      projectId = target?.projectId
    } else {
      const target = useHintStore.getState().hintTargetMap.get(key)
      if (!target || target.kind !== 'worktree' || !target.worktreeId) return
      worktreeId = target.worktreeId
      projectId = target.projectId
    }

    if (!worktreeId) return

    const worktrees = Array.from(useWorktreeStore.getState().worktreesByProject.values()).flat()
    const worktree = worktrees.find((w) => w.id === worktreeId)
    if (!worktree || worktree.is_default) return

    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (!project) return

    useWorktreeStore
      .getState()
      .archiveWorktree(worktree.id, worktree.path, worktree.branch_name, project.path)
      .then((result) => {
        if (result.success) {
          gitToast.worktreeArchived(worktree.name)
        } else {
          gitToast.operationFailed('archive', result.error)
        }
      })
      .catch(() => {
        gitToast.operationFailed('archive worktree')
      })
    return
  }

  // Default: select mode
  if (key.startsWith('pinned-wt:')) {
    const worktreeId = key.slice('pinned-wt:'.length)
    const target = useHintStore.getState().hintTargetMap.get(key)
    useWorktreeStore.getState().selectWorktree(worktreeId)
    if (target?.projectId) {
      const { expandedProjectIds, toggleProjectExpanded, selectProject } =
        useProjectStore.getState()
      selectProject(target.projectId)
      if (!expandedProjectIds.has(target.projectId)) {
        toggleProjectExpanded(target.projectId)
      }
    }
  } else if (key.startsWith('pinned-conn:') || key.startsWith('conn:')) {
    const connectionId = key.startsWith('pinned-conn:')
      ? key.slice('pinned-conn:'.length)
      : key.slice('conn:'.length)
    useConnectionStore.getState().selectConnection(connectionId)
  } else if (key.startsWith('plus:')) {
    const projectId = key.slice('plus:'.length)
    const { expandedProjectIds, toggleProjectExpanded } = useProjectStore.getState()
    if (!expandedProjectIds.has(projectId)) {
      toggleProjectExpanded(projectId)
    }
    window.dispatchEvent(new CustomEvent('hive:hint-plus', { detail: { projectId } }))
  } else if (key.startsWith('project:')) {
    const projectId = key.slice('project:'.length)
    useProjectStore.getState().toggleProjectExpanded(projectId)
  } else {
    const target = useHintStore.getState().hintTargetMap.get(key)
    if (!target) return
    // Auto-expand the project if collapsed so the worktree becomes visible
    const { expandedProjectIds, toggleProjectExpanded } = useProjectStore.getState()
    if (!expandedProjectIds.has(target.projectId)) {
      toggleProjectExpanded(target.projectId)
    }
    useWorktreeStore.getState().selectWorktree(key)
    if (target.projectId) {
      useProjectStore.getState().selectProject(target.projectId)
    }
  }
}
