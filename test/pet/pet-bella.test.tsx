import { act, render, screen } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSettings } from '@shared/types/pet'
import { getPet, listPets } from '@/pet/registry'
import { PetSprite } from '@/pet/PetSprite'
import { CanvasAtlasSprite } from '@/pet/CanvasAtlasSprite'
import {
  atlasFrameAt,
  atlasStageWidth,
  counterAnchorAt,
  counterFontSize,
  createAtlasRenderer,
  drawCounter
} from '@/pet/atlasCanvas'
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

// Atlases decode instantly into a stand-in image; the draw only hands it to the mocked context.
vi.mock('@/pet/atlasImage', () => ({
  loadAtlasImage: vi.fn(async (src: string) => ({ src, kind: 'atlas' }))
}))

const drawSpy = vi.hoisted(() => vi.fn())
vi.mock('@/pet/atlasCanvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pet/atlasCanvas')>()
  return {
    ...actual,
    createAtlasRenderer: (atlas: Parameters<typeof actual.createAtlasRenderer>[0]) => {
      const draw = actual.createAtlasRenderer(atlas)
      return (...args: Parameters<typeof draw>) => {
        drawSpy(...args)
        draw(...args)
      }
    }
  }
})

const settings: PetSettings = {
  enabled: true,
  petId: 'bella',
  size: 'M',
  opacity: 1,
  animationSpeedEnabled: false,
  animationSpeed: 5,
  hasHatched: true
}

type Draw = { op: string; alpha: number; args: unknown[] }
type FakeContext = {
  canvas: HTMLCanvasElement
  draws: Draw[]
  calls: Array<[string, unknown[]]>
  font: string
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineJoin: string
  globalAlpha: number
  globalCompositeOperation: string
  textAlign: string
  textBaseline: string
}

const contexts = new WeakMap<HTMLCanvasElement, FakeContext>()
let frames: Array<FrameRequestCallback | null>
const originalGetContext = HTMLCanvasElement.prototype.getContext
const originalRaf = window.requestAnimationFrame
const originalCaf = window.cancelAnimationFrame

function fakeContext(canvas: HTMLCanvasElement): FakeContext {
  let context = contexts.get(canvas)
  if (context) return context
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      context!.calls.push([name, args])
    }
  context = {
    canvas,
    draws: [],
    calls: [],
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textAlign: '',
    textBaseline: '',
    clearRect: record('clearRect'),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
    rotate: record('rotate'),
    transform: record('transform'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    roundRect: record('roundRect'),
    fill: record('fill'),
    stroke: record('stroke'),
    measureText: (text: string) => ({ width: text.length * 10 }),
    drawImage(...args: unknown[]) {
      context!.draws.push({
        op: context!.globalCompositeOperation,
        alpha: context!.globalAlpha,
        args
      })
      context!.calls.push(['drawImage', args])
    }
  } as unknown as FakeContext
  contexts.set(canvas, context)
  return context
}

const call = (context: FakeContext, name: string): unknown[][] =>
  context.calls.filter(([method]) => method === name).map(([, args]) => args)

function advance(now: number): void {
  const pending = frames.filter((frame): frame is FrameRequestCallback => frame !== null)
  frames = []
  act(() => {
    for (const frame of pending) frame(now)
  })
}

const settle = (): Promise<void> =>
  act(async () => {
    for (let index = 0; index < 3; index++) await Promise.resolve()
  })

function sprite(
  count: number,
  state: 'working' | 'idle' | 'question' = 'working'
): React.JSX.Element {
  return (
    <PetSprite
      pet={getPet('bella')}
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

const atlasOf = (container: HTMLElement): string | null | undefined =>
  container.querySelector('.pet-atlas')?.getAttribute('data-atlas')

describe('Bella the Tennis Player canvas-atlas pet', () => {
  beforeEach(() => {
    frames = []
    drawSpy.mockClear()
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return fakeContext(this)
    } as typeof HTMLCanvasElement.prototype.getContext
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => frames.push(callback)
    window.cancelAnimationFrame = (handle: number): void => {
      frames[handle - 1] = null
    }
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    window.requestAnimationFrame = originalRaf
    window.cancelAnimationFrame = originalCaf
  })

  it('registers Bella with the package thresholds, dimensions, timing and counter settings', () => {
    const pet = getPet('bella')
    expect(pet.name).toBe('Bella the Tennis Player')
    expect(listPets().map((entry) => entry.id)).toContain('bella')
    expect(pet.resolvedAssets.idle).toContain('bella-sitting')
    expect(pet.resolvedLottieAssets).toBeUndefined()
    expect(pet.workingSpriteSheet).toBeUndefined()
    const atlas = pet.workingAtlas!
    expect(atlas).toMatchObject({
      frames: 128,
      columns: 16,
      rows: 8,
      cycleMs: 1920,
      cellHeight: 256,
      shadow: false
    })
    expect(atlas.variants.map((variant) => variant.minSessions)).toEqual([1, 2, 4, 6, 10, 15])
    expect(atlas.variants.map((variant) => variant.cellWidth)).toEqual([
      256, 256, 256, 256, 256, 352
    ])
    expect(atlas.variants.every((variant) => variant.cellHeight === 256)).toBe(true)
    for (const [index, level] of [1, 4, 6, 10, 14, 21].entries()) {
      expect(atlas.variants[index].file).toContain(`bella-run-${level}`)
      expect(pet.resolvedWorkingAtlasVariants?.[index]).toContain(`bella-run-${level}`)
    }
    // The count rides on the polo from four sessions; the two earlier stages have no anchors.
    expect(atlas.variants.slice(0, 2).map((variant) => variant.counterAnchors)).toEqual([
      null,
      null
    ])
    for (const variant of atlas.variants.slice(2)) {
      expect(variant.counterAnchors).toHaveLength(128)
      for (const anchor of variant.counterAnchors!) {
        expect(anchor).toHaveLength(2)
        expect(anchor.every(Number.isFinite)).toBe(true)
      }
    }
    // The kit number: large white digits with a magenta outline, leaning with the torso.
    expect(atlas.counter).toEqual({
      minSessions: 4,
      style: 'jersey',
      color: '#ffffff',
      outline: { color: '#b00068', width: 3 },
      fontFamily: "ui-rounded, 'Arial Rounded MT Bold', system-ui, sans-serif",
      fontWeight: 700,
      fontSizes: { '1': 34, '2': 30, '3': 24 },
      rotationRadians: 0.04,
      skewX: -0.07
    })
    // The flame stage is wider than the box, so the stage (and the window) is 352 / 256 as wide.
    expect(pet.stageWidthRatio).toBe(352 / 256)

    expect(workingVariantSource(pet).workingLottieVariants).toHaveLength(6)
    expect(
      [0, 1, 2, 3, 4, 5, 6, 9, 10, 14, 15, 999].map((count) => workingVariantIndex(pet, count))
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
  })

  it('walks the clock in fractional frames and wraps the last frame into the first', () => {
    const atlas = getPet('bella').workingAtlas!
    // 1,920 ms over 128 frames is exactly 15 ms per frame.
    expect(atlasFrameAt(atlas, 0)).toEqual({ index: 0, next: 1, mix: 0 })
    expect(atlasFrameAt(atlas, 15)).toEqual({ index: 1, next: 2, mix: 0 })
    expect(atlasFrameAt(atlas, 1912.5)).toEqual({ index: 127, next: 0, mix: 0.5 })
    expect(atlasFrameAt(atlas, 1920)).toEqual({ index: 0, next: 1, mix: 0 })
    expect(atlasFrameAt(atlas, -7.5)).toEqual({ index: 127, next: 0, mix: 0.5 })

    expect(
      counterAnchorAt(
        [
          [0, 0],
          [10, 20]
        ],
        { index: 0, next: 1, mix: 0.25 }
      )
    ).toEqual([2.5, 5])
    expect([6, 42, 999, 1000].map((count) => counterFontSize(atlas.counter!, count))).toEqual([
      34, 30, 24, 24
    ])

    const [normal, fire] = [atlas.variants[0], atlas.variants[5]]
    expect([64, 96, 128].map((height) => atlasStageWidth(normal, height))).toEqual([64, 96, 128])
    expect([64, 96, 128].map((height) => atlasStageWidth(fire, height))).toEqual([88, 132, 176])
  })

  it('blends the two frames around the clock with premultiplied weights and prints the count', () => {
    const atlas = getPet('bella').workingAtlas!
    const draw = createAtlasRenderer(atlas)
    const image = { kind: 'atlas' } as unknown as CanvasImageSource
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const context = fakeContext(canvas)

    // Halfway between frames 17 (column 1, row 1) and 18 (column 2, row 1).
    draw(canvas, image, atlas.variants[2], 4, 17 * 15 + 7.5)

    const [stage] = call(context, 'drawImage')
    const scratch = fakeContext(stage[0] as HTMLCanvasElement)
    expect(scratch.draws).toEqual([
      { op: 'source-over', alpha: 0.5, args: [image, 256, 256, 256, 256, 0, 0, 256, 256] },
      { op: 'lighter', alpha: 0.5, args: [image, 512, 256, 256, 256, 0, 0, 256, 256] }
    ])
    expect(scratch.globalAlpha).toBe(1)
    expect(scratch.globalCompositeOperation).toBe('source-over')
    expect(stage.slice(1)).toEqual([0, 0])
    expect(call(context, 'scale')).toEqual([[0.375, 0.375]])

    const anchors = atlas.variants[2].counterAnchors!
    const [[x, y]] = call(context, 'translate').slice(-1)
    expect(x).toBeCloseTo((anchors[17][0] + anchors[18][0]) / 2, 10)
    expect(y).toBeCloseTo((anchors[17][1] + anchors[18][1]) / 2, 10)
    expect(call(context, 'rotate')).toEqual([[0.04]])
    expect(call(context, 'transform')).toEqual([[1, 0, -0.07, 1, 0, 0]])
    expect(context.font).toBe("700 34px ui-rounded, 'Arial Rounded MT Bold', system-ui, sans-serif")
    // Jersey: the outline is stroked under the white fill, and no badge is drawn.
    expect(context.strokeStyle).toBe('#b00068')
    expect(context.lineWidth).toBe(3)
    expect(context.lineJoin).toBe('round')
    expect(call(context, 'strokeText')).toEqual([['4', 0, 0]])
    expect(context.fillStyle).toBe('#ffffff')
    expect(context.textAlign).toBe('center')
    expect(context.textBaseline).toBe('middle')
    expect(call(context, 'fillText')).toEqual([['4', 0, 0]])
    expect(call(context, 'beginPath')).toEqual([])
    expect(context.globalCompositeOperation).toBe('source-over')

    // No count below four, and none on a stage without anchors.
    context.calls = []
    draw(canvas, image, atlas.variants[2], 3, 0)
    draw(canvas, image, atlas.variants[1], 4, 0)
    expect(call(context, 'fillText')).toEqual([])

    // The flame stage: 352 px cells fill a 176 x 128 canvas edge to edge, three-digit counts shrink.
    const wide = document.createElement('canvas')
    wide.width = 176
    wide.height = 128
    const wideContext = fakeContext(wide)
    draw(wide, image, atlas.variants[5], 999, 0)
    expect(call(wideContext, 'scale')).toEqual([[0.5, 0.5]])
    expect(call(wideContext, 'translate')[0]).toEqual([0, 0])
    expect(scratch.draws.slice(-2).map((entry) => entry.args.slice(1, 5))).toEqual([
      [0, 0, 352, 256],
      [352, 0, 352, 256]
    ])
    expect(wideContext.font).toContain('700 24px')
    expect(call(wideContext, 'fillText')).toEqual([['999', 0, 0]])
  })

  it('draws the count in each style: bare, inked into the fabric, outlined, on a patch or a bib', () => {
    const base = getPet('bella').workingAtlas!.counter!
    const draw = (counter: Partial<typeof base>, count = 42): FakeContext => {
      const context = fakeContext(document.createElement('canvas'))
      drawCounter(
        context as unknown as CanvasRenderingContext2D,
        { ...base, ...counter },
        count,
        [120, 143]
      )
      return context
    }
    const names = (context: FakeContext): string[] =>
      context.calls.map(([name]) => name).filter((name) => name !== 'measureText')

    // Plain: text only, even with an outline configured at no width.
    const plain = draw({ style: 'plain', color: '#b00068', outline: { color: '#000', width: 0 } })
    expect(call(plain, 'translate')).toEqual([[120, 143]])
    expect(call(plain, 'rotate')).toEqual([[0.04]])
    expect(call(plain, 'transform')).toEqual([[1, 0, -0.07, 1, 0, 0]])
    expect(names(plain)).toEqual(['translate', 'rotate', 'transform', 'fillText'])
    expect(call(plain, 'fillText')).toEqual([['42', 0, 0]])
    expect(plain.fillStyle).toBe('#b00068')

    // Print: the digits are multiplied into the fabric, the outline is ignored and the blend
    // mode is put back afterwards.
    const print = draw({ style: 'print', color: '#b00068' })
    expect(names(print)).toEqual(['translate', 'rotate', 'transform', 'fillText'])
    expect(print.draws).toEqual([])
    expect(print.globalCompositeOperation).toBe('source-over')

    // Patch: a rimmed circle of the badge's diameter under the digits (no outline on them).
    const patch = draw({
      style: 'patch',
      color: '#b00068',
      outline: undefined,
      badge: { fill: '#fff', rim: '#b00068', rimWidth: 2, size: 34 }
    })
    expect(names(patch)).toEqual([
      'translate',
      'rotate',
      'transform',
      'beginPath',
      'arc',
      'fill',
      'stroke',
      'fillText'
    ])
    expect(call(patch, 'arc')).toEqual([[0, 0, 17, 0, Math.PI * 2]])
    expect(patch.strokeStyle).toBe('#b00068')
    expect(patch.lineWidth).toBe(2)
    expect(patch.fillStyle).toBe('#b00068')

    // Bib: a rounded tag as wide as the digits plus padding and as tall as the badge; no rim at 0.
    const bib = draw({
      style: 'bib',
      color: '#b00068',
      outline: undefined,
      badge: { fill: '#fff', rim: '#b00068', rimWidth: 0, size: 28 }
    })
    // The fake measures 10 px per character; the padding is 0.3 x 28 on each side.
    const [[left, top, width, height, radius]] = call(bib, 'roundRect') as number[][]
    expect([left, top, width, height]).toEqual([-18.4, -14, 36.8, 28])
    expect(radius).toBeCloseTo(5.6, 10)
    expect(call(bib, 'stroke')).toEqual([])
    expect(call(bib, 'fillText')).toEqual([['42', 0, 0]])

    // A badge style without a badge falls back to the digits alone, still outlined.
    expect(names(draw({ style: 'patch', badge: undefined }))).toEqual([
      'translate',
      'rotate',
      'transform',
      'strokeText',
      'fillText'
    ])
  })

  it('sits at zero sessions and for questions, and runs from one session on a stable stage', async () => {
    const { container, rerender } = render(sprite(0))
    expect(container.querySelector('.pet-atlas')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('bella-sitting')
    // The stage is as wide as the flame stage at every count, so Bella never shifts.
    expect(container.querySelector('.pet-hit-target')).toHaveStyle({
      width: '168px',
      height: '132px'
    })
    expect(container.querySelector('.pet-stage')).toHaveStyle({ width: '132px', height: '96px' })

    rerender(sprite(1))
    expect(screen.getByTestId('pet-atlas-working')).toHaveAttribute('data-variant', '0')
    expect(atlasOf(container)).toContain('bella-run-1')
    expect(container.querySelector('.pet-lottie-fallback')).toHaveAttribute('data-hidden', 'false')
    expect(container.querySelector('.pet-sprite')).toHaveAttribute('data-shadow', 'none')
    await settle()
    expect(container.querySelector('.pet-lottie-fallback')).toHaveAttribute('data-hidden', 'true')
    expect(screen.getByTestId('pet-atlas-working')).toHaveAttribute('data-ready', 'true')
    expect(screen.getByTestId('pet-atlas-canvas')).toHaveStyle({ width: '96px', height: '96px' })

    for (const [count, level, variant] of [
      [2, 4, 1],
      [3, 4, 1],
      [4, 6, 2],
      [5, 6, 2],
      [6, 10, 3],
      [9, 10, 3],
      [10, 14, 4],
      [14, 14, 4],
      [15, 21, 5],
      [999, 21, 5]
    ] as Array<[number, number, number]>) {
      rerender(sprite(count))
      expect(atlasOf(container)).toContain(`bella-run-${level}`)
      expect(screen.getByTestId('pet-atlas-working')).toHaveAttribute(
        'data-variant',
        String(variant)
      )
    }
    await settle()
    // The flame stage keeps the box's height and extends left of it.
    expect(screen.getByTestId('pet-atlas-canvas')).toHaveStyle({ width: '132px', height: '96px' })
    advance(16)
    const canvas = screen.getByTestId('pet-atlas-canvas') as HTMLCanvasElement
    expect([canvas.width, canvas.height]).toEqual([132, 96])
    expect(drawSpy).toHaveBeenLastCalledWith(
      canvas,
      expect.objectContaining({ src: expect.stringContaining('bella-run-21') }),
      expect.objectContaining({ minSessions: 15 }),
      999,
      0
    )

    rerender(sprite(0, 'idle'))
    expect(container.querySelector('.pet-atlas')).toBeNull()
    expect(container.querySelector('.pet-sprite')).not.toHaveAttribute('data-shadow')
    expect(container.querySelector('.pet-hit-target')).toHaveStyle({ width: '168px' })
    expect(container.querySelector('img')?.getAttribute('src')).toContain('bella-sitting')

    // A question takes precedence over running sessions and keeps the question indicator.
    rerender(sprite(4, 'question'))
    expect(container.querySelector('.pet-atlas')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('bella-sitting')
    expect(container.querySelector('.pet-bubble-question')).toHaveTextContent('?')

    rerender(sprite(4))
    expect(atlasOf(container)).toContain('bella-run-6')
    expect(container.querySelector('.pet-bubble-question')).toBeNull()
    await settle()
  })

  it('keeps one continuous clock across styles, scales it with speed and holds it when paused', async () => {
    const pet = getPet('bella')
    const atlas = pet.workingAtlas!
    const atlases = pet.resolvedWorkingAtlasVariants!
    const stage = (
      index: number,
      count: number,
      speed: number,
      paused = false
    ): React.JSX.Element => (
      <CanvasAtlasSprite
        atlas={atlas}
        variant={atlas.variants[index]}
        src={atlases[index]}
        fallbackSrc={pet.resolvedAssets.idle}
        variantIndex={index}
        count={count}
        size={96}
        speed={speed}
        paused={paused}
        state="working"
      />
    )
    const timeOf = (): number => drawSpy.mock.lastCall?.[4] as number

    const { rerender } = render(stage(2, 4, 2))
    await settle()
    advance(1000)
    expect(timeOf()).toBe(0)
    advance(1010)
    expect(timeOf()).toBe(20)

    // A new outfit joins mid-stride once decoded; the clock carries on from where it was.
    rerender(stage(3, 6, 2))
    await settle()
    advance(1020)
    expect(drawSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ src: expect.stringContaining('bella-run-10') }),
      expect.objectContaining({ minSessions: 6 }),
      6,
      20
    )
    advance(1030)
    expect(timeOf()).toBe(40)

    // Paused: the pose stays and nothing is redrawn until something changes.
    rerender(stage(3, 6, 2, true))
    const drawsBefore = drawSpy.mock.calls.length
    advance(1040)
    advance(1050)
    expect(drawSpy.mock.calls.length).toBe(drawsBefore)
    rerender(stage(3, 11, 2, true))
    advance(1060)
    expect(drawSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      11,
      40
    )

    // Resumed after a long gap, the clock steps by at most 100 ms of real time.
    rerender(stage(3, 11, 2))
    advance(5000)
    expect(timeOf()).toBe(240)
  })

  it('holds the run when the system prefers reduced motion', async () => {
    const matchMedia = window.matchMedia
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia
    try {
      render(sprite(6))
      await settle()
      advance(100)
      advance(200)
      advance(300)
      expect(drawSpy).toHaveBeenCalledTimes(1)
      expect(drawSpy.mock.lastCall?.[4]).toBe(0)
    } finally {
      window.matchMedia = matchMedia
    }
  })
})
