import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TMPDIR ?? '/tmp'
  }
}))

import { detectSetupSuggestions } from '../src/main/services/setup-script-suggester'

const roots: string[] = []

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-setup-suggestions-'))
  roots.push(root)
  return root
}

function writeFixture(root: string, relativePath: string, contents = ''): void {
  const fullPath = join(root, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, contents)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('detectSetupSuggestions', () => {
  test('suggests env copy, pnpm install, and prisma generate for pnpm prisma projects', () => {
    const root = createProject()
    writeFixture(root, '.env.local', 'DATABASE_URL=postgres://example')
    writeFixture(root, 'pnpm-lock.yaml')
    writeFixture(root, 'prisma/schema.prisma')

    expect(detectSetupSuggestions(root)).toEqual([
      {
        id: 'env:.env.local',
        command: `cp ${join(root, '.env.local')} .`,
        label: 'Copy .env.local',
        category: 'env',
        defaultChecked: true
      },
      {
        id: 'install:pnpm',
        command: 'pnpm i',
        label: 'Install with pnpm',
        category: 'install',
        defaultChecked: true
      },
      {
        id: 'postinstall:prisma',
        command: 'pnpm exec prisma generate',
        label: 'Generate Prisma client',
        category: 'postinstall',
        defaultChecked: true
      }
    ])
  })

  test('suggests yarn install and package postinstall for yarn projects', () => {
    const root = createProject()
    writeFixture(root, 'yarn.lock')
    writeFixture(
      root,
      'package.json',
      JSON.stringify({ scripts: { postinstall: 'node setup.js' } })
    )

    expect(detectSetupSuggestions(root).map((item) => item.command)).toEqual([
      'yarn install',
      'yarn run postinstall'
    ])
  })

  test('uses lockfile precedence winner when multiple JavaScript lockfiles exist', () => {
    const root = createProject()
    writeFixture(root, 'pnpm-lock.yaml')
    writeFixture(root, 'yarn.lock')

    expect(detectSetupSuggestions(root).map((item) => item.command)).toEqual(['pnpm i'])
  })

  test('suggests uv sync for uv Python projects', () => {
    const root = createProject()
    writeFixture(root, 'pyproject.toml')
    writeFixture(root, 'uv.lock')

    expect(detectSetupSuggestions(root).map((item) => item.command)).toEqual(['uv sync'])
  })

  test('suggests only env copy for Rust projects without install rules', () => {
    const root = createProject()
    writeFixture(root, '.env', 'RUST_LOG=debug')
    writeFixture(root, 'Cargo.toml')

    expect(detectSetupSuggestions(root).map((item) => item.command)).toEqual([
      `cp ${join(root, '.env')} .`
    ])
  })

  test('suggests env copy and make setup when Makefile has setup target', () => {
    const root = createProject()
    writeFixture(root, '.env', 'APP_ENV=local')
    writeFixture(root, 'Makefile', 'setup:\n\tbin/setup\n')

    expect(detectSetupSuggestions(root).map((item) => item.command)).toEqual([
      `cp ${join(root, '.env')} .`,
      'make setup'
    ])
  })

  test('filters env template files', () => {
    const root = createProject()
    writeFixture(root, '.env.example', 'TOKEN=')

    expect(detectSetupSuggestions(root)).toEqual([])
  })

  test('returns empty array for unsupported projects', () => {
    const root = createProject()
    writeFixture(root, 'README.md', '# Project')

    expect(detectSetupSuggestions(root)).toEqual([])
  })

  test('sorts multiple env files and checks both by default', () => {
    const root = createProject()
    writeFixture(root, '.env.local', 'LOCAL=1')
    writeFixture(root, '.env', 'BASE=1')

    expect(detectSetupSuggestions(root)).toEqual([
      {
        id: 'env:.env',
        command: `cp ${join(root, '.env')} .`,
        label: 'Copy .env',
        category: 'env',
        defaultChecked: true
      },
      {
        id: 'env:.env.local',
        command: `cp ${join(root, '.env.local')} .`,
        label: 'Copy .env.local',
        category: 'env',
        defaultChecked: true
      }
    ])
  })
})
