export type PetState = 'idle' | 'working' | 'question' | 'permission' | 'plan_ready'
export type PetSize = 'S' | 'M' | 'L'

export interface PetSettings {
  enabled: boolean
  petId: string
  size: PetSize
  opacity: number
  animationSpeedEnabled: boolean
  animationSpeed: number
  hasHatched: boolean
}

export interface PetStatusPayload {
  state: PetState
  sourceWorktreeId: string | null
  workingSessionCount: number
}

export interface PetManifest {
  id: string
  name: string
  version: string
  author?: string
  assets: Record<PetState, string>
  lottieAssets?: Partial<Record<PetState, string>>
  /**
   * Working animations by active session count, capped at the last variant; independent of playback speed.
   * Entry i applies from `workingLottieVariantSessions[i]` sessions (default: i + 1).
   */
  workingLottieVariants?: string[]
  /** Ascending minimum session count per entry of `workingLottieVariants`; omitted entries default to their 1-based index. */
  workingLottieVariantSessions?: number[]
  /** Editable Lottie text slot showing the actual count, including beyond the last style. */
  workingSessionCounter?: {
    slotId: string
    minSessions: number
    fontSize: number
    /** Longer counts shrink to fit; this does not cap the displayed number. */
    fullSizeDigits: number
  }
  /**
   * Working run cycle drawn from sprite-sheet atlases instead of Lottie. Styles are chosen by
   * session count with the same rules as `workingLottieVariants`; see `workingVariantSource()`.
   */
  workingSpriteSheet?: PetSpriteSheet
  /**
   * Working run cycle drawn on a canvas from lossless atlases with fractional-frame blending.
   * Styles are chosen by session count with the same rules as `workingLottieVariants`.
   */
  workingAtlas?: PetCanvasAtlas
  /**
   * Width of the working stage as a multiple of the pet box, for a run cycle whose last style
   * extends past the box (a flame trail). The box keeps its right edge and the extra width
   * is on the left; defaults to 1.
   */
  stageWidthRatio?: number
  lottieScale?: Partial<Record<PetState, number>>
  imageScale?: Partial<Record<PetState, number>>
  animations?: Partial<
    Record<
      PetState,
      {
        type: 'loop' | 'static'
        durationMs?: number
        transform?: 'spin' | 'bounce' | 'pulse' | 'none'
        overlay?: { kind: 'bubble' | 'glow' | 'none'; symbol?: string; tint?: string }
      }
    >
  >
  defaultSize?: PetSize
}

/** A grid of equally sized run-cycle poses, read left to right and top to bottom. */
export interface PetSpriteSheet {
  /** Atlas per style, in ascending session-count order. Entries may repeat an atlas. */
  variants: string[]
  /** Ascending minimum session count per entry of `variants`; omitted entries default to their 1-based index. */
  variantSessions?: number[]
  frames: number
  columns: number
  rows: number
  /** One full run cycle, independent of playback speed. */
  cycleMs: number
  /** Fraction of the sprite box left empty on each side, so decorations can sit on the edge. */
  inset?: number
  /**
   * Draw the overlay's drop shadow under the run cycle; defaults to true. False for a sprite that
   * fills its box, where the shadow reads as a dark blob behind the paws on a light desktop.
   */
  shadow?: boolean
  /** A count badge that follows the fabric through the run cycle. */
  badge?: {
    /** Below this count the badge shows the emblem instead of the number. */
    minSessions: number
    /** Source pixel size of one atlas cell, the unit of `anchors`. */
    cellSize: number
    /** Font size in a 400-unit box at `fullSizeDigits`; longer counts shrink to fit and are never capped. */
    fontSize: number
    fullSizeDigits: number
    fontFamily: string
    /** CSS font weight of the count; defaults to 700. */
    fontWeight?: number
    color: string
    /** Badge rotation in degrees. */
    rotate: number
    /** Shown below `minSessions` on outfits that have anchors; without one the badge stays blank. */
    emblem?: 'paw'
    emblemColor?: string
    /** Badge center per variant, sampled at evenly spaced key poses; null for outfits without a badge. */
    anchors: Array<number[][] | null>
  }
  /** Twinkling accents in a 400-unit box, shown from `minSessions` onward. */
  sparkles?: {
    minSessions: number
    color: string
    /** Color per variant, overriding `color`; null or a missing entry keeps the default. */
    variantColors?: Array<string | null>
    /** Sparkle centers. */
    positions: number[][]
    /** `star` has straight edges (default); `glint` has concave, curved sides. */
    shape?: 'star' | 'glint'
    /** Width and height of one sparkle as a fraction of the sprite box; defaults to 0.025. */
    size?: number
    /** Dimmest and brightest opacity of the twinkle; defaults to 0.1 and 0.8. */
    opacity?: [number, number]
  }
}

/**
 * A lossless run-cycle atlas per style, drawn on a canvas: neighbouring frames are blended by
 * the fractional frame (the last frame into the first), and the live session count is printed
 * on the outfit at a per-frame anchor.
 */
export interface PetCanvasAtlas {
  frames: number
  columns: number
  rows: number
  /** One full run cycle at normal speed, independent of playback speed. */
  cycleMs: number
  /** Source pixel height of one cell; every style shares it. */
  cellHeight: number
  /** Draw the overlay's drop shadow under the run cycle; defaults to true. */
  shadow?: boolean
  /** Styles in ascending `minSessions` order; the last one the count reaches is drawn. */
  variants: PetCanvasAtlasVariant[]
  /** The live session count printed on the outfit from `minSessions` onward. */
  counter?: PetCanvasAtlasCounter
}

export interface PetCanvasAtlasVariant {
  minSessions: number
  file: string
  /** Source pixel width of one cell; a cell wider than it is tall extends the stage left of the box. */
  cellWidth: number
  cellHeight: number
  /** Counter centre per frame in cell pixels, interpolated like the frames; null for styles without it. */
  counterAnchors: number[][] | null
}

/**
 * How the count sits on the outfit. `print` is ink multiplied into the fabric so its folds show
 * through; `jersey` is a filled digit with an outline; `patch` is a round badge and `bib` a
 * pinned tag, both carrying the digit; `plain` is bare text.
 */
export type PetCanvasAtlasCounterStyle = 'plain' | 'print' | 'jersey' | 'patch' | 'bib'

export interface PetCanvasAtlasCounter {
  minSessions: number
  /** Defaults to `plain`. */
  style?: PetCanvasAtlasCounterStyle
  color: string
  /** Outline around each digit (cell pixels); `print` ignores it. */
  outline?: { color: string; width: number }
  /** The shape under the digits for `patch` (diameter `size`) and `bib` (height `size`). */
  badge?: { fill: string; rim: string; rimWidth: number; size: number }
  fontFamily: string
  fontWeight: number
  /** Font size in cell pixels by digit count ("1", "2", "3"); longer counts use the last size. */
  fontSizes: Record<string, number>
  rotationRadians: number
  /** Horizontal skew factor applied after the rotation. */
  skewX: number
}

export interface LoadedPet extends PetManifest {
  resolvedAssets: Record<PetState, string>
  resolvedLottieAssets?: Partial<Record<PetState, string>>
  resolvedWorkingLottieVariants?: string[]
  resolvedWorkingSpriteSheetVariants?: string[]
  resolvedWorkingAtlasVariants?: string[]
}

export interface PetPosition {
  x: number
  y: number
}
