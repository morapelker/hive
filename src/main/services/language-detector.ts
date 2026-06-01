import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'LanguageDetector' })

/**
 * Detect the primary programming language of a project by checking
 * for characteristic files in the project root directory.
 * Returns a language identifier string or null if no match.
 */
export async function detectProjectLanguage(projectPath: string): Promise<string | null> {
  try {
    const has = (file: string): boolean => existsSync(join(projectPath, file))

    // Check in priority order
    if (has('tsconfig.json')) return 'typescript'
    if (has('package.json')) return 'javascript'
    if (has('go.mod') || has('go.sum')) return 'go'
    if (has('Cargo.toml')) return 'rust'
    if (has('requirements.txt') || has('pyproject.toml') || has('setup.py')) return 'python'
    if (has('Gemfile')) return 'ruby'
    if (has('Package.swift') || has('Podfile')) return 'swift'
    try {
      if (readdirSync(projectPath).some((f) => f.endsWith('.podspec'))) return 'swift'
    } catch {
      /* ignore */
    }
    if (has('build.gradle.kts')) return 'kotlin'
    if (has('pom.xml') || has('build.gradle')) return 'java'
    if (has('composer.json')) return 'php'
    if (has('mix.exs')) return 'elixir'
    if (has('pubspec.yaml')) return 'dart'
    if (has('CMakeLists.txt')) return 'cpp'

    // Check for file-extension-based detection
    try {
      const files = readdirSync(projectPath)
      if (files.some((f) => f.endsWith('.swift'))) return 'swift'
      if (files.some((f) => f.endsWith('.kt') || f.endsWith('.kts'))) return 'kotlin'
      if (files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) return 'csharp'
      if (files.some((f) => f.endsWith('.c') && !f.endsWith('.rc'))) return 'c'
    } catch {
      // Ignore readdir errors
    }

    return null
  } catch (error) {
    log.error(
      'Failed to detect project language',
      error instanceof Error ? error : new Error(String(error)),
      { projectPath }
    )
    return null
  }
}

/**
 * Detect a project favicon by scanning well-known paths.
 * Returns the absolute path of the first match, or null.
 * Note: synchronous (only uses existsSync) but callers may await the result.
 */
export function detectProjectFavicon(projectPath: string): string | null {
  try {
    const candidates = [
      // Next.js App Router
      'app/icon.svg', 'app/favicon.svg',
      'app/icon.png', 'app/favicon.png',
      'app/favicon.ico',
      // Next.js App Router with src/
      'src/app/icon.svg', 'src/app/favicon.svg',
      'src/app/icon.png', 'src/app/favicon.png',
      'src/app/favicon.ico',
      // Universal public/ (Vite, CRA, Next.js Pages)
      'public/favicon.svg', 'public/icon.svg',
      'public/favicon.png', 'public/icon.png',
      'public/favicon.ico',
      // SvelteKit / older frameworks
      'static/favicon.svg',
      'static/favicon.png',
      'static/favicon.ico',
      // Angular
      'src/favicon.ico',
      // Root fallback
      'favicon.svg',
      'favicon.png',
      'favicon.ico'
    ]

    for (const candidate of candidates) {
      const fullPath = join(projectPath, candidate)
      if (existsSync(fullPath)) {
        return fullPath
      }
    }

    return null
  } catch (error) {
    log.error(
      'Failed to detect project favicon',
      error instanceof Error ? error : new Error(String(error)),
      { projectPath }
    )
    return null
  }
}

/**
 * Find an Xcode workspace in the project root or Example/ subdirectory.
 */
export function findXcworkspace(projectPath: string): string | null {
  try {
    const rootFiles = readdirSync(projectPath)
    const rootMatch = rootFiles.find((file) => file.endsWith('.xcworkspace'))
    if (rootMatch) return join(projectPath, rootMatch)

    const exampleDir = join(projectPath, 'Example')
    if (existsSync(exampleDir)) {
      const exampleFiles = readdirSync(exampleDir)
      const exampleMatch = exampleFiles.find((file) => file.endsWith('.xcworkspace'))
      if (exampleMatch) return join(exampleDir, exampleMatch)
    }

    return null
  } catch {
    return null
  }
}

/**
 * Detect whether a project is an Android project from manifests or Gradle plugins.
 */
export function isAndroidProject(projectPath: string): boolean {
  try {
    if (existsSync(join(projectPath, 'app', 'src', 'main', 'AndroidManifest.xml'))) return true
    if (existsSync(join(projectPath, 'AndroidManifest.xml'))) return true

    for (const buildFile of ['build.gradle', 'build.gradle.kts']) {
      const buildPath = join(projectPath, buildFile)
      if (existsSync(buildPath)) {
        const content = readFileSync(buildPath, 'utf-8')
        if (content.includes('com.android.application') || content.includes('com.android.library')) {
          return true
        }
      }
    }

    for (const buildFile of ['build.gradle', 'build.gradle.kts']) {
      const buildPath = join(projectPath, 'app', buildFile)
      if (existsSync(buildPath)) {
        const content = readFileSync(buildPath, 'utf-8')
        if (content.includes('com.android.application') || content.includes('com.android.library')) {
          return true
        }
      }
    }

    return false
  } catch {
    return false
  }
}
