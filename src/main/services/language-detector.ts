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
    if (has('Package.swift')) return 'swift'
    if (has('pom.xml') || has('build.gradle')) return 'java'
    if (has('composer.json')) return 'php'
    if (has('mix.exs')) return 'elixir'
    if (has('pubspec.yaml')) return 'dart'
    if (has('CMakeLists.txt')) return 'cpp'

    // Check for C# project files (.csproj or .sln)
    try {
      const files = readdirSync(projectPath)
      if (files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) return 'csharp'
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
