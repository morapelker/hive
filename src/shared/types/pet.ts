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

export interface LoadedPet extends PetManifest {
  resolvedAssets: Record<PetState, string>
  resolvedLottieAssets?: Partial<Record<PetState, string>>
  resolvedWorkingLottieVariants?: string[]
}

export interface PetPosition {
  x: number
  y: number
}
