import type { LoadedPet, PetManifest, PetState } from '@shared/types/pet'

const manifestModules = import.meta.glob('./*/manifest.json', {
  eager: true,
  import: 'default'
}) as Record<string, PetManifest>

const assetModules = import.meta.glob('./*/assets/*', {
  eager: true,
  import: 'default',
  query: '?url'
}) as Record<string, string>

const pets = new Map<string, LoadedPet>()

for (const [manifestPath, manifest] of Object.entries(manifestModules)) {
  const baseDir = manifestPath.replace(/\/manifest\.json$/, '')
  const resolvedAssets = {} as Record<PetState, string>
  const resolvedLottieAssets: Partial<Record<PetState, string>> = {}

  for (const [state, relativePath] of Object.entries(manifest.assets) as Array<
    [PetState, string]
  >) {
    const assetPath = `${baseDir}/${relativePath}`
    resolvedAssets[state] = assetModules[assetPath] ?? relativePath
  }

  for (const [state, relativePath] of Object.entries(manifest.lottieAssets ?? {}) as Array<
    [PetState, string]
  >) {
    const assetPath = `${baseDir}/${relativePath}`
    resolvedLottieAssets[state] = assetModules[assetPath] ?? relativePath
  }

  pets.set(manifest.id, {
    ...manifest,
    resolvedAssets,
    resolvedLottieAssets: Object.keys(resolvedLottieAssets).length
      ? resolvedLottieAssets
      : undefined
  })
}

export function listPets(): LoadedPet[] {
  return Array.from(pets.values())
}

export function getPet(id: string): LoadedPet {
  return pets.get(id) ?? pets.get('bee') ?? listPets()[0]
}
