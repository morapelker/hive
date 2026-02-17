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

/** @deprecated Use generateConnectionInstructions instead */
export const generateAgentsMd = generateConnectionInstructions
