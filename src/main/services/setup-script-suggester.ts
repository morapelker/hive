import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

import type { SuggestionItem } from '@shared/types/setup-suggestions'
import { createLogger } from './logger'

const log = createLogger({ component: 'SetupScriptSuggester' })

type JsPackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

const ENV_TEMPLATE_FILES = new Set(['.env.example', '.env.sample', '.env.template'])

const makeItem = (
  id: string,
  command: string,
  label: string,
  category: SuggestionItem['category']
): SuggestionItem => ({
  id,
  command,
  label,
  category,
  defaultChecked: true
})

const fileExists = (projectPath: string, relativePath: string): boolean => {
  try {
    return (
      existsSync(join(projectPath, relativePath)) &&
      statSync(join(projectPath, relativePath)).isFile()
    )
  } catch {
    return false
  }
}

const detectEnvSuggestions = (projectPath: string): SuggestionItem[] =>
  readdirSync(projectPath)
    .filter((name) => {
      if (!name.startsWith('.env') || ENV_TEMPLATE_FILES.has(name)) return false
      return fileExists(projectPath, name)
    })
    .sort((a, b) => a.localeCompare(b))
    .map((name) =>
      makeItem('env:' + name, `cp ${join(projectPath, name)} .`, `Copy ${name}`, 'env')
    )

const detectInstallSuggestion = (
  projectPath: string
): { item: SuggestionItem | null; detectedPm: JsPackageManager | null } => {
  if (fileExists(projectPath, 'pnpm-lock.yaml')) {
    return {
      item: makeItem('install:pnpm', 'pnpm i', 'Install with pnpm', 'install'),
      detectedPm: 'pnpm'
    }
  }
  if (fileExists(projectPath, 'yarn.lock')) {
    return {
      item: makeItem('install:yarn', 'yarn install', 'Install with yarn', 'install'),
      detectedPm: 'yarn'
    }
  }
  if (fileExists(projectPath, 'bun.lockb') || fileExists(projectPath, 'bun.lock')) {
    return {
      item: makeItem('install:bun', 'bun install', 'Install with bun', 'install'),
      detectedPm: 'bun'
    }
  }
  if (fileExists(projectPath, 'package-lock.json')) {
    return {
      item: makeItem('install:npm', 'npm install', 'Install with npm', 'install'),
      detectedPm: 'npm'
    }
  }
  if (fileExists(projectPath, 'pyproject.toml') && fileExists(projectPath, 'uv.lock')) {
    return {
      item: makeItem('install:uv', 'uv sync', 'Sync uv environment', 'install'),
      detectedPm: null
    }
  }

  return { item: null, detectedPm: null }
}

const packageJsonHasPostinstall = (projectPath: string): boolean => {
  try {
    const packageJson = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8')) as {
      scripts?: { postinstall?: unknown }
    }
    return typeof packageJson.scripts?.postinstall === 'string'
  } catch {
    return false
  }
}

const makefileHasSetupTarget = (projectPath: string): boolean => {
  try {
    return /^setup\s*:/m.test(readFileSync(join(projectPath, 'Makefile'), 'utf-8'))
  } catch {
    return false
  }
}

const detectPostInstallSuggestions = (
  projectPath: string,
  detectedPm: JsPackageManager | null
): SuggestionItem[] => {
  const items: SuggestionItem[] = []

  if (detectedPm && fileExists(projectPath, 'prisma/schema.prisma')) {
    items.push(
      makeItem(
        'postinstall:prisma',
        `${detectedPm} exec prisma generate`,
        'Generate Prisma client',
        'postinstall'
      )
    )
  }

  if (detectedPm && packageJsonHasPostinstall(projectPath)) {
    items.push(
      makeItem(
        'postinstall:package-json',
        `${detectedPm} run postinstall`,
        'Run package postinstall',
        'postinstall'
      )
    )
  }

  if (fileExists(projectPath, 'Makefile') && makefileHasSetupTarget(projectPath)) {
    items.push(makeItem('postinstall:make-setup', 'make setup', 'Run make setup', 'postinstall'))
  }

  return items
}

export function detectSetupSuggestions(projectPath: string): SuggestionItem[] {
  try {
    const items: SuggestionItem[] = [...detectEnvSuggestions(projectPath)]
    const { item: installItem, detectedPm } = detectInstallSuggestion(projectPath)
    if (installItem) {
      items.push(installItem)
    }
    items.push(...detectPostInstallSuggestions(projectPath, detectedPm))
    return items
  } catch (error) {
    log.error(
      'Failed to detect setup script suggestions',
      error instanceof Error ? error : new Error(String(error)),
      { projectPath }
    )
    return []
  }
}
