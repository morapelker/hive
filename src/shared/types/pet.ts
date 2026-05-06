export type PetState = 'idle' | 'working' | 'question' | 'permission' | 'plan_ready'
export type PetSize = 'S' | 'M' | 'L'

export interface PetSettings {
  enabled: boolean
  petId: string
  size: PetSize
  opacity: number
  hasHatched: boolean
}

export interface PetStatusPayload {
  state: PetState
  sourceWorktreeId: string | null
}

export interface PetManifest {
  id: string
  name: string
  version: string
  author?: string
  assets: Record<PetState, string>
  lottieAssets?: Partial<Record<PetState, string>>
  lottieScale?: Partial<Record<PetState, number>>
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
}

export interface PetPosition {
  x: number
  y: number
}
