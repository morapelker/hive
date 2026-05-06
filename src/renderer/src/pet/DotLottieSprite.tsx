import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { DotLottie } from '@lottiefiles/dotlottie-web'
import dotLottieWasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url'

DotLottie.setWasmUrl(dotLottieWasmUrl)

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
  state
}: {
  src: string
  fallbackSrc: string
  scale: number
  size: number
  state: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
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

        player = new DotLottie({
          canvas,
          data,
          autoplay: true,
          loop: true,
          layout: {
            fit: 'contain',
            align: [0.5, 0.5]
          },
          renderConfig: {
            autoResize: true,
            freezeOnOffscreen: false
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
      player?.destroy()
    }
  }, [src])

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
