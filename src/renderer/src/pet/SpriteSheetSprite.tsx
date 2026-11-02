import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import type { PetSpriteSheet } from '@shared/types/pet'
import {
  DESIGN_BOX,
  atlasKeyframes,
  badgeFontSize,
  badgeFrames,
  badgeKeyframes,
  badgePercent,
  sparkleKeyframes
} from './spriteSheet'

/** Sparkle outlines in a 10-unit box centred on the origin. */
const SPARKLE_PATHS = {
  star: 'M0-5 1.5-1.5 5 0 1.5 1.5 0 5-1.5 1.5-5 0-1.5-1.5Z',
  glint: 'M0-5Q.833-.833 5 0Q.833.833 0 5Q-.833.833-5 0Q-.833-.833 0-5'
} as const
const SPARKLE_SIZE = 0.025

function PawEmblem({ color }: { color: string }): React.JSX.Element {
  return (
    <g fill={color}>
      <ellipse cx="-7" cy="-5" rx="3" ry="4" />
      <ellipse cx="1" cy="-8" rx="3" ry="4" />
      <ellipse cx="8" cy="-4" rx="3" ry="4" />
      <path d="M-8 6Q-8 0 0-2Q8 0 9 6Q7 11 0 8Q-6 11-8 6" />
    </g>
  )
}

/**
 * Runs a sprite-sheet atlas through its poses with compositor-only transforms: the atlas
 * steps through its grid, a badge follows the fabric, and sparkles twinkle, all on one shared
 * clock. Nothing runs per frame in JavaScript. Count changes that keep the same atlas update
 * the badge text in place, so the run cycle never restarts.
 */
export function SpriteSheetSprite({
  sheet,
  src,
  fallbackSrc,
  variantIndex,
  count,
  speed = 1,
  state
}: {
  sheet: PetSpriteSheet
  src: string
  fallbackSrc: string
  variantIndex: number
  count: number
  speed?: number
  state: string
}): React.JSX.Element {
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const animationsRef = useRef<Animation[]>([])
  const phaseRef = useRef(0)
  const speedRef = useRef(speed)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)

  const badge = sheet.badge
  const showNumber = badge !== undefined && count >= badge.minSessions
  // Without an emblem there is nothing to show below the count threshold, so the badge is left out.
  const anchors =
    badge && (showNumber || badge.emblem) ? (badge.anchors[variantIndex] ?? null) : null
  const anchorsKey = JSON.stringify(anchors)
  const sparkles = sheet.sparkles && count >= sheet.sparkles.minSessions ? sheet.sparkles : null
  const sparkleColor = sparkles?.variantColors?.[variantIndex] ?? sparkles?.color
  const sparkleSize = sheet.sparkles?.size ?? SPARKLE_SIZE
  const inset = `${(sheet.inset ?? 0) * 100}%`
  const { frames, columns, rows, cycleMs } = sheet
  const cellSize = badge?.cellSize ?? DESIGN_BOX

  useEffect(() => {
    const root = rootRef.current
    const atlas = root?.querySelector<HTMLElement>('.pet-sheet-atlas')
    if (!root || !atlas || typeof atlas.animate !== 'function') return

    const timing: KeyframeAnimationOptions = { duration: cycleMs, iterations: Infinity }
    const animations = [atlas.animate(atlasKeyframes({ frames, columns, rows }), timing)]
    const badgeLayer = root.querySelector<HTMLElement>('.pet-sheet-badge')
    if (badgeLayer && anchors) {
      animations.push(badgeLayer.animate(badgeKeyframes(anchors, frames, cellSize), timing))
    }
    root.querySelectorAll<HTMLElement>('.pet-sheet-sparkle').forEach((sparkle, index) => {
      animations.push(sparkle.animate(sparkleKeyframes(index, sparkles?.opacity), timing))
    })

    // A new outfit joins the run mid-stride instead of snapping back to the first pose.
    const phase = phaseRef.current % cycleMs
    for (const animation of animations) {
      animation.playbackRate = speedRef.current
      animation.currentTime = phase
    }
    animationsRef.current = animations

    return () => {
      const current = Number(animations[0]?.currentTime ?? 0)
      phaseRef.current = Number.isFinite(current) ? current : 0
      for (const animation of animations) animation.cancel()
      animationsRef.current = []
    }
    // `anchorsKey` stands in for the anchors array, which the manifest keeps stable by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, frames, columns, rows, cycleMs, cellSize, anchorsKey, sparkles])

  useEffect(() => {
    speedRef.current = speed
    for (const animation of animationsRef.current) animation.playbackRate = speed
  }, [speed])

  const firstBadgePosition = anchors ? badgeFrames(anchors, frames)[0] : null

  return (
    <span
      ref={rootRef}
      className="pet-sheet"
      style={
        {
          '--pet-sheet-inset': inset,
          '--pet-sheet-columns': columns,
          '--pet-sheet-rows': rows,
          '--pet-sheet-sparkle-size': `${sparkleSize * 100}%`
        } as React.CSSProperties
      }
      data-testid={`pet-sheet-${state}`}
      data-variant={variantIndex}
    >
      <img
        className="pet-lottie-fallback"
        src={fallbackSrc}
        alt=""
        draggable={false}
        aria-hidden="true"
        data-hidden={loadedSrc === src ? 'true' : 'false'}
      />
      <span className="pet-sheet-crop">
        <img
          className="pet-sheet-atlas"
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          aria-hidden="true"
          onLoad={() => setLoadedSrc(src)}
        />
      </span>
      <span className="pet-sheet-effects" aria-hidden="true">
        {badge && anchors && firstBadgePosition && (
          <span
            className="pet-sheet-badge"
            style={{
              transform: `translate(${badgePercent(firstBadgePosition[0], cellSize)}%,${badgePercent(firstBadgePosition[1], cellSize)}%)`
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${DESIGN_BOX} ${DESIGN_BOX}`}>
              <g transform={`rotate(${badge.rotate})`}>
                {showNumber ? (
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill={badge.color}
                    fontFamily={badge.fontFamily}
                    fontWeight={badge.fontWeight ?? 700}
                    fontSize={badgeFontSize(badge, count)}
                    data-testid="pet-sheet-count"
                  >
                    {count}
                  </text>
                ) : (
                  <PawEmblem color={badge.emblemColor ?? badge.color} />
                )}
              </g>
            </svg>
          </span>
        )}
        {sparkles?.positions.map(([x, y], index) => {
          // Positions are sparkle centres; the box is offset by half a sparkle, in design units.
          const half = (sparkleSize * DESIGN_BOX) / 2
          return (
            <span
              key={index}
              className="pet-sheet-sparkle"
              style={{ left: `${(x - half) / 4}%`, top: `${(y - half) / 4}%` }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="-5 -5 10 10">
                <path d={SPARKLE_PATHS[sparkles.shape ?? 'star']} fill={sparkleColor} />
              </svg>
            </span>
          )
        })}
      </span>
    </span>
  )
}
