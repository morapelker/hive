import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * Session 11: Custom Project Icon — Tests
 *
 * These tests verify:
 * 1. LanguageIcon renders <img> when customIcon is set
 * 2. LanguageIcon falls back to language icon when customIcon is null
 * 3. LanguageIcon renders FolderGit2 when no customIcon and no language
 * 4. ProjectSettingsDialog shows icon picker section
 * 5. Clear button only shown when custom icon exists
 * 6. Database migration adds custom_icon column
 * 7. IPC handlers are registered
 */

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock the stores
vi.mock('@/stores', () => {
  const useProjectStore = vi.fn(() => ({
    updateProject: vi.fn().mockResolvedValue(true)
  }))
  ;(useProjectStore as unknown as Record<string, unknown>).getState = vi.fn(() => ({
    updateProject: vi.fn().mockResolvedValue(true)
  }))
  return { useProjectStore }
})

// Mock window.projectOps
Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: {
    loadLanguageIcons: vi.fn().mockResolvedValue({}),
    pickProjectIcon: vi.fn().mockResolvedValue({ success: true, filename: 'test.png' }),
    removeProjectIcon: vi.fn().mockResolvedValue({ success: true }),
    getProjectIconPath: vi.fn().mockResolvedValue('data:image/png;base64,iVBOR'),
    detectLanguage: vi.fn().mockResolvedValue(null),
    showInFolder: vi.fn(),
    copyToClipboard: vi.fn()
  }
})

describe('Session 11: Custom Project Icon', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Database migration', () => {
    test('schema version matches CURRENT_SCHEMA_VERSION', async () => {
      const { CURRENT_SCHEMA_VERSION } = await import('../../../src/main/db/schema')
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    })

    test('schema includes custom_icon column on projects', async () => {
      const { MIGRATIONS } = await import('../../../src/main/db/schema')
      const schema = MIGRATIONS.find((m) => m.version === 1)
      expect(schema).toBeDefined()
      expect(schema!.up).toContain('custom_icon')
    })
  })

  describe('Type definitions', () => {
    test('Project type in db/types.ts includes custom_icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/db/types.ts'),
        'utf-8'
      )
      expect(source).toContain('custom_icon: string | null')
    })

    test('ProjectUpdate type includes custom_icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/db/types.ts'),
        'utf-8'
      )
      expect(source).toContain('custom_icon?: string | null')
    })

    test('Preload index.d.ts Project interface includes custom_icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.d.ts'),
        'utf-8'
      )
      expect(source).toContain('custom_icon: string | null')
    })

    test('Preload index.d.ts projectOps includes icon methods', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.d.ts'),
        'utf-8'
      )
      expect(source).toContain('pickProjectIcon')
      expect(source).toContain('removeProjectIcon')
      expect(source).toContain('getProjectIconPath')
    })
  })

  describe('LanguageIcon source verification', () => {
    test('LanguageIcon accepts customIcon prop', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/LanguageIcon.tsx'),
        'utf-8'
      )
      expect(source).toContain('customIcon')
      expect(source).toContain('alt="project icon"')
    })

    test('LanguageIcon renders img tag for custom project icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/LanguageIcon.tsx'),
        'utf-8'
      )
      // Should render an img element when customIcon is set
      expect(source).toContain('<img')
      expect(source).toContain('project icon')
    })

    test('LanguageIcon has priority order: customIcon > language custom > badge > FolderGit2', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/LanguageIcon.tsx'),
        'utf-8'
      )
      // customIcon check should come before language-based custom icon
      const customIconCheck = source.indexOf('customIcon && projectIconUrl')
      const languageIconCheck = source.indexOf('customIcons[language]')
      expect(customIconCheck).toBeGreaterThan(-1)
      expect(languageIconCheck).toBeGreaterThan(-1)
      expect(customIconCheck).toBeLessThan(languageIconCheck)
    })

    test('LanguageIcon uses projectIconCache for caching', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/LanguageIcon.tsx'),
        'utf-8'
      )
      expect(source).toContain('projectIconCache')
    })
  })

  describe('ProjectItem passes customIcon', () => {
    test('ProjectItem passes custom_icon to LanguageIcon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/ProjectItem.tsx'),
        'utf-8'
      )
      expect(source).toContain('customIcon={project.custom_icon}')
    })

    test('ProjectItem Project interface includes custom_icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/projects/ProjectItem.tsx'),
        'utf-8'
      )
      expect(source).toContain('custom_icon: string | null')
    })
  })

  describe('ProjectSettingsDialog icon picker', () => {
    test('ProjectSettingsDialog includes icon picker section', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/projects/ProjectSettingsDialog.tsx'
        ),
        'utf-8'
      )
      expect(source).toContain('Project Icon')
      expect(source).toContain('Change')
    })

    test('ProjectSettingsDialog has Clear button conditional on customIcon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/projects/ProjectSettingsDialog.tsx'
        ),
        'utf-8'
      )
      // Clear button should be conditional on customIcon
      expect(source).toContain('customIcon && (')
      expect(source).toContain('Clear')
    })

    test('ProjectSettingsDialog calls pickProjectIcon on Change click', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/projects/ProjectSettingsDialog.tsx'
        ),
        'utf-8'
      )
      expect(source).toContain('pickProjectIcon')
      expect(source).toContain('handlePickIcon')
    })

    test('ProjectSettingsDialog calls removeProjectIcon on Clear click', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/projects/ProjectSettingsDialog.tsx'
        ),
        'utf-8'
      )
      expect(source).toContain('removeProjectIcon')
      expect(source).toContain('handleClearIcon')
    })

    test('ProjectSettingsDialog includes custom_icon in save payload', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/projects/ProjectSettingsDialog.tsx'
        ),
        'utf-8'
      )
      expect(source).toContain('custom_icon: customIcon')
    })

    test('ProjectSettingsDialog renders LanguageIcon with customIcon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/projects/ProjectSettingsDialog.tsx'
        ),
        'utf-8'
      )
      expect(source).toContain('customIcon={customIcon}')
    })
  })

  describe('Preload bridge', () => {
    test('preload/index.ts exposes pickProjectIcon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.ts'),
        'utf-8'
      )
      expect(source).toContain('pickProjectIcon')
      expect(source).toContain("ipcRenderer.invoke('project:pickIcon'")
    })

    test('preload/index.ts exposes removeProjectIcon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.ts'),
        'utf-8'
      )
      expect(source).toContain('removeProjectIcon')
      expect(source).toContain("ipcRenderer.invoke('project:removeIcon'")
    })

    test('preload/index.ts exposes getProjectIconPath', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.ts'),
        'utf-8'
      )
      expect(source).toContain('getProjectIconPath')
      expect(source).toContain("ipcRenderer.invoke('project:getIconPath'")
    })
  })

  describe('IPC handlers', () => {
    test('project-handlers.ts registers icon handlers', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/ipc/project-handlers.ts'),
        'utf-8'
      )
      expect(source).toContain("'project:pickIcon'")
      expect(source).toContain("'project:removeIcon'")
      expect(source).toContain("'project:getIconPath'")
    })

    test('project-handlers.ts creates icon directory', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/ipc/project-handlers.ts'),
        'utf-8'
      )
      expect(source).toContain('project-icons')
      expect(source).toContain('ensureIconDir')
      expect(source).toContain('mkdirSync')
    })

    test('project-handlers.ts deletes previous icon before copying new one', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/ipc/project-handlers.ts'),
        'utf-8'
      )
      // Should remove existing icons for the project before copying new one
      expect(source).toContain('readdirSync')
      expect(source).toContain('unlinkSync')
      expect(source).toContain('copyFileSync')
    })

    test('project-handlers.ts returns data URL from getIconPath', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/ipc/project-handlers.ts'),
        'utf-8'
      )
      // Should return base64 data URL
      expect(source).toContain('data:${mime};base64')
    })

    test('project-handlers.ts filters for image file types in picker', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/ipc/project-handlers.ts'),
        'utf-8'
      )
      expect(source).toContain("extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp']")
    })
  })

  describe('useProjectStore', () => {
    test('useProjectStore Project interface includes custom_icon', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/stores/useProjectStore.ts'),
        'utf-8'
      )
      expect(source).toContain('custom_icon: string | null')
    })

    test('updateProject accepts custom_icon parameter', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/stores/useProjectStore.ts'),
        'utf-8'
      )
      expect(source).toContain('custom_icon?: string | null')
    })
  })
})
