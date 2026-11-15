import { setProjectPinned } from '@/lib/project-pin'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import type { SwitcherProject } from '@/lib/project-switcher'

/**
 * Pins or unpins a project from the "Go to project" switcher (Cmd+Enter on the highlighted
 * row, or a row's pin button). Never opens, selects or navigates.
 *
 * - A git or connection project goes through the one "Pin to board" action
 *   (lib/project-pin): same pins, same toasts, same all-or-nothing on failure as the
 *   project's right-click menu.
 * - A database toggles its own existing Pin (the one in its menu), which rolls back and
 *   shows its own error toast when the write fails.
 *
 * Resolves to whether the change was made.
 */
export function setSwitcherProjectPinned(
  project: Pick<SwitcherProject, 'kind' | 'id' | 'name'>,
  pinned: boolean
): Promise<boolean> {
  if (project.kind === 'data') {
    return useDataProjectStore.getState().setPinned(project.id, pinned)
  }
  return setProjectPinned({ id: project.id, name: project.name, kind: project.kind }, pinned)
}

/** What the pin control of a row does, in the words of the project's own menu. */
export function switcherPinLabel(project: Pick<SwitcherProject, 'kind'>, pinned: boolean): string {
  if (project.kind === 'data') return pinned ? 'Unpin' : 'Pin'
  return pinned ? 'Unpin from board' : 'Pin to board'
}
