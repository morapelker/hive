/**
 * The thin moving bar under a ticket or session at work: its color and accessible name say
 * what the agent is doing, and the more pressing states win over the mode's own color.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { IndeterminateProgressBar } from './IndeterminateProgressBar'

const bar = (): HTMLElement => screen.getByRole('progressbar')
const innerBar = (): Element => {
  const inner = bar().firstElementChild
  if (!inner) throw new Error('the bar has no moving part')
  return inner
}

afterEach(() => {
  cleanup()
})

describe('IndeterminateProgressBar', () => {
  it('is blue and "working" for a build session', () => {
    render(<IndeterminateProgressBar mode="build" />)

    expect(bar()).toHaveAccessibleName('Agent is working')
    expect(innerBar().className).toContain('bg-blue-500')
  })

  it("turns fuchsia and says so while a document run's migrations are executed", () => {
    render(<IndeterminateProgressBar mode="build" isRunningMigrations />)

    expect(bar()).toHaveAccessibleName('Running migrations')
    expect(innerBar().className).toContain('bg-fuchsia-500')
    expect(innerBar().className).not.toContain('bg-blue-500')
  })

  it('wears the migrations color in every mode', () => {
    for (const mode of ['plan', 'super-plan', 'super-build'] as const) {
      cleanup()
      render(<IndeterminateProgressBar mode={mode} isRunningMigrations />)
      expect(innerBar().className, mode).toContain('bg-fuchsia-500')
    }
  })

  it('does not wear fuchsia when the flag is off', () => {
    render(<IndeterminateProgressBar mode="build" isRunningMigrations={false} />)

    expect(bar()).toHaveAccessibleName('Agent is working')
    expect(innerBar().className).not.toContain('bg-fuchsia-500')
  })

  it.each([
    ['a question', { isAsking: true }, 'Waiting for answer', 'bg-amber-500'],
    ['merge conflicts', { isFixingConflicts: true }, 'Fixing merge conflicts', 'bg-red-500'],
    ['compaction', { isCompacting: true }, 'Compacting conversation', 'bg-amber-500']
  ] as const)('lets %s win over the migrations', (_name, flags, name, color) => {
    render(<IndeterminateProgressBar mode="build" isRunningMigrations {...flags} />)

    expect(bar()).toHaveAccessibleName(name)
    expect(innerBar().className).toContain(color)
    expect(innerBar().className).not.toContain('bg-fuchsia-500')
  })

  it("turns pink and says so while a merged ticket's session edits the run's document", () => {
    render(<IndeterminateProgressBar mode="build" isEditingDocument />)

    expect(bar()).toHaveAccessibleName('Editing document')
    expect(innerBar().className).toContain('bg-pink-500')
    expect(innerBar().className).not.toContain('bg-blue-500')
  })

  it('wears the document color in every mode', () => {
    for (const mode of ['plan', 'super-plan', 'super-build'] as const) {
      cleanup()
      render(<IndeterminateProgressBar mode={mode} isEditingDocument />)
      expect(innerBar().className, mode).toContain('bg-pink-500')
    }
  })

  it.each([
    ['a question', { isAsking: true }, 'Waiting for answer', 'bg-amber-500'],
    ['merge conflicts', { isFixingConflicts: true }, 'Fixing merge conflicts', 'bg-red-500'],
    ['compaction', { isCompacting: true }, 'Compacting conversation', 'bg-amber-500']
  ] as const)('lets %s win over editing the document', (_name, flags, name, color) => {
    render(<IndeterminateProgressBar mode="build" isEditingDocument {...flags} />)

    expect(bar()).toHaveAccessibleName(name)
    expect(innerBar().className).toContain(color)
    expect(innerBar().className).not.toContain('bg-pink-500')
  })

  it.each([
    ['reviewing', { isReviewing: true }],
    ['migrations', { isRunningMigrations: true }]
  ] as const)('wins over %s', (_name, flags) => {
    render(<IndeterminateProgressBar mode="build" isEditingDocument {...flags} />)

    expect(bar()).toHaveAccessibleName('Editing document')
    expect(innerBar().className).toContain('bg-pink-500')
  })
})
