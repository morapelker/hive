// Scrolls the left sidebar's list to a project, for the ways of opening a project that do not
// start from its row (the "Go to project" switcher).
//
// The sidebar is found in the DOM, like the vim scroll keys find it: with the sidebar collapsed
// there is nothing to scroll and nothing happens.

export interface SidebarRevealTarget {
  kind: 'git' | 'connection' | 'data'
  id: string
}

const SCROLL_CONTAINER = '[data-testid="sidebar-scroll-container"]'

function findByAttribute(root: Element, attribute: string, value: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === value) return element
  }
  return null
}

/**
 * What to bring into view, as a top and a bottom element (often the same one).
 *
 * The project's group in "All projects" comes first: the row with its worktrees under it. When
 * it leads the list, the section's heading above it is shown too. A project the active Space
 * or the sidebar filter leaves out of that list is shown where it still has a row: the Recent
 * section, taken whole so its pinned heading does not cover the row.
 */
function findRevealRange(
  container: Element,
  target: SidebarRevealTarget
): { top: Element; bottom: Element } | null {
  const group = findByAttribute(
    container,
    target.kind === 'data' ? 'data-data-project-group' : 'data-project-group',
    target.id
  )
  if (group) {
    const heading = container.querySelector('[data-testid="all-projects-header"]')
    const leadsList = group.parentElement?.firstElementChild === group
    return { top: leadsList && heading ? heading : group, bottom: group }
  }
  const recentRow = findByAttribute(container, 'data-recent-project', target.id)
  const recentSection = recentRow?.closest('[data-testid="recent-list"]')
  return recentSection ? { top: recentSection, bottom: recentSection } : null
}

/**
 * Scrolls the sidebar so the project can be seen, and only as far as that takes: nothing moves
 * when it is in view already; from below it comes up until its last row shows; from above, or
 * when it is taller than the sidebar, its top goes to the top.
 *
 * Returns whether the project has a row in the sidebar to show.
 */
export function scrollSidebarToProject(target: SidebarRevealTarget): boolean {
  const container = document.querySelector<HTMLElement>(SCROLL_CONTAINER)
  if (!container) return false
  const range = findRevealRange(container, target)
  if (!range) return false

  const view = container.getBoundingClientRect()
  const top = range.top.getBoundingClientRect().top
  const bottom = range.bottom.getBoundingClientRect().bottom
  if (top >= view.top && bottom <= view.bottom) return true

  const delta = top < view.top || bottom - top > view.height ? top - view.top : bottom - view.bottom
  container.scrollBy?.({ top: delta, behavior: 'smooth' })
  return true
}

/**
 * The same, once the sidebar has rendered what was just changed in the stores (the project's
 * new place in the list, its Recent row).
 */
export function revealProjectInSidebar(target: SidebarRevealTarget): void {
  if (typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => {
    scrollSidebarToProject(target)
  })
}
