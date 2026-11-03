import { useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import type { PetCanvasAtlas, PetCanvasAtlasVariant } from '@shared/types/pet'
import { atlasStageWidth, createAtlasRenderer } from './atlasCanvas'
import { loadAtlasImage } from './atlasImage'

/** A frame later than this (a throttled window) advances the clock by this much, not the gap. */
const MAX_FRAME_STEP_MS = 100
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches ?? false
  )
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_MOTION_QUERY)
    if (!query?.addEventListener) return
    const update = (): void => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

interface ReadyAtlas {
  src: string
  image: HTMLImageElement
  variant: PetCanvasAtlasVariant
}

/**
 * Runs a canvas atlas through its cycle on one continuous clock: a style or count change never
 * restarts the run, and a new style keeps drawing the previous one until its atlas is decoded.
 * Speed scales the clock; `paused` and the system's reduced-motion preference hold it, leaving
 * the current pose, outfit and count on screen. The canvas keeps the box's height and takes the
 * style's cell aspect for its width, anchored to the box's right edge so a wider style extends
 * left. Its backing store follows `devicePixelRatio`.
 */
export function CanvasAtlasSprite({
  atlas,
  variant,
  src,
  fallbackSrc,
  variantIndex,
  count,
  size,
  speed = 1,
  paused = false,
  state
}: {
  atlas: PetCanvasAtlas
  variant: PetCanvasAtlasVariant
  src: string
  fallbackSrc: string
  variantIndex: number
  count: number
  /** Displayed height of the pet box in CSS pixels. */
  size: number
  speed?: number
  paused?: boolean
  state: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const draw = useMemo(() => createAtlasRenderer(atlas), [atlas])
  const clockRef = useRef(0)
  const liveRef = useRef({ count, speed, paused })
  const drawnRef = useRef<string | null>(null)
  const [ready, setReady] = useState<ReadyAtlas | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const hold = paused || reducedMotion

  useEffect(() => {
    liveRef.current = { count, speed, paused: hold }
  }, [count, speed, hold])

  useEffect(() => {
    let cancelled = false
    loadAtlasImage(src)
      .then((image) => {
        if (!cancelled) setReady({ src, image, variant })
      })
      .catch((error: unknown) => {
        console.error('Failed to load pet atlas', error)
      })
    return () => {
      cancelled = true
    }
  }, [src, variant])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!ready || !canvas) return
    // A new atlas, renderer or style must draw even while the clock is held.
    drawnRef.current = null
    let last: number | null = null
    let handle = 0

    const tick = (now: number): void => {
      const live = liveRef.current
      if (last !== null && !live.paused) {
        const step = Math.min(now - last, MAX_FRAME_STEP_MS) * live.speed
        clockRef.current = (clockRef.current + step) % atlas.cycleMs
      }
      last = now

      const ratio = window.devicePixelRatio || 1
      const width = Math.round(atlasStageWidth(ready.variant, size) * ratio)
      const height = Math.round(size * ratio)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
        drawnRef.current = null
      }

      const key = `${ready.src}|${live.count}|${clockRef.current}`
      if (drawnRef.current !== key) {
        draw(canvas, ready.image, ready.variant, live.count, clockRef.current)
        drawnRef.current = key
      }
      handle = requestAnimationFrame(tick)
    }

    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [atlas, draw, ready, size])

  const shown = ready?.variant ?? variant

  return (
    <span
      className="pet-atlas"
      data-testid={`pet-atlas-${state}`}
      data-variant={variantIndex}
      data-atlas={src}
      data-ready={ready?.src === src ? 'true' : 'false'}
    >
      <img
        className="pet-lottie-fallback"
        src={fallbackSrc}
        alt=""
        draggable={false}
        aria-hidden="true"
        data-hidden={ready ? 'true' : 'false'}
      />
      <canvas
        ref={canvasRef}
        className="pet-atlas-canvas"
        style={{ width: atlasStageWidth(shown, size), height: size }}
        data-testid="pet-atlas-canvas"
        aria-hidden="true"
      />
    </span>
  )
}
