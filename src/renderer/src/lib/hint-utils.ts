import { useHintStore } from '@/stores/useHintStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'

export const FIRST_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const SECOND_CHARS = 'abcdefghijklmnopqrstuvwxyz23456789'

export interface HintTarget {
  kind: 'worktree' | 'plus' | 'project'
  worktreeId?: string
  projectId: string
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
 * Includes project, plus, and worktree targets.
 * Interleaves: project → plus → its worktrees (for expanded projects).
 */
export function buildNormalModeTargets(
  projects: Array<{ id: string; name: string }>,
  expandedProjectIds: Set<string>,
  worktreesByProject: Map<string, Array<{ id: string; project_id: string }>>
): HintTarget[] {
  const targets: HintTarget[] = []
  for (const project of projects) {
    targets.push({ kind: 'project', projectId: project.id })
    targets.push({ kind: 'plus', projectId: project.id })
    if (expandedProjectIds.has(project.id)) {
      const wts = worktreesByProject.get(project.id) ?? []
      for (const wt of wts) {
        targets.push({ kind: 'worktree', worktreeId: wt.id, projectId: project.id })
      }
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

export function dispatchHintAction(key: string): void {
  if (key.startsWith('plus:')) {
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
    useWorktreeStore.getState().selectWorktree(key)
    useProjectStore.getState().selectProject(target.projectId)
  }
}
