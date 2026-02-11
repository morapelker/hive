import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const settingsStorePath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'stores',
  'useSettingsStore.ts'
)

const modelSelectorPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions',
  'ModelSelector.tsx'
)

function readSettingsStore(): string {
  return fs.readFileSync(settingsStorePath, 'utf-8')
}

function readModelSelector(): string {
  return fs.readFileSync(modelSelectorPath, 'utf-8')
}

describe('Session 9: Favorite Models', () => {
  describe('useSettingsStore - favoriteModels', () => {
    test('AppSettings interface includes favoriteModels field', () => {
      const content = readSettingsStore()
      expect(content).toContain('favoriteModels: string[]')
    })

    test('DEFAULT_SETTINGS includes favoriteModels as empty array', () => {
      const content = readSettingsStore()
      expect(content).toContain('favoriteModels: []')
    })

    test('toggleFavoriteModel action is defined in SettingsState', () => {
      const content = readSettingsStore()
      expect(content).toContain(
        'toggleFavoriteModel: (providerID: string, modelID: string) => void'
      )
    })

    test('toggleFavoriteModel creates key with providerID::modelID format', () => {
      const content = readSettingsStore()
      expect(content).toContain('`${providerID}::${modelID}`')
    })

    test('toggleFavoriteModel adds model when not in favorites', () => {
      const content = readSettingsStore()
      // Should spread current and add key
      expect(content).toContain('[...current, key]')
    })

    test('toggleFavoriteModel removes model when already in favorites', () => {
      const content = readSettingsStore()
      // Should filter out the key
      expect(content).toContain('current.filter((k) => k !== key)')
    })

    test('extractSettings includes favoriteModels', () => {
      const content = readSettingsStore()
      const lines = content.split('\n')
      const extractIdx = lines.findIndex((l) => l.includes('function extractSettings'))
      expect(extractIdx).toBeGreaterThan(0)
      // Find the return block of extractSettings
      const extractBlock = lines.slice(extractIdx, extractIdx + 20).join('\n')
      expect(extractBlock).toContain('favoriteModels')
    })

    test('partialize includes favoriteModels', () => {
      const content = readSettingsStore()
      const lines = content.split('\n')
      const partializeIdx = lines.findIndex((l) => l.includes('partialize:'))
      expect(partializeIdx).toBeGreaterThan(0)
      const partializeBlock = lines.slice(partializeIdx, partializeIdx + 15).join('\n')
      expect(partializeBlock).toContain('favoriteModels')
    })

    test('toggleFavoriteModel persists via saveToDatabase', () => {
      const content = readSettingsStore()
      const lines = content.split('\n')
      const toggleIdx = lines.findIndex((l) => l.includes('toggleFavoriteModel:'))
      expect(toggleIdx).toBeGreaterThan(0)
      const toggleBlock = lines.slice(toggleIdx, toggleIdx + 15).join('\n')
      expect(toggleBlock).toContain('saveToDatabase')
    })
  })

  describe('ModelSelector - favorites UI', () => {
    test('imports Star icon from lucide-react', () => {
      const content = readModelSelector()
      expect(content).toContain('Star')
      expect(content).toMatch(/import\s*{[^}]*Star[^}]*}\s*from\s*'lucide-react'/)
    })

    test('accesses favoriteModels from settings store', () => {
      const content = readModelSelector()
      expect(content).toContain('useSettingsStore((s) => s.favoriteModels)')
    })

    test('accesses toggleFavoriteModel from settings store', () => {
      const content = readModelSelector()
      expect(content).toContain('useSettingsStore((s) => s.toggleFavoriteModel)')
    })

    test('has isFavorite callback using providerID::modelID key', () => {
      const content = readModelSelector()
      expect(content).toContain('isFavorite')
      expect(content).toContain('`${model.providerID}::${model.id}`')
    })

    test('has favoriteModelObjects memo filtering providers', () => {
      const content = readModelSelector()
      expect(content).toContain('favoriteModelObjects')
      expect(content).toContain('providers.flatMap')
    })

    test('renders Favorites section header with star icon', () => {
      const content = readModelSelector()
      expect(content).toContain('fill-yellow-500 text-yellow-500')
      expect(content).toContain('Favorites')
    })

    test('favorites section only renders when favorites exist', () => {
      const content = readModelSelector()
      expect(content).toContain('favoriteModelObjects.length > 0')
    })

    test('favorite items in favorites section have onContextMenu for toggle', () => {
      const content = readModelSelector()
      const lines = content.split('\n')
      // Find the favorites section map
      const favMapIdx = lines.findIndex((l) => l.includes('favoriteModelObjects.map'))
      expect(favMapIdx).toBeGreaterThan(0)
      const favBlock = lines.slice(favMapIdx, favMapIdx + 20).join('\n')
      expect(favBlock).toContain('onContextMenu')
      expect(favBlock).toContain('toggleFavoriteModel')
    })

    test('regular model items have onContextMenu for toggling favorite', () => {
      const content = readModelSelector()
      const lines = content.split('\n')
      // Find the filteredProviders.map section
      const provMapIdx = lines.findIndex((l) => l.includes('filteredProviders.map'))
      expect(provMapIdx).toBeGreaterThan(0)
      const provBlock = lines.slice(provMapIdx, provMapIdx + 25).join('\n')
      expect(provBlock).toContain('onContextMenu')
      expect(provBlock).toContain('toggleFavoriteModel')
    })

    test('regular model items show star icon when favorited', () => {
      const content = readModelSelector()
      const lines = content.split('\n')
      // Find the filteredProviders.map and check for isFavorite conditional star
      const provMapIdx = lines.findIndex((l) => l.includes('filteredProviders.map'))
      expect(provMapIdx).toBeGreaterThan(0)
      const provBlock = lines.slice(provMapIdx, provMapIdx + 30).join('\n')
      expect(provBlock).toContain('isFavorite(model)')
    })

    test('favorites section has separator after it', () => {
      const content = readModelSelector()
      const lines = content.split('\n')
      const favMapIdx = lines.findIndex((l) => l.includes('favoriteModelObjects.map'))
      expect(favMapIdx).toBeGreaterThan(0)
      // Find the closing of the favorites section — should have DropdownMenuSeparator
      const favEndBlock = lines.slice(favMapIdx, favMapIdx + 25).join('\n')
      expect(favEndBlock).toContain('DropdownMenuSeparator')
    })

    test('clicking favorite model selects it via handleSelectModel', () => {
      const content = readModelSelector()
      const lines = content.split('\n')
      const favMapIdx = lines.findIndex((l) => l.includes('favoriteModelObjects.map'))
      expect(favMapIdx).toBeGreaterThan(0)
      const favBlock = lines.slice(favMapIdx, favMapIdx + 15).join('\n')
      expect(favBlock).toContain('handleSelectModel(model)')
    })

    test('active model check mark shown in favorites section', () => {
      const content = readModelSelector()
      const lines = content.split('\n')
      const favMapIdx = lines.findIndex((l) => l.includes('favoriteModelObjects.map'))
      expect(favMapIdx).toBeGreaterThan(0)
      const favBlock = lines.slice(favMapIdx, favMapIdx + 20).join('\n')
      expect(favBlock).toContain('isActiveModel(model)')
      expect(favBlock).toContain('Check')
    })
  })
})
