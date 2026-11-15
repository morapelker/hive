import { useEffect, useMemo } from 'react'
import { History } from 'lucide-react'
import { useFilterStore, usePinnedStore, useProjectStore } from '@/stores'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { pickRecentProjects } from '@/lib/recent-projects'
import { ProjectItem } from '@/components/projects/ProjectItem'
import { RecentDataProjectItem } from '@/components/data-projects/DataProjectItem'
import { SECTION_HEADER_ICON, SidebarSectionHeader } from '@/components/sidebar'

/** Recent used to be a toggle; this is where its on/off preference was saved. */
const LEGACY_TOGGLE_STORAGE_KEY = 'hive-recent-visible'

/**
 * The sidebar's Recent section: the five projects opened most recently that are not pinned,
 * newest first. Always on. Every kind of project counts, from every Space; the section hides
 * when it has no rows and while a sidebar filter is active.
 *
 * A row is one line (RecentProjectRow). Git and connection projects render through ProjectItem
 * so that a right-click shows the very menu of the project's row in the list; a database
 * renders its own row with its own menu.
 */
export function RecentList(): React.JSX.Element | null {
  const projects = useProjectStore((s) => s.projects)
  const dataProjects = useDataProjectStore((s) => s.projects)
  const pinnedProjectIds = usePinnedStore((s) => s.pinnedProjectIds)
  // Until the pins are known a pinned project would show here for a moment.
  const pinsLoaded = usePinnedStore((s) => s.loaded)
  const filtering = useFilterStore(
    (s) => s.filterQuery.trim().length > 0 || s.activeLanguages.length > 0
  )

  const entries = useMemo(
    () => pickRecentProjects(projects, dataProjects, pinnedProjectIds),
    [projects, dataProjects, pinnedProjectIds]
  )

  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_TOGGLE_STORAGE_KEY)
    } catch {
      // ignore storage errors
    }
  }, [])

  if (!pinsLoaded || filtering || entries.length === 0) return null

  return (
    // Orca virtual-row rhythm, as the Pinned section: the trailing pb-2.5 gives the next
    // section header its 6px gap + pt-1 spacer. The rows are one-line and sit closer together
    // than cards.
    <div className="flex flex-col gap-1.5 pb-2.5" data-testid="recent-list">
      <SidebarSectionHeader
        sticky
        icon={<History className={SECTION_HEADER_ICON} />}
        label="Recent"
        count={entries.length}
      />
      <div className="flex flex-col gap-px" data-testid="recent-list-rows">
        {entries.map((entry) =>
          entry.kind === 'data' ? (
            <RecentDataProjectItem key={`data-${entry.id}`} project={entry.item} />
          ) : (
            <ProjectItem key={entry.id} project={entry.item} variant="recent" />
          )
        )}
      </div>
    </div>
  )
}
