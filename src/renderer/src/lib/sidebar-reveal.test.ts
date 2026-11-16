// Scrolling the sidebar to a project: which element is brought into view and how far the list
// moves. jsdom lays nothing out, so every element is given its box by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revealProjectInSidebar, scrollSidebarToProject } from './sidebar-reveal'

/** The sidebar's visible list area: 400px tall, from y=100 to y=500. */
const VIEW = { top: 100, bottom: 500 }

const scrollBy = vi.fn()

function box(element: Element, top: number, bottom: number): void {
  element.getBoundingClientRect = () =>
    ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect
}

/** Mounts the sidebar's list with the given sections and returns it. */
function mountSidebar(html: string): HTMLElement {
  document.body.innerHTML = `<div data-testid="sidebar-scroll-container">${html}</div>`
  const container = document.querySelector<HTMLElement>('[data-testid="sidebar-scroll-container"]')!
  box(container, VIEW.top, VIEW.bottom)
  container.scrollBy = scrollBy as never
  return container
}

const ALL_PROJECTS = `
  <div data-testid="all-projects-section">
    <div data-testid="all-projects-header"></div>
    <div data-testid="project-list">
      <div data-project-group="first"></div>
      <div data-project-group="second"></div>
      <div data-data-project-group="db"></div>
    </div>
  </div>`

const RECENT = `
  <div data-testid="recent-list">
    <div data-recent-project="hidden-by-space"></div>
  </div>`

const el = (selector: string): Element => document.querySelector(selector)!

beforeEach(() => {
  scrollBy.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('scrollSidebarToProject', () => {
  it('does not move when the project is in view', () => {
    mountSidebar(ALL_PROJECTS)
    box(el('[data-project-group="second"]'), 200, 300)
    expect(scrollSidebarToProject({ kind: 'git', id: 'second' })).toBe(true)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('brings a project below the view up until its last row shows', () => {
    mountSidebar(ALL_PROJECTS)
    box(el('[data-project-group="second"]'), 620, 700)
    scrollSidebarToProject({ kind: 'git', id: 'second' })
    expect(scrollBy).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' })
  })

  it('puts the top of a project above the view at the top', () => {
    mountSidebar(ALL_PROJECTS)
    box(el('[data-project-group="second"]'), -50, 30)
    scrollSidebarToProject({ kind: 'git', id: 'second' })
    expect(scrollBy).toHaveBeenCalledWith({ top: -150, behavior: 'smooth' })
  })

  it('shows the top of a project that is taller than the sidebar', () => {
    mountSidebar(ALL_PROJECTS)
    box(el('[data-project-group="second"]'), 450, 1200)
    scrollSidebarToProject({ kind: 'git', id: 'second' })
    expect(scrollBy).toHaveBeenCalledWith({ top: 350, behavior: 'smooth' })
  })

  it('shows the "All projects" heading above the project that leads the list', () => {
    mountSidebar(ALL_PROJECTS)
    box(el('[data-testid="all-projects-header"]'), 566, 594)
    box(el('[data-project-group="first"]'), 600, 700)
    scrollSidebarToProject({ kind: 'git', id: 'first' })
    // Heading and project fit: the project's last row comes up to the bottom edge.
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 200, behavior: 'smooth' })

    box(el('[data-testid="all-projects-header"]'), -84, -56)
    box(el('[data-project-group="first"]'), -50, 30)
    scrollSidebarToProject({ kind: 'git', id: 'first' })
    // From above, the heading (not the project) lands on the top edge.
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -184, behavior: 'smooth' })
  })

  it('finds a database by its own row', () => {
    mountSidebar(ALL_PROJECTS)
    box(el('[data-data-project-group="db"]'), 620, 648)
    expect(scrollSidebarToProject({ kind: 'data', id: 'db' })).toBe(true)
    expect(scrollBy).toHaveBeenCalledWith({ top: 148, behavior: 'smooth' })
    // A git project with the same id is another row.
    expect(scrollSidebarToProject({ kind: 'git', id: 'db' })).toBe(false)
  })

  it('shows the Recent section for a project the list leaves out', () => {
    mountSidebar(RECENT + ALL_PROJECTS)
    box(el('[data-testid="recent-list"]'), -300, -150)
    expect(scrollSidebarToProject({ kind: 'git', id: 'hidden-by-space' })).toBe(true)
    expect(scrollBy).toHaveBeenCalledWith({ top: -400, behavior: 'smooth' })
  })

  it('does nothing for a project with no row, or with the sidebar collapsed', () => {
    mountSidebar(ALL_PROJECTS)
    expect(scrollSidebarToProject({ kind: 'git', id: 'nowhere' })).toBe(false)
    document.body.innerHTML = ''
    expect(scrollSidebarToProject({ kind: 'git', id: 'second' })).toBe(false)
    expect(scrollBy).not.toHaveBeenCalled()
  })
})

describe('revealProjectInSidebar', () => {
  it('scrolls on the next frame, when the sidebar has rendered the change', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    revealProjectInSidebar({ kind: 'git', id: 'second' })

    // The row is only there by the time the frame runs.
    mountSidebar(ALL_PROJECTS)
    box(el('[data-project-group="second"]'), 620, 700)
    expect(scrollBy).not.toHaveBeenCalled()
    frames.forEach((frame) => frame(0))
    expect(scrollBy).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' })
  })
})
