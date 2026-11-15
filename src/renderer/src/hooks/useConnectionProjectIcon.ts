import { useCallback, useMemo } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import { LANGUAGE_MAP } from '@/components/projects/LanguageIcon'
import { parseMemberProjectIds } from '@/lib/connection-project'
import {
  CONNECTION_ICON_BOX_TILES,
  iconMembersSignature,
  parseIconMembersSignature,
  pickConnectionIconTiles,
  resolveIconMembers,
  type IconMember,
  type IconTile
} from '@/lib/connection-project-icon'

type ProjectRows = ReturnType<typeof useProjectStore.getState>['projects']

const NO_MEMBERS = '[]'

// One signature per connection project per `projects` array: every ticket card of a
// connection project shares the work, and store updates that leave `projects` alone cost a
// lookup.
const signatureCache = new WeakMap<ProjectRows, Map<string, string>>()

function memberSignature(projects: ProjectRows, projectId: string): string {
  let byProject = signatureCache.get(projects)
  if (!byProject) {
    byProject = new Map()
    signatureCache.set(projects, byProject)
  }
  const cached = byProject.get(projectId)
  if (cached !== undefined) return cached

  const row = projects.find((project) => project.id === projectId)
  const signature =
    row?.kind === 'connection'
      ? iconMembersSignature(
          resolveIconMembers(parseMemberProjectIds(row.member_project_ids), projects, row.id)
        )
      : NO_MEMBERS
  byProject.set(projectId, signature)
  return signature
}

/** A language LanguageIcon can draw (bundled logo or colored badge). */
export const isKnownIconLanguage = (language: string): boolean =>
  Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, language)

/**
 * The member projects of a connection project that still exist, in stored order, reduced to
 * their icon fields. Empty for anything that is not a connection project. Reactive: follows
 * member edits and a member's icon, language or name changing. The selector returns a
 * primitive string, so equal rows never re-render the subscriber.
 */
export function useConnectionIconMembers(projectId: string | null | undefined): IconMember[] {
  const signature = useProjectStore(
    useCallback(
      (state) => (projectId ? memberSignature(state.projects, projectId) : NO_MEMBERS),
      [projectId]
    )
  )
  return useMemo(() => parseIconMembersSignature(signature), [signature])
}

/** The tiles of a connection project's default icon (empty → show a fallback). */
export function useConnectionProjectIconTiles(
  projectId: string | null | undefined,
  slots: number = CONNECTION_ICON_BOX_TILES
): IconTile[] {
  const members = useConnectionIconMembers(projectId)
  return useMemo(
    () => pickConnectionIconTiles(members, isKnownIconLanguage, slots),
    [members, slots]
  )
}
