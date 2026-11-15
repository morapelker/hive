/**
 * Which boards have the "Pin to board" button (BoardPinButton), and for which project.
 *
 * Only the board of one project has it: a git project or a connection project (also when one of
 * the connection project's instances is selected, since that shows the project's own board). The
 * Pinned Board, the board of a connection that was not saved as a project, and a board whose
 * project is not in the list have none. Databases have no board at all.
 */
import { useShallow } from 'zustand/react/shallow'
import type { PinnableProject } from '@/lib/project-pin'
import { useProjectStore } from '@/stores/useProjectStore'

export interface BoardPinTarget {
  projectId?: string
  connectionId?: string
  isPinnedMode?: boolean
}

/**
 * The project a board's pin button is for, or null on a board that has no button. The result
 * keeps its identity while the project's id, name and kind stand still.
 */
export function useBoardPinProject({
  projectId,
  connectionId,
  isPinnedMode
}: BoardPinTarget): PinnableProject | null {
  const isProjectBoard = Boolean(projectId) && !connectionId && !isPinnedMode
  return useProjectStore(
    useShallow((state): PinnableProject | null => {
      if (!isProjectBoard) return null
      const project = state.projects.find((candidate) => candidate.id === projectId)
      if (!project) return null
      return { id: project.id, name: project.name, kind: project.kind ?? 'git' }
    })
  )
}
