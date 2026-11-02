import { render, screen } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSettings } from '@shared/types/pet'
import { getPet } from '@/pet/registry'
import { PetSprite } from '@/pet/PetSprite'
import { badgeFontSize, badgeKeyframes, sparkleKeyframes } from '@/pet/spriteSheet'
import { workingVariantIndex } from '@/pet/workingVariant'

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
  petId: 'french-bulldog',
  size: 'M',
  opacity: 1,
  animationSpeedEnabled: false,
  animationSpeed: 5,
  hasHatched: true
}

type FakeAnimation = {
  element: Element
  keyframes: Keyframe[] | PropertyIndexedKeyframes
  playbackRate: number
  currentTime: number
  cancel: ReturnType<typeof vi.fn>
}

let animations: FakeAnimation[]

function sprite(count: number, state: 'working' | 'idle' = 'working'): React.JSX.Element {
  return (
    <PetSprite
      pet={getPet('french-bulldog')}
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

// The design's exact badge size: 25 units through two digits, then 58 ÷ digits.
const designFontSize = (count: number): number =>
  Math.min(25, 58 / Math.max(2, String(count).length))

describe('French bulldog sprite-sheet pet', () => {
  beforeEach(() => {
    animations = []
    Element.prototype.animate = vi.fn(function (
      this: Element,
      keyframes: Keyframe[] | PropertyIndexedKeyframes
    ) {
      const animation: FakeAnimation = {
        element: this,
        keyframes,
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

  it('registers Shiba with the design study 05 atlases and decorations', () => {
    const pet = getPet('french-bulldog')
    const sheet = pet.workingSpriteSheet!
    expect(pet.name).toBe('Shiba the Frenchie')
    expect(pet.resolvedLottieAssets).toBeUndefined()
    expect(sheet).toMatchObject({ frames: 24, columns: 6, rows: 4, cycleMs: 800 })
    expect(sheet.inset).toBeUndefined()
    expect(sheet.variantSessions).toEqual([1, 2, 3, 4, 5, 10, 15, 20])
    for (const [index, level] of [1, 2, 3, 4, 4, 10, 15, 20].entries()) {
      expect(pet.resolvedWorkingSpriteSheetVariants?.[index]).toContain(
        `french-bulldog-run-${level}`
      )
    }
    expect(
      [0, 1, 4, 5, 9, 10, 14, 15, 19, 20, 999].map((n) => workingVariantIndex(pet, n))
    ).toEqual([0, 0, 3, 4, 4, 5, 5, 6, 6, 7, 7])

    // Anchors are authored in the 400-unit box, so cellSize is the box itself.
    expect(sheet.badge).toMatchObject({
      minSessions: 5,
      cellSize: 400,
      fontWeight: 600,
      color: '#795139',
      rotate: -7.45
    })
    expect(sheet.badge?.emblem).toBeUndefined()
    expect(sheet.badge?.anchors.slice(0, 3)).toEqual([null, null, null])
    expect(sheet.badge?.anchors[3]).toEqual(sheet.badge?.anchors[4])
    expect(sheet.badge?.anchors[3]?.[0]).toEqual([109.7, 226.5])
    expect(sheet.badge?.anchors[7]?.[7]).toEqual([121, 251.3])
    expect(sheet.badge?.anchors.slice(3).every((anchors) => anchors?.length === 8)).toBe(true)

    expect(sheet.sparkles).toMatchObject({
      minSessions: 5,
      color: '#cf9d4e',
      shape: 'glint',
      size: 0.03,
      opacity: [0.45, 1],
      positions: [
        [40, 120],
        [355, 100],
        [340, 350]
      ]
    })
    expect(sheet.sparkles?.variantColors).toEqual([...Array(7).fill(null), '#a9cbd6'])
  })

  it('reproduces the design badge size and 400-unit anchor translation', () => {
    const badge = getPet('french-bulldog').workingSpriteSheet!.badge!
    for (const count of [5, 42, 123, 1234, 123456]) {
      expect(badgeFontSize(badge, count)).toBeCloseTo(designFontSize(count), 10)
    }
    const keyframes = badgeKeyframes(badge.anchors[3]!, 24, badge.cellSize)
    expect(keyframes).toHaveLength(25)
    // 109.7 of 400 is 27.425% of the box: the anchors need no cell-to-box conversion.
    expect(keyframes[0].transform).toBe('translate(27.425%,56.625%)')
    // One third of the way from pose one to pose two, rounded like the design's export.
    expect(keyframes[1].transform).toBe(`translate(${109.97 / 4}%,${232.1 / 4}%)`)
    expect(keyframes[24].transform).toBe(keyframes[0].transform)

    expect(sparkleKeyframes(0, [0.45, 1])).toEqual({ opacity: [1, 0.45, 1] })
    expect(sparkleKeyframes(1, [0.45, 1])).toEqual({ opacity: [0.45, 1, 0.45] })
  })

  it('fills the sprite box with the atlas and keeps the cape patch blank at four', () => {
    const { container, rerender } = render(sprite(1))
    expect(atlasSrc(container)).toContain('french-bulldog-run-1')
    expect(container.querySelector('.pet-sheet')).toHaveStyle({
      '--pet-sheet-inset': '0%',
      '--pet-sheet-sparkle-size': '3%'
    })
    expect(container.querySelector('img.pet-lottie-fallback')?.getAttribute('src')).toContain(
      'french-bulldog.png'
    )
    expect(live()).toHaveLength(1)

    rerender(sprite(4))
    expect(atlasSrc(container)).toContain('french-bulldog-run-4')
    expect(container.querySelector('.pet-sheet-badge')).toBeNull()
    expect(container.querySelectorAll('.pet-sheet-sparkle')).toHaveLength(0)
    expect(live().map((a) => a.element.className)).toEqual(['pet-sheet-atlas'])

    rerender(sprite(0, 'idle'))
    expect(screen.queryByTestId('pet-sheet-working')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('french-bulldog.png')
  })

  it('shows the count in Georgia 600 from five with gold glints, ice blue at twenty', () => {
    const { container, rerender } = render(sprite(5))
    expect(atlasSrc(container)).toContain('french-bulldog-run-4')
    const count = screen.getByTestId('pet-sheet-count')
    expect(count).toHaveTextContent('5')
    expect(count).toHaveAttribute('font-size', '25')
    expect(count).toHaveAttribute('font-weight', '600')
    expect(count).toHaveAttribute('font-family', 'Georgia,serif')
    expect(count).toHaveAttribute('fill', '#795139')
    expect(container.querySelector('.pet-sheet-badge g')).toHaveAttribute(
      'transform',
      'rotate(-7.45)'
    )
    expect(container.querySelector('.pet-sheet-badge')).toHaveStyle({
      transform: 'translate(27.425%,56.625%)'
    })
    expect(live().map((a) => a.element.className)).toEqual([
      'pet-sheet-atlas',
      'pet-sheet-badge',
      'pet-sheet-sparkle',
      'pet-sheet-sparkle',
      'pet-sheet-sparkle'
    ])

    const sparkles = container.querySelectorAll('.pet-sheet-sparkle')
    expect(sparkles).toHaveLength(3)
    // Sparkle centres sit at the design positions: a 12-unit glint is offset by 6 units.
    expect(sparkles[0]).toHaveStyle({ left: `${(40 - 6) / 4}%`, top: `${(120 - 6) / 4}%` })
    expect(sparkles[2]).toHaveStyle({ left: `${(340 - 6) / 4}%`, top: `${(350 - 6) / 4}%` })
    expect(sparkles[0].querySelector('path')).toHaveAttribute('fill', '#cf9d4e')
    expect(sparkles[0].querySelector('path')?.getAttribute('d')).toMatch(/^M0-5Q/)
    expect(
      live()
        .slice(2)
        .map((a) => a.keyframes)
    ).toEqual([{ opacity: [1, 0.45, 1] }, { opacity: [0.45, 1, 0.45] }, { opacity: [1, 0.45, 1] }])

    for (const count of [6, 9]) {
      const before = live()
      rerender(sprite(count))
      expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent(String(count))
      expect(live()).toEqual(before)
    }

    rerender(sprite(123))
    expect(atlasSrc(container)).toContain('french-bulldog-run-20')
    expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent('123')
    expect(Number(screen.getByTestId('pet-sheet-count').getAttribute('font-size'))).toBeCloseTo(
      58 / 3,
      10
    )
    expect(container.querySelector('.pet-sheet-badge')).toHaveStyle({
      transform: 'translate(29.125%,57.9%)'
    })
    container
      .querySelectorAll('.pet-sheet-sparkle path')
      .forEach((path) => expect(path).toHaveAttribute('fill', '#a9cbd6'))

    rerender(sprite(15))
    expect(atlasSrc(container)).toContain('french-bulldog-run-15')
    container
      .querySelectorAll('.pet-sheet-sparkle path')
      .forEach((path) => expect(path).toHaveAttribute('fill', '#cf9d4e'))
  })
})
