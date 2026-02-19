import { app } from 'electron'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  renameSync,
  writeFileSync
} from 'fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'ConnectionService' })

const CONNECTIONS_DIR_NAME = 'connections'

export function getConnectionsBaseDir(): string {
  const homeDir = app.getPath('home')
  return join(homeDir, '.hive', CONNECTIONS_DIR_NAME)
}

export function ensureConnectionsDir(): void {
  const dir = getConnectionsBaseDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    log.info('Created connections base directory', { path: dir })
  }
}

export function createConnectionDir(name: string): string {
  ensureConnectionsDir()
  const dirPath = join(getConnectionsBaseDir(), name)
  mkdirSync(dirPath, { recursive: true })
  log.info('Created connection directory', { name, path: dirPath })
  return dirPath
}

export function deleteConnectionDir(connectionPath: string): void {
  if (existsSync(connectionPath)) {
    rmSync(connectionPath, { recursive: true, force: true })
    log.info('Deleted connection directory', { path: connectionPath })
  }
}

export function createSymlink(targetPath: string, symlinkPath: string): void {
  symlinkSync(targetPath, symlinkPath, 'dir')
  log.info('Created symlink', { target: targetPath, link: symlinkPath })
}

export function removeSymlink(symlinkPath: string): void {
  try {
    const stat = lstatSync(symlinkPath)
    if (stat.isSymbolicLink()) {
      unlinkSync(symlinkPath)
      log.info('Removed symlink', { path: symlinkPath })
    }
  } catch {
    // Path does not exist -- nothing to remove
  }
}

export function renameConnectionDir(oldPath: string, newPath: string): void {
  renameSync(oldPath, newPath)
  log.info('Renamed connection directory', { from: oldPath, to: newPath })
}

export function deriveSymlinkName(projectName: string, existingNames: string[]): string {
  const base = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (!existingNames.includes(base)) return base
  let counter = 2
  while (existingNames.includes(`${base}-${counter}`)) counter++
  return `${base}-${counter}`
}

interface AgentsMdMember {
  symlinkName: string
  projectName: string
  branchName: string
  worktreePath: string
}

export function generateConnectionInstructions(
  connectionPath: string,
  members: AgentsMdMember[]
): void {
  const sections = members.map(
    (m) => `### ${m.symlinkName}/
- **Project:** ${m.projectName}
- **Branch:** ${m.branchName}
- **Real path:** ${m.worktreePath}`
  )

  const content = `# Connected Worktrees

This workspace contains **symlinked** worktrees from multiple projects.
Each subdirectory is a symlink pointing to a real git repository on disk.

## IMPORTANT — Symlink Safety

- **Every subdirectory here is a symlink** to a real project. Edits you make here directly modify the original project files.
- **ONLY work on files inside this directory (\`${connectionPath}\`).** Do not navigate to or edit files using the real paths listed below.
- **Do NOT create commits, run git operations, or push changes** unless the user explicitly asks you to.
- Treat this workspace as a read/write view into the linked projects — not as your own repo to manage.

## Projects

${sections.join('\n\n')}
`

  writeFileSync(join(connectionPath, 'AGENTS.md'), content, 'utf-8')
  writeFileSync(join(connectionPath, 'CLAUDE.md'), content, 'utf-8')
  log.info('Generated AGENTS.md and CLAUDE.md', {
    path: connectionPath,
    memberCount: members.length
  })
}

/**
 * Connection color quad: [inactiveBg, activeBg, inactiveText, activeText]
 * ~50 visually distinct presets to minimise duplicate chance and guarantee contrast.
 */
export type ConnectionColorQuad = [string, string, string, string]

const CONNECTION_COLOR_QUADS: ConnectionColorQuad[] = [
  // ── Reds ───────────────────────────────────────────────
  ['#fecaca', '#dc2626', '#991b1b', '#ffffff'], // red light
  ['#fee2e2', '#ef4444', '#7f1d1d', '#ffffff'], // red medium
  ['#fca5a5', '#b91c1c', '#450a0a', '#fecaca'], // red deep

  // ── Oranges ────────────────────────────────────────────
  ['#fed7aa', '#ea580c', '#9a3412', '#ffffff'], // orange light
  ['#ffedd5', '#f97316', '#7c2d12', '#ffffff'], // orange medium
  ['#fdba74', '#c2410c', '#431407', '#fed7aa'], // orange deep

  // ── Ambers ─────────────────────────────────────────────
  ['#fde68a', '#d97706', '#78350f', '#ffffff'], // amber light
  ['#fef3c7', '#f59e0b', '#713f12', '#ffffff'], // amber medium
  ['#fcd34d', '#b45309', '#451a03', '#fef3c7'], // amber deep

  // ── Yellows ────────────────────────────────────────────
  ['#fef08a', '#ca8a04', '#713f12', '#ffffff'], // yellow light
  ['#fef9c3', '#eab308', '#422006', '#ffffff'], // yellow medium

  // ── Limes ──────────────────────────────────────────────
  ['#d9f99d', '#65a30d', '#1a2e05', '#ffffff'], // lime light
  ['#ecfccb', '#84cc16', '#365314', '#ffffff'], // lime medium

  // ── Greens ─────────────────────────────────────────────
  ['#bbf7d0', '#16a34a', '#14532d', '#ffffff'], // green light
  ['#dcfce7', '#22c55e', '#166534', '#ffffff'], // green medium
  ['#86efac', '#15803d', '#052e16', '#dcfce7'], // green deep

  // ── Emeralds ───────────────────────────────────────────
  ['#a7f3d0', '#059669', '#064e3b', '#ffffff'], // emerald light
  ['#d1fae5', '#10b981', '#065f46', '#ffffff'], // emerald medium
  ['#6ee7b7', '#047857', '#022c22', '#d1fae5'], // emerald deep

  // ── Teals ──────────────────────────────────────────────
  ['#99f6e4', '#0d9488', '#134e4a', '#ffffff'], // teal light
  ['#ccfbf1', '#14b8a6', '#115e59', '#ffffff'], // teal medium
  ['#5eead4', '#0f766e', '#042f2e', '#ccfbf1'], // teal deep

  // ── Cyans ──────────────────────────────────────────────
  ['#a5f3fc', '#0891b2', '#164e63', '#ffffff'], // cyan light
  ['#cffafe', '#06b6d4', '#155e75', '#ffffff'], // cyan medium
  ['#67e8f9', '#0e7490', '#083344', '#cffafe'], // cyan deep

  // ── Skys ───────────────────────────────────────────────
  ['#bae6fd', '#0284c7', '#0c4a6e', '#ffffff'], // sky light
  ['#e0f2fe', '#0ea5e9', '#075985', '#ffffff'], // sky medium

  // ── Blues ───────────────────────────────────────────────
  ['#bfdbfe', '#2563eb', '#1e3a5f', '#ffffff'], // blue light
  ['#dbeafe', '#3b82f6', '#1e40af', '#ffffff'], // blue medium
  ['#93c5fd', '#1d4ed8', '#172554', '#dbeafe'], // blue deep

  // ── Indigos ────────────────────────────────────────────
  ['#c7d2fe', '#4f46e5', '#312e81', '#ffffff'], // indigo light
  ['#e0e7ff', '#6366f1', '#3730a3', '#ffffff'], // indigo medium
  ['#a5b4fc', '#4338ca', '#1e1b4b', '#e0e7ff'], // indigo deep

  // ── Violets ────────────────────────────────────────────
  ['#ddd6fe', '#7c3aed', '#4c1d95', '#ffffff'], // violet light
  ['#ede9fe', '#8b5cf6', '#5b21b6', '#ffffff'], // violet medium
  ['#c4b5fd', '#6d28d9', '#2e1065', '#ede9fe'], // violet deep

  // ── Purples ────────────────────────────────────────────
  ['#e9d5ff', '#9333ea', '#581c87', '#ffffff'], // purple light
  ['#f3e8ff', '#a855f7', '#6b21a8', '#ffffff'], // purple medium
  ['#d8b4fe', '#7e22ce', '#3b0764', '#f3e8ff'], // purple deep

  // ── Fuchsias ───────────────────────────────────────────
  ['#f5d0fe', '#c026d3', '#701a75', '#ffffff'], // fuchsia light
  ['#fae8ff', '#d946ef', '#86198f', '#ffffff'], // fuchsia medium
  ['#e879f9', '#a21caf', '#4a044e', '#fae8ff'], // fuchsia deep

  // ── Pinks ──────────────────────────────────────────────
  ['#fbcfe8', '#db2777', '#831843', '#ffffff'], // pink light
  ['#fce7f3', '#ec4899', '#9d174d', '#ffffff'], // pink medium
  ['#f9a8d4', '#be185d', '#500724', '#fce7f3'], // pink deep

  // ── Roses ──────────────────────────────────────────────
  ['#fecdd3', '#e11d48', '#881337', '#ffffff'], // rose light
  ['#ffe4e6', '#f43f5e', '#9f1239', '#ffffff'], // rose medium
  ['#fda4af', '#be123c', '#4c0519', '#ffe4e6'], // rose deep

  // ── Slates (neutral) ──────────────────────────────────
  ['#cbd5e1', '#475569', '#0f172a', '#ffffff'], // slate light
  ['#e2e8f0', '#64748b', '#1e293b', '#ffffff'], // slate medium

  // ── Stones (warm neutral) ─────────────────────────────
  ['#d6d3d1', '#57534e', '#1c1917', '#ffffff'], // stone light
  ['#e7e5e4', '#78716c', '#292524', '#ffffff']  // stone medium
]

export function generateConnectionColor(): string {
  const quad = CONNECTION_COLOR_QUADS[Math.floor(Math.random() * CONNECTION_COLOR_QUADS.length)]
  return JSON.stringify(quad)
}

/** @deprecated Use generateConnectionInstructions instead */
export const generateAgentsMd = generateConnectionInstructions
