import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { DotLottie, type TextSlotValue } from '@lottiefiles/dotlottie-web'
import dotLottieWasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url'

DotLottie.setWasmUrl(dotLottieWasmUrl)

function applyTextSlots(
  player: DotLottie,
  slots?: Record<string, TextSlotValue>,
  previous?: Record<string, TextSlotValue>
): void {
  for (const id of Object.keys(previous ?? {})) {
    if (!slots?.[id]) player.resetSlot(id)
  }
  for (const [id, value] of Object.entries(slots ?? {})) {
    // Reapplying an unchanged text slot can restore its default glyphs in the
    // WASM renderer. Settings changes must not overwrite a live cape count.
    if (JSON.stringify(value) !== JSON.stringify(previous?.[id])) player.setTextSlot(id, value)
  }
}

async function loadDotLottieData(src: string): Promise<ArrayBuffer> {
  const response = await fetch(src)
  if (!response.ok) {
    throw new Error(`Failed to load dotLottie asset: ${response.status}`)
  }

  return response.arrayBuffer()
}

function canvasHasVisiblePixels(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || canvas.width <= 0 || canvas.height <= 0) return false

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  for (let index = 3; index < pixels.length; index += 16) {
    if (pixels[index] > 0) return true
  }

  return false
}

export function DotLottieSprite({
  src,
  fallbackSrc,
  scale,
  size,
  speed = 1,
  textSlots,
  state
}: {
  src: string
  fallbackSrc: string
  scale: number
  size: number
  speed?: number
  textSlots?: Record<string, TextSlotValue>
  state: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<DotLottie | null>(null)
  const speedRef = useRef(speed)
  const textSlotsRef = useRef(textSlots)
  const appliedTextSlotsRef = useRef<Record<string, TextSlotValue> | undefined>(undefined)
  const [hasRendered, setHasRendered] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let player: DotLottie | null = null
    setHasRendered(false)

    void loadDotLottieData(src)
      .then((data) => {
        if (cancelled || !canvasRef.current) return

        // The player boots its WASM core asynchronously and `setSpeed` is a
        // silent no-op until that core exists, so the speed has to be part of
        // the constructor config. It is re-applied on `load` as well, in case
        // the session count changed while the core was still initialising.
        player = new DotLottie({
          canvas,
          data,
          autoplay: true,
          loop: true,
          speed: speedRef.current,
          layout: {
            fit: 'contain',
            align: [0.5, 0.5]
          },
          renderConfig: {
            autoResize: true,
            freezeOnOffscreen: false
          }
        })
        playerRef.current = player

        player.addEventListener('load', () => {
          if (!cancelled && player) {
            player.setSpeed(speedRef.current)
            applyTextSlots(player, textSlotsRef.current, appliedTextSlotsRef.current)
            appliedTextSlotsRef.current = textSlotsRef.current
          }
        })

        player.addEventListener('render', () => {
          requestAnimationFrame(() => {
            if (!cancelled && canvasHasVisiblePixels(canvas)) {
              setHasRendered(true)
            }
          })
        })
      })
      .catch((error: unknown) => {
        console.error('Failed to render pet Lottie animation', error)
      })

    return () => {
      cancelled = true
      playerRef.current = null
      appliedTextSlotsRef.current = undefined
      player?.destroy()
    }
  }, [src])

  useEffect(() => {
    speedRef.current = speed
    playerRef.current?.setSpeed(speed)
  }, [speed])

  useEffect(() => {
    textSlotsRef.current = textSlots
    const player = playerRef.current
    if (!player?.isLoaded) return

    // Changing a number keeps the current player and run-cycle frame alive.
    applyTextSlots(player, textSlots, appliedTextSlotsRef.current)
    appliedTextSlotsRef.current = textSlots
  }, [textSlots])

  return (
    <span className="pet-lottie-stage">
      <img
        className="pet-lottie-fallback"
        src={fallbackSrc}
        alt=""
        draggable={false}
        aria-hidden="true"
        data-hidden={hasRendered ? 'true' : 'false'}
      />
      <canvas
        ref={canvasRef}
        className="pet-lottie-canvas"
        style={{ '--pet-lottie-scale': scale } as React.CSSProperties}
        width={size}
        height={size}
        data-testid={`pet-lottie-${state}`}
        aria-hidden="true"
      />
    </span>
  )
}
