import { existsSync, readdirSync } from 'fs'
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
