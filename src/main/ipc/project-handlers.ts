import { dialog, shell, clipboard, BrowserWindow, app } from 'electron'
import { existsSync, readdirSync, readFileSync, copyFileSync, unlinkSync, mkdirSync } from 'fs'
import { join, extname } from 'path'
import { Data, Effect } from 'effect'
import { z } from 'zod'

import { createLogger } from '../services/logger'
import {
  isGitRepository,
  validateProject,
  initRepository,
  detectProjectLanguage,
  detectProjectFavicon,
  detectSetupSuggestions,
  loadLanguageIcons,
  getIconDataUrl,
  getAbsoluteIconDataUrl,
  removeIcon
} from '../services/project-ops'
import { defineHandler } from './_shared/define-handler'

const log = createLogger({ component: 'ProjectHandlers' })

export interface AddProjectResult {
  success: boolean
  path?: string
  name?: string
  error?: string
}

class ProjectHandlerFailed extends Data.TaggedError('ProjectHandlerFailed')<{
  readonly operation: string
  readonly reason: string
  readonly message: string
}> {}

const projectFailed = (operation: string, cause: unknown): ProjectHandlerFailed => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new ProjectHandlerFailed({ operation, reason, message: reason })
}

const nonEmptyString = z.string().min(1)

export function registerProjectHandlers(): void {
  log.info('Registering project handlers')

  // Open folder picker dialog
  defineHandler('dialog:openDirectory', z.tuple([]), () =>
    Effect.tryPromise({
      try: async (): Promise<string | null> => {
        log.debug('Opening directory picker dialog')
        const window = BrowserWindow.getFocusedWindow()
        const result = await dialog.showOpenDialog(window!, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Select Project Folder',
          buttonLabel: 'Add Project'
        })

        if (result.canceled || result.filePaths.length === 0) {
          log.debug('Directory picker canceled')
          return null
        }

        log.info('Directory selected', { path: result.filePaths[0] })
        return result.filePaths[0]
      },
      catch: (error) => projectFailed('dialog:openDirectory', error)
    })
  )

  // Validate if a path is a git repository
  defineHandler('git:isRepository', nonEmptyString, (path) =>
    Effect.try({
      try: () => isGitRepository(path),
      catch: (error) => projectFailed('git:isRepository', error)
    })
  )

  // Validate and get project info for adding
  defineHandler(
    'project:validate',
    nonEmptyString,
    (path): Effect.Effect<AddProjectResult, ProjectHandlerFailed> =>
      Effect.try({
        try: () => validateProject(path),
        catch: (error) => projectFailed('project:validate', error)
      })
  )

  // Initialize a new git repository in a directory
  defineHandler('git:init', nonEmptyString, (path) =>
    Effect.try({
      try: () => initRepository(path),
      catch: (error) => projectFailed('git:init', error)
    })
  )

  // Open path in Finder/Explorer
  defineHandler('shell:showItemInFolder', nonEmptyString, (path) =>
    Effect.try({
      try: () => shell.showItemInFolder(path),
      catch: (error) => projectFailed('shell:showItemInFolder', error)
    })
  )

  // Open path in default file manager
  defineHandler('shell:openPath', nonEmptyString, (path) =>
    Effect.tryPromise({
      try: () => shell.openPath(path),
      catch: (error) => projectFailed('shell:openPath', error)
    })
  )

  // Copy text to clipboard
  defineHandler('clipboard:writeText', z.string(), (text) =>
    Effect.try({
      try: () => clipboard.writeText(text),
      catch: (error) => projectFailed('clipboard:writeText', error)
    })
  )

  // Read text from clipboard
  defineHandler('clipboard:readText', z.tuple([]), () =>
    Effect.try({
      try: () => clipboard.readText(),
      catch: (error) => projectFailed('clipboard:readText', error)
    })
  )

  // Detect project language from characteristic files
  defineHandler('project:detectLanguage', nonEmptyString, (projectPath) =>
    Effect.tryPromise({
      try: async (): Promise<string | null> => {
        log.debug('Detecting project language', { projectPath })
        return detectProjectLanguage(projectPath)
      },
      catch: (error) => projectFailed('project:detectLanguage', error)
    })
  )

  // Detect project favicon from well-known paths
  defineHandler('project:detectFavicon', nonEmptyString, (projectPath) =>
    Effect.try({
      try: (): string | null => {
        log.debug('Detecting project favicon', { projectPath })
        return detectProjectFavicon(projectPath)
      },
      catch: (error) => projectFailed('project:detectFavicon', error)
    })
  )

  // Detect suggested setup script commands from project files
  defineHandler('project:detectSetupSuggestions', nonEmptyString, (projectPath) =>
    Effect.try({
      try: () => {
        log.debug('Detecting setup script suggestions', { projectPath })
        return detectSetupSuggestions(projectPath)
      },
      catch: (error) => projectFailed('project:detectSetupSuggestions', error)
    })
  )

  // Resolve an absolute icon path to a data URL
  defineHandler('project:getAbsoluteIconDataUrl', nonEmptyString, (absolutePath) =>
    Effect.try({
      try: () => getAbsoluteIconDataUrl(absolutePath),
      catch: (error) => projectFailed('project:getAbsoluteIconDataUrl', error)
    })
  )

  // Load custom language icons as data URLs
  defineHandler('project:loadLanguageIcons', z.tuple([]), () =>
    Effect.try({
      try: (): Record<string, string> => loadLanguageIcons(),
      catch: (error) => projectFailed('project:loadLanguageIcons', error)
    })
  )

  // --- Custom Project Icon handlers ---

  const iconDir = join(app.getPath('home'), '.hive', 'project-icons')

  /**
   * Ensure the project-icons directory exists
   */
  function ensureIconDir(): void {
    if (!existsSync(iconDir)) {
      mkdirSync(iconDir, { recursive: true })
    }
  }

  // Pick a custom project icon via native file dialog, copy to ~/.hive/project-icons/
  defineHandler('project:pickIcon', nonEmptyString, (projectId) =>
    Effect.tryPromise({
      try: async (): Promise<{ success: boolean; filename?: string; error?: string }> => {
        try {
          const window = BrowserWindow.getFocusedWindow()
          const result = await dialog.showOpenDialog(window!, {
            properties: ['openFile'],
            title: 'Select Project Icon',
            buttonLabel: 'Select Icon',
            filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'] }]
          })

          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: 'cancelled' }
          }

          const sourcePath = result.filePaths[0]
          const ext = extname(sourcePath).toLowerCase()
          const filename = `${projectId}${ext}`

          ensureIconDir()

          // Remove any previous icon for this project (different extension)
          const existing = readdirSync(iconDir).filter((f) => f.startsWith(`${projectId}.`))
          for (const old of existing) {
            try {
              unlinkSync(join(iconDir, old))
            } catch {
              // ignore cleanup errors
            }
          }

          copyFileSync(sourcePath, join(iconDir, filename))
          log.info('Project icon set', { projectId, filename })

          return { success: true, filename }
        } catch (error) {
          log.error(
            'Failed to pick project icon',
            error instanceof Error ? error : new Error(String(error)),
            { projectId }
          )
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      },
      catch: (error) => projectFailed('project:pickIcon', error)
    })
  )

  // Remove a custom project icon
  defineHandler('project:removeIcon', nonEmptyString, (projectId) =>
    Effect.try({
      try: () => removeIcon(projectId),
      catch: (error) => projectFailed('project:removeIcon', error)
    })
  )

  // Resolve an icon filename to a data URL for the renderer
  defineHandler('project:getIconPath', nonEmptyString, (filename) =>
    Effect.try({
      try: () => getIconDataUrl(filename),
      catch: (error) => projectFailed('project:getIconPath', error)
    })
  )

  // Find .xcworkspace file for Swift projects (checks root + Example/ subdirectory)
  defineHandler('project:findXcworkspace', nonEmptyString, (projectPath) =>
    Effect.sync((): string | null => {
      try {
        const rootFiles = readdirSync(projectPath)
        const rootMatch = rootFiles.find((f) => f.endsWith('.xcworkspace'))
        if (rootMatch) return join(projectPath, rootMatch)

        const exampleDir = join(projectPath, 'Example')
        if (existsSync(exampleDir)) {
          const exampleFiles = readdirSync(exampleDir)
          const exampleMatch = exampleFiles.find((f) => f.endsWith('.xcworkspace'))
          if (exampleMatch) return join(exampleDir, exampleMatch)
        }

        return null
      } catch {
        return null
      }
    })
  )

  // Detect whether a project is an Android project (checks for AndroidManifest.xml or Android Gradle plugins)
  defineHandler('project:isAndroidProject', nonEmptyString, (projectPath) =>
    Effect.sync((): boolean => {
      try {
        // Check for AndroidManifest.xml in standard locations
        if (existsSync(join(projectPath, 'app', 'src', 'main', 'AndroidManifest.xml'))) return true
        if (existsSync(join(projectPath, 'AndroidManifest.xml'))) return true

        // Check build.gradle or build.gradle.kts for Android plugins
        for (const buildFile of ['build.gradle', 'build.gradle.kts']) {
          const buildPath = join(projectPath, buildFile)
          if (existsSync(buildPath)) {
            const content = readFileSync(buildPath, 'utf-8')
            if (
              content.includes('com.android.application') ||
              content.includes('com.android.library')
            ) {
              return true
            }
          }
        }

        // Check app/build.gradle or app/build.gradle.kts for Android plugins
        for (const buildFile of ['build.gradle', 'build.gradle.kts']) {
          const buildPath = join(projectPath, 'app', buildFile)
          if (existsSync(buildPath)) {
            const content = readFileSync(buildPath, 'utf-8')
            if (
              content.includes('com.android.application') ||
              content.includes('com.android.library')
            ) {
              return true
            }
          }
        }

        return false
      } catch {
        return false
      }
    })
  )
}
