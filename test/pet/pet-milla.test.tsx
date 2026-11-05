import { act, render, screen } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSettings, PetState } from '@shared/types/pet'
import { getPet, listPets } from '@/pet/registry'
import { PetSprite } from '@/pet/PetSprite'
import { atlasStageWidth, createAtlasRenderer } from '@/pet/atlasCanvas'
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
  petId: 'milla',
  size: 'M',
  opacity: 1,
  animationSpeedEnabled: false,
  animationSpeed: 5,
  hasHatched: true
}

type FakeContext = {
  calls: Array<[string, unknown[]]>
  font: string
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  globalCompositeOperation: string
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
    drawImage: record('drawImage')
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

function sprite(count: number, state: PetState = 'working'): React.JSX.Element {
  return (
    <PetSprite
      pet={getPet('milla')}
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

describe('Milla the Swimmer canvas-atlas pet', () => {
  beforeEach(() => {
    frames = []
    drawSpy.mockClear()
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return fakeContext(this)
    } as unknown as typeof HTMLCanvasElement.prototype.getContext
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

  it("registers Milla with Bella's dimensions, timing and kit number, and five swim stages", () => {
    const pet = getPet('milla')
    expect(pet.name).toBe('Milla the Swimmer')
    expect(listPets().map((entry) => entry.id)).toContain('milla')
    // The sitting portrait stands in for every state that is not a run.
    for (const state of ['idle', 'working', 'question', 'permission', 'plan_ready'] as const) {
      expect(pet.resolvedAssets[state]).toContain('milla-sitting')
    }
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
    // Run, goggles, swimsuit, cap, then the gold medal with the splash pool.
    expect(atlas.variants.map((variant) => variant.minSessions)).toEqual([1, 2, 4, 6, 10])
    expect(atlas.variants.every((variant) => variant.cellWidth === 256)).toBe(true)
    expect(atlas.variants.every((variant) => variant.cellHeight === 256)).toBe(true)
    for (const [index, level] of [1, 2, 4, 6, 10].entries()) {
      expect(atlas.variants[index].file).toBe(`assets/milla-run-${level}.webp`)
      expect(pet.resolvedWorkingAtlasVariants?.[index]).toContain(`milla-run-${level}`)
    }
    // The count rides on the swimsuit from four sessions; the fur is identical from stage to
    // stage, so every stage with a swimsuit shares one anchor track inside the cell.
    expect(atlas.variants.slice(0, 2).map((variant) => variant.counterAnchors)).toEqual([
      null,
      null
    ])
    const [swimsuit, ...later] = atlas.variants.slice(2)
    expect(swimsuit.counterAnchors).toHaveLength(128)
    for (const [x, y] of swimsuit.counterAnchors!) {
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(256)
      expect(y).toBeGreaterThan(0)
      expect(y).toBeLessThan(256)
    }
    for (const variant of later) expect(variant.counterAnchors).toEqual(swimsuit.counterAnchors)
    // Bella's jersey number, magenta outline included, on the pink kit.
    expect(atlas.counter).toEqual(getPet('bella').workingAtlas!.counter)
    // The pool fits in the cell, so the stage and the window stay square.
    expect(pet.stageWidthRatio).toBeUndefined()
    expect([64, 96, 128].map((height) => atlasStageWidth(atlas.variants[4], height))).toEqual([
      64, 96, 128
    ])

    expect(workingVariantSource(pet).workingLottieVariants).toHaveLength(5)
    expect(
      [0, 1, 2, 3, 4, 5, 6, 9, 10, 14, 15, 999].map((count) => workingVariantIndex(pet, count))
    ).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4])
  })

  it('prints the count on the swimsuit from four sessions in the jersey style', () => {
    const atlas = getPet('milla').workingAtlas!
    const draw = createAtlasRenderer(atlas)
    const image = { kind: 'atlas' } as unknown as CanvasImageSource
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const context = fakeContext(canvas)

    draw(canvas, image, atlas.variants[4], 12, 0)
    const anchor = atlas.variants[4].counterAnchors![0]
    expect(call(context, 'translate').slice(-1)).toEqual([[anchor[0], anchor[1]]])
    expect(context.strokeStyle).toBe('#b00068')
    expect(context.lineWidth).toBe(3)
    expect(context.fillStyle).toBe('#ffffff')
    expect(context.font).toBe("700 30px ui-rounded, 'Arial Rounded MT Bold', system-ui, sans-serif")
    expect(call(context, 'fillText')).toEqual([['12', 0, 0]])

    // No count below four, and none on the stages before the swimsuit.
    context.calls = []
    draw(canvas, image, atlas.variants[2], 3, 0)
    draw(canvas, image, atlas.variants[1], 4, 0)
    expect(call(context, 'fillText')).toEqual([])
  })

  it('sits at zero sessions and in every waiting state, and runs from one session on', async () => {
    const { container, rerender } = render(sprite(0))
    expect(container.querySelector('.pet-atlas')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('milla-sitting')
    expect(container.querySelector('.pet-hit-target')).toHaveStyle({
      width: '132px',
      height: '132px'
    })
    expect(container.querySelector('.pet-stage')).toHaveStyle({ width: '96px', height: '96px' })

    rerender(sprite(1))
    expect(screen.getByTestId('pet-atlas-working')).toHaveAttribute('data-variant', '0')
    expect(atlasOf(container)).toContain('milla-run-1')
    expect(container.querySelector('.pet-sprite')).toHaveAttribute('data-shadow', 'none')
    await settle()
    expect(screen.getByTestId('pet-atlas-working')).toHaveAttribute('data-ready', 'true')
    expect(screen.getByTestId('pet-atlas-canvas')).toHaveStyle({ width: '96px', height: '96px' })

    for (const [count, level, variant] of [
      [2, 2, 1],
      [3, 2, 1],
      [4, 4, 2],
      [5, 4, 2],
      [6, 6, 3],
      [9, 6, 3],
      [10, 10, 4],
      [999, 10, 4]
    ] as Array<[number, number, number]>) {
      rerender(sprite(count))
      expect(atlasOf(container)).toContain(`milla-run-${level}`)
      expect(screen.getByTestId('pet-atlas-working')).toHaveAttribute(
        'data-variant',
        String(variant)
      )
    }
    await settle()
    advance(16)
    const canvas = screen.getByTestId('pet-atlas-canvas') as HTMLCanvasElement
    expect([canvas.width, canvas.height]).toEqual([96, 96])
    expect(drawSpy).toHaveBeenLastCalledWith(
      canvas,
      expect.objectContaining({ src: expect.stringContaining('milla-run-10') }),
      expect.objectContaining({ minSessions: 10 }),
      999,
      0
    )

    for (const [state, bubble] of [
      ['idle', null],
      ['question', '?'],
      ['permission', '!'],
      ['plan_ready', '✓']
    ] as Array<[PetState, string | null]>) {
      rerender(sprite(4, state))
      expect(container.querySelector('.pet-atlas')).toBeNull()
      expect(container.querySelector('img')?.getAttribute('src')).toContain('milla-sitting')
      if (bubble) expect(container.querySelector('.pet-bubble')).toHaveTextContent(bubble)
    }

    rerender(sprite(4))
    expect(atlasOf(container)).toContain('milla-run-4')
    await settle()
  })
})
