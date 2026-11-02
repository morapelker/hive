import { render, screen } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSettings } from '@shared/types/pet'
import { getPet } from '@/pet/registry'
import { PetSprite } from '@/pet/PetSprite'
import { atlasKeyframes, badgeFontSize, badgeFrames, badgeKeyframes } from '@/pet/spriteSheet'
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
  petId: 'pug',
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

function sprite(
  count: number,
  state: 'working' | 'idle' | 'question' = 'working',
  speedEnabled = false,
  maxSpeed = 5
): React.JSX.Element {
  return (
    <PetSprite
      pet={getPet('pug')}
      state={state}
      settings={{ ...settings, animationSpeedEnabled: speedEnabled, animationSpeed: maxSpeed }}
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

describe('pug sprite-sheet pet', () => {
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

  it('registers Twix with eight sprite-sheet styles in session-count order', () => {
    const pet = getPet('pug')
    expect(pet.name).toBe('Twix the Pug')
    expect(pet.resolvedAssets.idle).toContain('pug')
    expect(pet.resolvedLottieAssets).toBeUndefined()
    expect(pet.workingSpriteSheet?.variantSessions).toEqual([1, 2, 3, 4, 5, 10, 15, 20])
    expect(pet.workingSpriteSheet).toMatchObject({ frames: 24, columns: 6, rows: 4, cycleMs: 800 })
    expect(pet.resolvedWorkingSpriteSheetVariants).toHaveLength(8)
    for (const [index, level] of [1, 2, 3, 4, 4, 10, 15, 20].entries()) {
      expect(pet.resolvedWorkingSpriteSheetVariants?.[index]).toContain(`pug-run-${level}`)
    }
    expect(workingVariantSource(pet).workingLottieVariants).toHaveLength(8)
    expect(
      [0, 1, 4, 5, 9, 10, 14, 15, 19, 20, 999].map((n) => workingVariantIndex(pet, n))
    ).toEqual([0, 0, 3, 4, 4, 5, 5, 6, 6, 7, 7])
  })

  it('interpolates badge anchors across the run cycle and wraps at the loop seam', () => {
    const anchors = [
      [0, 0],
      [8, 16],
      [16, 0],
      [8, -16]
    ]
    const frames = badgeFrames(anchors, 8)
    expect(frames).toHaveLength(8)
    expect(frames[0]).toEqual([0, 0])
    expect(frames[1]).toEqual([4, 8])
    expect(frames[2]).toEqual([8, 16])
    expect(frames[7]).toEqual([4, -8]) // halfway from the last pose back to the first
    expect(badgeFrames(anchors, 4)).toEqual(anchors)

    expect(badgeFontSize({ fontSize: 29, fullSizeDigits: 2 }, 5)).toBe(29)
    expect(badgeFontSize({ fontSize: 29, fullSizeDigits: 2 }, 42)).toBe(29)
    expect(badgeFontSize({ fontSize: 29, fullSizeDigits: 2 }, 123)).toBeCloseTo(29 * (2 / 3))
    expect(badgeFontSize({ fontSize: 29, fullSizeDigits: 2 }, 123456)).toBeCloseTo(29 / 3)
  })

  it('steps the atlas through its grid with discrete keyframes', () => {
    const keyframes = atlasKeyframes({ frames: 24, columns: 6, rows: 4 })
    expect(keyframes).toHaveLength(25)
    expect(keyframes[0]).toEqual({
      transform: 'translate(0%,0%)',
      offset: 0,
      easing: 'steps(1,end)'
    })
    expect(keyframes[7].transform).toBe(`translate(${-100 / 6}%,-25%)`)
    expect(keyframes[23].transform).toBe(`translate(${(-100 / 6) * 5}%,-75%)`)
    expect(keyframes[24]).toMatchObject({ transform: 'translate(0%,0%)', offset: 1 })

    const badge = badgeKeyframes(getPet('pug').workingSpriteSheet!.badge!.anchors[3]!, 24, 443.5)
    expect(badge).toHaveLength(25)
    // 121 source pixels → 109.13 of 400 → 27.2825% of the box, matching the design's SVG export.
    expect(badge[0].transform).toBe('translate(27.2825%,61.7825%)')
    expect(badge[24].transform).toBe(badge[0].transform)
  })

  it('renders the atlas for the current style and keeps other states on the portrait', () => {
    const { container, rerender } = render(sprite(1))
    expect(screen.getByTestId('pet-sheet-working')).toHaveAttribute('data-variant', '0')
    expect(atlasSrc(container)).toContain('pug-run-1')
    expect(container.querySelector('.pet-sheet')).toHaveStyle({
      '--pet-sheet-inset': '6%',
      '--pet-sheet-columns': '6',
      '--pet-sheet-rows': '4'
    })
    expect(container.querySelector('img.pet-lottie-fallback')?.getAttribute('src')).toContain('pug')
    expect(container.querySelector('.pet-sheet-badge')).toBeNull()
    expect(container.querySelectorAll('.pet-sheet-sparkle')).toHaveLength(0)
    expect(live()).toHaveLength(1)
    expect(live()[0].options).toEqual({ duration: 800, iterations: Infinity })

    rerender(sprite(0, 'idle'))
    expect(screen.queryByTestId('pet-sheet-working')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('pug')
    expect(live()).toHaveLength(0)

    rerender(sprite(3, 'question'))
    expect(screen.queryByTestId('pet-sheet-working')).toBeNull()
    expect(container.querySelector('.pet-bubble-question')).toBeInTheDocument()
  })

  it('shows the paw at four, the exact count from five, and sparkles alongside the number', () => {
    const { container, rerender } = render(sprite(4))
    expect(atlasSrc(container)).toContain('pug-run-4')
    expect(container.querySelector('.pet-sheet-badge')).toBeInTheDocument()
    expect(container.querySelector('.pet-sheet-badge ellipse')).toBeInTheDocument()
    expect(screen.queryByTestId('pet-sheet-count')).toBeNull()
    expect(container.querySelectorAll('.pet-sheet-sparkle')).toHaveLength(0)
    expect(live().map((a) => a.element.className)).toEqual(['pet-sheet-atlas', 'pet-sheet-badge'])
    expect(container.querySelector('.pet-sheet-badge')).toHaveStyle({
      transform: 'translate(27.2825%,61.7825%)'
    })

    rerender(sprite(5))
    expect(atlasSrc(container)).toContain('pug-run-4')
    expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent('5')
    expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute('font-size', '29')
    expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute('fill', '#795139')
    expect(container.querySelector('.pet-sheet-badge g')).toHaveAttribute(
      'transform',
      'rotate(-18)'
    )
    expect(container.querySelectorAll('.pet-sheet-sparkle')).toHaveLength(3)
    expect(container.querySelectorAll('.pet-sheet-sparkle')[1]).toHaveStyle({
      left: `${(364 - 5) / 4}%`,
      top: `${(211 - 5) / 4}%`
    })
    const sparkleAnimations = live().filter((a) => a.element.className === 'pet-sheet-sparkle')
    expect(sparkleAnimations).toHaveLength(3)
    expect(sparkleAnimations.map((a) => a.keyframes)).toEqual([
      { opacity: [0.8, 0.1, 0.8] },
      { opacity: [0.1, 0.8, 0.1] },
      { opacity: [0.8, 0.1, 0.8] }
    ])

    for (const count of [6, 7, 9]) {
      const before = live()
      rerender(sprite(count))
      expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent(String(count))
      expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute('font-size', '29')
      // Same atlas, same cape: only the embroidery changes, the run cycle keeps going.
      expect(live()).toEqual(before)
    }

    // Three or more digits shrink to fit the badge and are never capped at 20.
    for (const count of [123, 12345]) {
      rerender(sprite(count))
      expect(atlasSrc(container)).toContain('pug-run-20')
      expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent(String(count))
      expect(screen.getByTestId('pet-sheet-count')).toHaveAttribute(
        'font-size',
        String(29 * Math.min(1, 2 / String(count).length))
      )
    }
  })

  it('switches atlases at each milestone and scales playback with the session count', () => {
    const { container, rerender } = render(sprite(5, 'working', true, 5))
    expect(live().every((a) => a.playbackRate === 5)).toBe(true)

    const expectedAtlas: Array<[number, string]> = [
      [9, 'pug-run-4'],
      [10, 'pug-run-10'],
      [15, 'pug-run-15'],
      [20, 'pug-run-20'],
      [99, 'pug-run-20'],
      [2, 'pug-run-2']
    ]
    for (const [count, atlas] of expectedAtlas) {
      const before = live()
      rerender(sprite(count, 'working', true, 5))
      expect(atlasSrc(container)).toContain(atlas)
      if (!before.some((a) => (a.element as HTMLImageElement).src.includes(atlas))) {
        expect(before.every((a) => a.cancel.mock.calls.length === 1)).toBe(true)
      }
      expect(live().length).toBeGreaterThan(0)
      expect(live().every((a) => a.playbackRate === Math.min(count, 5))).toBe(true)
    }

    rerender(sprite(20, 'working', true, 2))
    expect(live().every((a) => a.playbackRate === 2)).toBe(true)
    rerender(sprite(20, 'working', false, 2))
    expect(live().every((a) => a.playbackRate === 1)).toBe(true)
    expect(screen.getByTestId('pet-sheet-count')).toHaveTextContent('20')
  })
})
