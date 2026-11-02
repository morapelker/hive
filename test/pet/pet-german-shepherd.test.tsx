import { render, screen } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSettings } from '@shared/types/pet'
import { getPet } from '@/pet/registry'
import { PetSprite } from '@/pet/PetSprite'
import { badgePercent } from '@/pet/spriteSheet'
import { workingVariantIndex, workingVariantSource } from '@/pet/workingVariant'

vi.mock('motion/react', () => ({
  motion: {
    span: ({
      children,
      animate: _animate,
      transition: _transition,
      ...props
    }: React.ComponentProps<'span'> & { animate?: unknown; transition?: unknown }) => (
      <span {...props}>{children}</span>
    )
  }
}))

const settings: PetSettings = {
  enabled: true,
  petId: 'german-shepherd',
  size: 'M',
  opacity: 1,
  animationSpeedEnabled: false,
  animationSpeed: 5,
  hasHatched: true
}

type FakeAnimation = {
  element: Element
  keyframes: Keyframe[] | PropertyIndexedKeyframes
  options: KeyframeAnimationOptions
  playbackRate: number
  currentTime: number
  cancel: ReturnType<typeof vi.fn>
}

let animations: FakeAnimation[]

function sprite(count: number, state: 'working' | 'idle' = 'working'): React.JSX.Element {
  return (
    <PetSprite
      pet={getPet('german-shepherd')}
      state={state}
      settings={settings}
      workingSessionCount={count}
      onPointerDown={vi.fn()}
      onMouseEnter={vi.fn()}
      onMouseLeave={vi.fn()}
      onClick={vi.fn()}
      onContextMenu={vi.fn()}
    />
  )
}

const live = (): FakeAnimation[] => animations.filter((a) => !a.cancel.mock.calls.length)
const atlasSrc = (container: HTMLElement): string | null | undefined =>
  container.querySelector('.pet-sheet-atlas')?.getAttribute('src')

describe('Udi the German Shepherd sprite-sheet pet', () => {
  beforeEach(() => {
    animations = []
    Element.prototype.animate = vi.fn(function (
      this: Element,
      keyframes: Keyframe[] | PropertyIndexedKeyframes,
      options: KeyframeAnimationOptions
    ) {
      const animation: FakeAnimation = {
        element: this,
        keyframes,
        options,
        playbackRate: 1,
        currentTime: 0,
        cancel: vi.fn()
      }
      animations.push(animation)
      return animation as unknown as Animation
    }) as unknown as typeof Element.prototype.animate
  })

  afterEach(() => {
    // @ts-expect-error jsdom has no Web Animations API; the polyfill is test-only.
    delete Element.prototype.animate
  })

  it('registers Udi with the collection milestones and six atlases', () => {
    const pet = getPet('german-shepherd')
    expect(pet.name).toBe('Udi the German Shepherd')
    expect(pet.resolvedAssets.idle).toContain('german-shepherd')
    expect(pet.resolvedLottieAssets).toBeUndefined()
    const sheet = pet.workingSpriteSheet!
    expect(sheet.variantSessions).toEqual([1, 2, 3, 4, 5, 10, 15, 20])
    expect(sheet).toMatchObject({
      frames: 64,
      columns: 8,
      rows: 8,
      cycleMs: 1000,
      inset: 0,
      shadow: false
    })
    // The seated portrait is scaled down so it reads as the same dog as the wide run cycle.
    expect(pet.imageScale).toEqual({ idle: 0.8, question: 0.8, permission: 0.8, plan_ready: 0.8 })
    expect(pet.resolvedWorkingSpriteSheetVariants).toHaveLength(8)
    // Two worktrees is still an open slot and shares the base run; five shares the first cape.
    for (const [index, level] of [1, 1, 3, 4, 4, 10, 15, 20].entries()) {
      expect(pet.resolvedWorkingSpriteSheetVariants?.[index]).toContain(
        `german-shepherd-run-${level}`
      )
    }
    expect(workingVariantSource(pet).workingLottieVariants).toHaveLength(8)
    expect(
      [0, 1, 2, 3, 4, 5, 9, 10, 14, 15, 19, 20, 999].map((n) => workingVariantIndex(pet, n))
    ).toEqual([0, 0, 1, 2, 3, 4, 4, 5, 5, 6, 6, 7, 7])
  })

  it('carries one badge anchor per key pose for every cape, measured in 448 px cells', () => {
    const badge = getPet('german-shepherd').workingSpriteSheet!.badge!
    expect(badge).toMatchObject({
      minSessions: 5,
      cellSize: 448,
      fontSize: 30,
      fullSizeDigits: 2,
      emblem: 'paw',
      rotate: -10
    })
    expect(badge.anchors).toHaveLength(8)
    expect(badge.anchors.slice(0, 3)).toEqual([null, null, null])
    expect(badge.anchors[3]).toEqual(badge.anchors[4])
    for (const anchors of badge.anchors.slice(3)) {
      expect(anchors).toHaveLength(8)
      for (const [x, y] of anchors!) {
        // The patch sits on the cape's outer flank, left of centre and below the shoulders.
        expect(x).toBeGreaterThan(90)
        expect(x).toBeLessThan(160)
        expect(y).toBeGreaterThan(210)
        expect(y).toBeLessThan(290)
      }
    }
    const sparkles = getPet('german-shepherd').workingSpriteSheet!.sparkles!
    expect(sparkles.minSessions).toBe(5)
    expect(sparkles.positions).toHaveLength(3)
  })

  it('runs the base look from one worktree and keeps the idle portrait for other states', () => {
    const { container, rerender } = render(sprite(1))
    expect(screen.getByTestId('pet-sheet-working')).toHaveAttribute('data-variant', '0')
    expect(atlasSrc(container)).toContain('german-shepherd-run-1')
    expect(container.querySelector('.pet-sheet-badge')).toBeNull()
    // The run fills its box, so the overlay's drop shadow would sit as a dark blob behind the paws.
    expect(container.querySelector('.pet-sprite')).toHaveAttribute('data-shadow', 'none')
    expect(live()).toHaveLength(1)
    expect(live()[0].options).toEqual({ duration: 1000, iterations: Infinity })

    const before = live()
    rerender(sprite(2))
    // Same atlas for the open slot: the run cycle keeps going.
    expect(atlasSrc(container)).toContain('german-shepherd-run-1')
    expect(live()).toEqual(before)

    rerender(sprite(3))
    expect(atlasSrc(container)).toContain('german-shepherd-run-3')

    rerender(sprite(0, 'idle'))
    expect(screen.queryByTestId('pet-sheet-working')).toBeNull()
    expect(container.querySelector('.pet-sprite')).not.toHaveAttribute('data-shadow')
    expect(container.querySelector('img')?.getAttribute('src')).toContain('german-shepherd')
    expect(live()).toHaveLength(0)
  })

  it('shows the paw on the cape at four and the count with sparkles from five', () => {
    const pet = getPet('german-shepherd')
    const badge = pet.workingSpriteSheet!.badge!
    const { container, rerender } = render(sprite(4))
    expect(atlasSrc(container)).toContain('german-shepherd-run-4')
    expect(container.querySelector('.pet-sheet-badge ellipse')).toBeInTheDocument()
    expect(screen.queryByTestId('pet-sheet-count')).toBeNull()
    const [x, y] = badge.anchors[3]![0]
    expect(container.querySelector('.pet-sheet-badge')).toHaveStyle({
      transform: `translate(${badgePercent(x, 448)}%,${badgePercent(y, 448)}%)`
    })

    rerender(sprite(5))
    expect(atlasSrc(container)).toContain('german-shepherd-run-4')
    expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent('5')
    expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute('font-size', '30')
    expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute('fill', '#5b3523')
    expect(container.querySelector('.pet-sheet-badge g')).toHaveAttribute(
      'transform',
      'rotate(-10)'
    )
    expect(container.querySelectorAll('.pet-sheet-sparkle')).toHaveLength(3)

    for (const [count, atlas] of [
      [10, 'german-shepherd-run-10'],
      [15, 'german-shepherd-run-15'],
      [20, 'german-shepherd-run-20'],
      [123, 'german-shepherd-run-20']
    ] as Array<[number, string]>) {
      rerender(sprite(count))
      expect(atlasSrc(container)).toContain(atlas)
      expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent(String(count))
    }
    expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute('font-size', String(30 * (2 / 3)))
  })
})
