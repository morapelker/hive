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

export interface LoadedPet extends PetManifest {
  resolvedAssets: Record<PetState, string>
  resolvedLottieAssets?: Partial<Record<PetState, string>>
  resolvedWorkingLottieVariants?: string[]
  resolvedWorkingSpriteSheetVariants?: string[]
}

export interface PetPosition {
  x: number
  y: number
}
