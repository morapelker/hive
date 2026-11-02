import type { PetManifest } from '@shared/types/pet'

export type WorkingVariantSource = Pick<
  PetManifest,
  'workingLottieVariants' | 'workingLottieVariantSessions'
>

/**
 * The session-count styles of a pet, whether they are Lottie files or sprite-sheet atlases.
 * Pets with neither have no styles, so `workingVariantIndex` always returns 0 for them.
 */
export function workingVariantSource(
  pet: Pick<
    PetManifest,
    'workingLottieVariants' | 'workingLottieVariantSessions' | 'workingSpriteSheet'
  >
): WorkingVariantSource {
  if (pet.workingSpriteSheet) {
    return {
      workingLottieVariants: pet.workingSpriteSheet.variants,
      workingLottieVariantSessions: pet.workingSpriteSheet.variantSessions
    }
  }
  return {
    workingLottieVariants: pet.workingLottieVariants,
    workingLottieVariantSessions: pet.workingLottieVariantSessions
  }
}

/**
 * Index into `workingLottieVariants` for a session count: the last style whose minimum the count
 * reaches. Counts below the first minimum (and 0) use the first style; nothing is ever skipped.
 */
export function workingVariantIndex(
  pet: WorkingVariantSource & Pick<PetManifest, 'workingSpriteSheet'>,
  workingSessionCount: number
): number {
  const source = workingVariantSource(pet)
  const variants = source.workingLottieVariants ?? []
  const count = Number.isFinite(workingSessionCount) ? Math.floor(workingSessionCount) : 1
  let result = 0
  for (let index = 0; index < variants.length; index++) {
    const minimum = source.workingLottieVariantSessions?.[index] ?? index + 1
    if (count >= minimum) result = index
  }
  return result
}
