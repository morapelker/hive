import type { PetManifest } from '@shared/types/pet'

/**
 * Index into `workingLottieVariants` for a session count: the last style whose minimum the count
 * reaches. Counts below the first minimum (and 0) use the first style; nothing is ever skipped.
 */
export function workingVariantIndex(
  pet: Pick<PetManifest, 'workingLottieVariants' | 'workingLottieVariantSessions'>,
  workingSessionCount: number
): number {
  const variants = pet.workingLottieVariants ?? []
  const count = Number.isFinite(workingSessionCount) ? Math.floor(workingSessionCount) : 1
  let result = 0
  for (let index = 0; index < variants.length; index++) {
    const minimum = pet.workingLottieVariantSessions?.[index] ?? index + 1
    if (count >= minimum) result = index
  }
  return result
}
