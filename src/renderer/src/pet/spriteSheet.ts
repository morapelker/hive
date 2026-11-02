import type { PetSpriteSheet } from '@shared/types/pet'

/** Badge and sparkle coordinates are authored in a 400-unit square, like the design's SVG exports. */
export const DESIGN_BOX = 400
const STEP = 'steps(1,end)'

/** Badge centers for every frame: the key poses interpolated linearly, wrapping at the loop seam. */
export function badgeFrames(anchors: number[][], frames: number): number[][] {
  const poses = anchors.length
  return Array.from({ length: frames }, (_, frame) => {
    const phase = (frame * poses) / frames
    const index = Math.floor(phase)
    const t = phase - index
    const from = anchors[index]
    const to = anchors[(index + 1) % poses]
    return from.map((coordinate, axis) => coordinate * (1 - t) + to[axis] * t)
  })
}

/** Longer counts shrink to fit the badge; the number itself is never capped or abbreviated. */
export function badgeFontSize(
  badge: Pick<NonNullable<PetSpriteSheet['badge']>, 'fontSize' | 'fullSizeDigits'>,
  count: number
): number {
  return badge.fontSize * Math.min(1, badge.fullSizeDigits / String(count).length)
}

/** Source-cell pixels to a percentage of the sprite box, with the design's two-decimal rounding. */
export function badgePercent(value: number, cellSize: number): number {
  return Number(((value * DESIGN_BOX) / cellSize).toFixed(2)) / (DESIGN_BOX / 100)
}

export function atlasKeyframes(
  sheet: Pick<PetSpriteSheet, 'frames' | 'columns' | 'rows'>
): Keyframe[] {
  return Array.from({ length: sheet.frames + 1 }, (_, index) => {
    const pose = index % sheet.frames
    const x = (-100 / sheet.columns) * (pose % sheet.columns)
    const y = (-100 / sheet.rows) * Math.floor(pose / sheet.columns)
    return { transform: `translate(${x}%,${y}%)`, offset: index / sheet.frames, easing: STEP }
  })
}

export function badgeKeyframes(anchors: number[][], frames: number, cellSize: number): Keyframe[] {
  const positions = badgeFrames(anchors, frames)
  return Array.from({ length: frames + 1 }, (_, index) => {
    const [x, y] = positions[index % frames]
    return {
      transform: `translate(${badgePercent(x, cellSize)}%,${badgePercent(y, cellSize)}%)`,
      offset: index / frames,
      easing: STEP
    }
  })
}

export function sparkleKeyframes(index: number): PropertyIndexedKeyframes {
  return { opacity: index % 2 ? [0.1, 0.8, 0.1] : [0.8, 0.1, 0.8] }
}
