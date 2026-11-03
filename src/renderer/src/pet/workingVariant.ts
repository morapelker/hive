import type { PetManifest } from '@shared/types/pet'

export type WorkingVariantSource = Pick<
  PetManifest,
  'workingLottieVariants' | 'workingLottieVariantSessions'
>

type WorkingVariantPet = Pick<
  PetManifest,
  'workingLottieVariants' | 'workingLottieVariantSessions' | 'workingSpriteSheet' | 'workingAtlas'
>

/**
 * The session-count styles of a pet, whether they are Lottie files, sprite-sheet atlases or
 * canvas atlases. Pets with none have no styles, so `workingVariantIndex` always returns 0.
 */
export function workingVariantSource(pet: WorkingVariantPet): WorkingVariantSource {
  if (pet.workingAtlas) {
    return {
      workingLottieVariants: pet.workingAtlas.variants.map((variant) => variant.file),
      workingLottieVariantSessions: pet.workingAtlas.variants.map((variant) => variant.minSessions)
    }
  }
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
export function workingVariantIndex(pet: WorkingVariantPet, workingSessionCount: number): number {
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
