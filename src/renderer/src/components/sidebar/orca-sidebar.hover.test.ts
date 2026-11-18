import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'
import {
  SECTION_HEADER_ACTIONS,
  SECTION_HEADER_ACTION_BUTTON,
  SECTION_HEADER_ROW
} from './orca-sidebar'

// There is one header row per project, all mounted at once. What every one of them costs
// while the pointer moves is decided by these classes (measured with 414 projects: about
// 4.5 ms of main-thread time per mouse move before, about 1.9 ms with them).
describe('sidebar header rows stay cheap to hover', () => {
  const classes = (value: string): string[] => value.split(/\s+/)

  it('does not animate the row', () => {
    expect(classes(SECTION_HEADER_ROW).some((c) => c.includes('transition'))).toBe(false)
  })

  it('keeps an idle actions cluster out of the render tree, and shows it without a fade', () => {
    const cluster = classes(SECTION_HEADER_ACTIONS)
    expect(cluster).toContain('can-hover:hidden')
    expect(cluster).toContain('can-hover:group-hover:flex')
    expect(cluster.some((c) => c.includes('transition'))).toBe(false)
  })

  it('still renders the cluster for a focused button, an open menu and keyboard navigation', () => {
    const cluster = classes(SECTION_HEADER_ACTIONS)
    expect(cluster).toContain('can-hover:has-[:focus-visible]:flex')
    expect(cluster).toContain('can-hover:has-[button[data-state=open]]:flex')
    expect(cluster).toContain('can-hover:sidebar-keyboard:flex')
  })

  it('lets a caller force the cluster visible', () => {
    const forced = classes(cn(SECTION_HEADER_ACTIONS, 'can-hover:flex'))
    expect(forced).toContain('can-hover:flex')
    expect(forced).not.toContain('can-hover:hidden')
  })

  it('does not animate the width of an action button', () => {
    const transition = classes(SECTION_HEADER_ACTION_BUTTON).find((c) => c.startsWith('transition'))
    expect(transition).toBe('transition-[background-color,color]')
  })
})
