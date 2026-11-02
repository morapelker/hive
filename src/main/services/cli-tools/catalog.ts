import type { CliToolId } from '@shared/types/cli-tools'

/**
 * Everything Hive knows about each CLI tool, including the newest version it
 * will offer. The versions are deliberately embedded rather than fetched: bump them
 * here when a new release ships, and the Manage Skills dialog offers the update.
 */
export type CliToolCatalogEntry = {
  id: CliToolId
  name: string
  description: string
  /** Directory name of the skill in `.claude/skills`. */
  skillId: string
  /** Name of the executable on PATH. */
  binary: string
  latestVersion: string
  /** Only these platforms (process.platform values) can install and run the tool. */
  platforms: readonly NodeJS.Platform[]
} & ({ kind: 'npm'; npmPackage: string } | { kind: 'github-release'; releasesRepo: string })

export const CLI_TOOL_CATALOG: Record<CliToolId, CliToolCatalogEntry> = {
  'playwright-cli': {
    id: 'playwright-cli',
    kind: 'npm',
    name: 'Playwright CLI',
    description: 'Drive a browser from the terminal: open pages, click, type, snapshot and test.',
    skillId: 'playwright-cli',
    binary: 'playwright-cli',
    npmPackage: '@playwright/cli',
    latestVersion: '0.1.22',
    platforms: ['darwin', 'linux', 'win32']
  },
  tcu: {
    id: 'tcu',
    kind: 'github-release',
    name: 'Tedooo Computer Use (tcu)',
    description:
      'Control macOS apps in the background: screenshots, accessibility trees, clicks and typing.',
    skillId: 'tedooo-computer-use',
    binary: 'tcu',
    releasesRepo: 'TedoooTeam/tedooo-computer-use-releases',
    latestVersion: '0.2.3',
    platforms: ['darwin']
  }
}

export const CLI_TOOL_ORDER: readonly CliToolId[] = ['playwright-cli', 'tcu']

export const tcuReleaseAssetUrl = (releasesRepo: string, version: string, asset: string): string =>
  `https://github.com/${releasesRepo}/releases/download/v${version}/${asset}`

export const tcuLatestAssetUrl = (releasesRepo: string, asset: string): string =>
  `https://github.com/${releasesRepo}/releases/latest/download/${asset}`
