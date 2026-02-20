# Phase 5: Operation Resolvers — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement ~60 GraphQL operation resolvers (non-AI) across 8 domains by extracting shared service layers from IPC handlers and writing thin resolver wrappers that call those services.

**Architecture:** Extract orchestration logic from IPC handlers into shared service modules. Both IPC handlers and GraphQL resolvers call the same service functions. Git operations already delegate to GitService. File tree scan functions are already exported. New service files handle worktree lifecycle, connection orchestration, project ops, settings detection, and system info.

**Tech Stack:** TypeScript, GraphQL Yoga, simple-git, chokidar, better-sqlite3, Vitest

**Design Doc:** `docs/plans/2026-02-20-phase5-operation-resolvers-design.md`

---

## Task 1: Extract Settings Detection Service

**Files:**
- Create: `src/main/services/settings-detection.ts`
- Modify: `src/main/ipc/settings-handlers.ts`

**Step 1: Create settings-detection.ts**

Extract `detectEditors()` and `detectTerminals()` from `settings-handlers.ts` into a new file. These functions are already self-contained — they just need to be exported.

```typescript
// src/main/services/settings-detection.ts
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { platform } from 'os'

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

export function detectEditors(): DetectedApp[] {
  // Copy the full detectEditors() function body from settings-handlers.ts lines 17-109
  // (the editorDefs array + detection loop)
}

export function detectTerminals(): DetectedApp[] {
  // Copy the full detectTerminals() function body from settings-handlers.ts lines 111-186
  // (the terminalDefs array + detection loop)
}
```

**Step 2: Update settings-handlers.ts to import from new module**

Remove the local `detectEditors`/`detectTerminals` functions and `DetectedApp` interface. Import from `settings-detection.ts`:

```typescript
import { detectEditors, detectTerminals, type DetectedApp } from '../services/settings-detection'
```

The IPC handler calls remain identical — they just call the imported functions now.

**Step 3: Verify no behavior change**

Run: `pnpm build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add src/main/services/settings-detection.ts src/main/ipc/settings-handlers.ts
git commit -m "refactor: extract settings detection into shared service"
```

---

## Task 2: Extract System Info Service

**Files:**
- Create: `src/main/services/system-info.ts`

**Step 1: Create system-info.ts**

Extract the agent SDK detection logic (currently duplicated in the plan from `src/main/index.ts` lines 274-293) into a service function. Also add app paths and server status helpers.

```typescript
// src/main/services/system-info.ts
import { app } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { getLogDir } from './logger'

export interface AgentSdkDetection {
  opencode: boolean
  claude: boolean
}

export function detectAgentSdks(): AgentSdkDetection {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const check = (binary: string): boolean => {
    try {
      const result = execFileSync(whichCmd, [binary], {
        encoding: 'utf-8',
        timeout: 5000,
        env: process.env
      }).trim()
      const firstLine = result.split('\n')[0].trim()
      return !!firstLine && existsSync(firstLine)
    } catch {
      return false
    }
  }
  return { opencode: check('opencode'), claude: check('claude') }
}

export interface AppPaths {
  userData: string
  home: string
  logs: string
}

export function getAppPaths(): AppPaths {
  return {
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    logs: getLogDir()
  }
}

export function getAppVersion(): string {
  return app.getVersion()
}
```

**Step 2: Verify**

Run: `pnpm build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/main/services/system-info.ts
git commit -m "feat: add system-info service for agent SDK detection and app paths"
```

---

## Task 3: Extract Project Ops Service

**Files:**
- Create: `src/main/services/project-ops.ts`
- Modify: `src/main/ipc/project-handlers.ts`

**Step 1: Create project-ops.ts**

Extract the non-Electron-specific project operations. The GraphQL API needs `projectValidate`, `projectIsGitRepository`, `projectDetectLanguage`, `projectLanguageIcons`, `projectIconPath`, `projectInitRepository`, `projectUploadIcon`, `projectRemoveIcon`.

```typescript
// src/main/services/project-ops.ts
import { existsSync, statSync, readFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, basename, extname } from 'path'
import { app } from 'electron'
import { detectProjectLanguage } from './language-detector'
import { getDatabase } from '../db'
import { createLogger } from './logger'

const log = createLogger({ component: 'ProjectOps' })

const ICON_DIR = join(app.getPath('home'), '.hive', 'project-icons')

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function ensureIconDir(): void {
  if (!existsSync(ICON_DIR)) {
    mkdirSync(ICON_DIR, { recursive: true })
  }
}

export function isGitRepository(path: string): boolean {
  try {
    const gitPath = join(path, '.git')
    return existsSync(gitPath) && statSync(gitPath).isDirectory()
  } catch {
    return false
  }
}

export function isValidDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function validateProject(path: string): { success: boolean; path?: string; name?: string; error?: string } {
  if (!isValidDirectory(path)) {
    return { success: false, error: 'The selected path is not a valid directory.' }
  }
  if (!isGitRepository(path)) {
    return { success: false, error: 'The selected folder is not a Git repository. Please select a folder containing a .git directory.' }
  }
  return { success: true, path, name: basename(path) }
}

export function initRepository(path: string): { success: boolean; error?: string } {
  try {
    execSync('git init --initial-branch=main', { cwd: path, encoding: 'utf-8' })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export { detectProjectLanguage }

export function loadLanguageIcons(): Record<string, string> {
  const db = getDatabase()
  const raw = db.getSetting('language_icons')
  if (!raw) return {}
  try {
    const iconPaths: Record<string, string> = JSON.parse(raw)
    const result: Record<string, string> = {}
    for (const [language, filePath] of Object.entries(iconPaths)) {
      try {
        if (!existsSync(filePath)) continue
        const ext = extname(filePath).toLowerCase()
        const mime = MIME_TYPES[ext]
        if (!mime) continue
        const data = readFileSync(filePath)
        result[language] = `data:${mime};base64,${data.toString('base64')}`
      } catch { /* skip */ }
    }
    return result
  } catch {
    return {}
  }
}

export function getIconDataUrl(filename: string): string | null {
  if (!filename) return null
  const fullPath = join(ICON_DIR, filename)
  if (!existsSync(fullPath)) return null
  try {
    const ext = extname(filename).toLowerCase()
    const mime = MIME_TYPES[ext]
    if (!mime) return null
    const data = readFileSync(fullPath)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}

export function uploadIcon(projectId: string, base64Data: string, filename: string): { success: boolean; error?: string } {
  try {
    ensureIconDir()
    const ext = extname(filename).toLowerCase()
    const targetFilename = `${projectId}${ext}`
    // Remove any previous icon for this project
    const existing = readdirSync(ICON_DIR).filter((f) => f.startsWith(`${projectId}.`))
    for (const old of existing) {
      try { unlinkSync(join(ICON_DIR, old)) } catch { /* ignore */ }
    }
    // Write the new icon
    const buffer = Buffer.from(base64Data, 'base64')
    writeFileSync(join(ICON_DIR, targetFilename), buffer)
    // Update DB
    getDatabase().updateProject(projectId, { custom_icon: targetFilename })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function removeIcon(projectId: string): { success: boolean; error?: string } {
  try {
    ensureIconDir()
    const existing = readdirSync(ICON_DIR).filter((f) => f.startsWith(`${projectId}.`))
    for (const old of existing) {
      unlinkSync(join(ICON_DIR, old))
    }
    getDatabase().updateProject(projectId, { custom_icon: null })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
```

**Step 2: Update project-handlers.ts to import from project-ops**

Replace inline `isGitRepository()`, `isValidDirectory()`, icon helpers with imports from `project-ops.ts`. Keep Electron-only handlers (dialog, shell, clipboard) inline.

```typescript
import { isGitRepository, isValidDirectory, validateProject, initRepository, loadLanguageIcons, getIconDataUrl, removeIcon } from '../services/project-ops'
```

**Step 3: Verify**

Run: `pnpm build`
Expected: Clean build.

**Step 4: Commit**

```bash
git add src/main/services/project-ops.ts src/main/ipc/project-handlers.ts
git commit -m "refactor: extract project ops into shared service"
```

---

## Task 4: Extract File Ops Service

**Files:**
- Create: `src/main/services/file-ops.ts`
- Modify: `src/main/ipc/file-handlers.ts`

**Step 1: Create file-ops.ts**

Extract file read/write logic from `file-handlers.ts`.

```typescript
// src/main/services/file-ops.ts
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export function readFile(filePath: string): { success: boolean; content?: string; error?: string } {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (!existsSync(filePath)) {
      return { success: false, error: 'File does not exist' }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: 'File too large (max 1MB)' }
    }
    const content = readFileSync(filePath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function readPromptFile(promptName: string): { success: boolean; content?: string; error?: string } {
  try {
    if (!promptName || typeof promptName !== 'string') {
      return { success: false, error: 'Invalid prompt name' }
    }
    const appPath = app.getAppPath()
    let promptPath = join(appPath, 'prompts', promptName)
    if (!existsSync(promptPath)) {
      const resourcesPath = join(appPath, '..', 'prompts', promptName)
      if (existsSync(resourcesPath)) {
        promptPath = resourcesPath
      } else {
        return { success: false, error: 'Prompt file not found' }
      }
    }
    const content = readFileSync(promptPath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function writeFile(filePath: string, content: string): { success: boolean; error?: string } {
  try {
    writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
```

**Step 2: Update file-handlers.ts**

```typescript
import { readFile, readPromptFile } from '../services/file-ops'
```

**Step 3: Verify**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/main/services/file-ops.ts src/main/ipc/file-handlers.ts
git commit -m "refactor: extract file ops into shared service"
```

---

## Task 5: Extract Worktree Ops Service

**Files:**
- Create: `src/main/services/worktree-ops.ts`
- Modify: `src/main/ipc/worktree-handlers.ts`

**Step 1: Create worktree-ops.ts**

Extract worktree orchestration (DB + git + settings + port). This is the most complex extraction — each function combines GitService calls, DB writes, and port assignment.

```typescript
// src/main/services/worktree-ops.ts
import { existsSync } from 'fs'
import { createGitService, isAutoNamedBranch } from './git-service'
import { type BreedType } from './breed-names'
import { assignPort, releasePort } from './port-registry'
import { scriptRunner } from './script-runner'
import { createLogger } from './logger'
import { getDatabase } from '../db'
import type { DatabaseService } from '../db/database'

const log = createLogger({ component: 'WorktreeOps' })

/**
 * Read the breed type preference from app_settings.
 */
export function getBreedType(db: DatabaseService): BreedType {
  try {
    const settingsJson = db.getSetting('app_settings')
    if (settingsJson) {
      const settings = JSON.parse(settingsJson)
      if (settings.breedType === 'cats') return 'cats'
    }
  } catch { /* fall back */ }
  return 'dogs'
}

/**
 * Create a new worktree: git operation + DB record + port assignment.
 */
export async function createWorktreeOp(
  db: DatabaseService,
  params: { projectId: string; projectPath: string; projectName: string }
): Promise<{ success: boolean; worktree?: any; error?: string }> {
  const gitService = createGitService(params.projectPath)
  const breedType = getBreedType(db)
  const result = await gitService.createWorktree(params.projectName, breedType)

  if (!result.success || !result.name || !result.path || !result.branchName) {
    return { success: false, error: result.error || 'Failed to create worktree' }
  }

  const worktree = db.createWorktree({
    project_id: params.projectId,
    name: result.name,
    branch_name: result.branchName,
    path: result.path
  })

  const project = db.getProject(params.projectId)
  if (project?.auto_assign_port) {
    assignPort(worktree.path)
  }

  return { success: true, worktree }
}

/**
 * Delete/archive a worktree: run archive script, git remove, release port, archive DB.
 */
export async function deleteWorktreeOp(
  db: DatabaseService,
  params: { worktreeId: string; worktreePath: string; branchName: string; projectPath: string; archive: boolean }
): Promise<{ success: boolean; error?: string }> {
  const worktree = db.getWorktree(params.worktreeId)
  if (worktree?.is_default) {
    return { success: false, error: 'Cannot archive or delete the default worktree' }
  }

  // Run archive script if configured
  const project = worktree?.project_id ? db.getProject(worktree.project_id) : null
  if (project?.archive_script) {
    const commands = [project.archive_script]
    const scriptResult = await scriptRunner.runAndWait(commands, params.worktreePath, 30000)
    if (!scriptResult.success) {
      log.warn('Archive script failed, proceeding anyway', { error: scriptResult.error })
    }
  }

  const gitService = createGitService(params.projectPath)
  const result = params.archive
    ? await gitService.archiveWorktree(params.worktreePath, params.branchName)
    : await gitService.removeWorktree(params.worktreePath)

  if (!result.success) return result

  releasePort(params.worktreePath)
  db.archiveWorktree(params.worktreeId)
  return { success: true }
}

/**
 * Sync DB worktrees with git state.
 */
export async function syncWorktreesOp(
  db: DatabaseService,
  params: { projectId: string; projectPath: string }
): Promise<{ success: boolean; error?: string }> {
  const gitService = createGitService(params.projectPath)
  const gitWorktrees = await gitService.listWorktrees()
  const gitWorktreePaths = new Set(gitWorktrees.map((w) => w.path))
  const gitBranchByPath = new Map(gitWorktrees.map((w) => [w.path, w.branch]))
  const dbWorktrees = db.getActiveWorktreesByProject(params.projectId)

  for (const dbWorktree of dbWorktrees) {
    if (!gitWorktreePaths.has(dbWorktree.path) && !existsSync(dbWorktree.path)) {
      db.archiveWorktree(dbWorktree.id)
      continue
    }
    const gitBranch = gitBranchByPath.get(dbWorktree.path)
    if (gitBranch && gitBranch !== dbWorktree.branch_name && !dbWorktree.branch_renamed) {
      const nameMatchesBranch = dbWorktree.name === dbWorktree.branch_name
      const isAutoName = isAutoNamedBranch(dbWorktree.name.toLowerCase())
      const shouldUpdateName = nameMatchesBranch || isAutoName
      db.updateWorktree(dbWorktree.id, {
        branch_name: gitBranch,
        ...(shouldUpdateName ? { name: gitBranch } : {})
      })
    }
  }

  await gitService.pruneWorktrees()
  return { success: true }
}

/**
 * Duplicate a worktree: create branch from source + copy state.
 */
export async function duplicateWorktreeOp(
  db: DatabaseService,
  params: { projectId: string; projectPath: string; projectName: string; sourceBranch: string; sourceWorktreePath: string }
): Promise<{ success: boolean; worktree?: any; error?: string }> {
  const gitService = createGitService(params.projectPath)
  const result = await gitService.duplicateWorktree(params.sourceBranch, params.sourceWorktreePath, params.projectName)

  if (!result.success || !result.name || !result.path || !result.branchName) {
    return { success: false, error: result.error || 'Failed to duplicate worktree' }
  }

  const worktree = db.createWorktree({
    project_id: params.projectId,
    name: result.name,
    branch_name: result.branchName,
    path: result.path
  })

  const project = db.getProject(params.projectId)
  if (project?.auto_assign_port) {
    assignPort(worktree.path)
  }

  return { success: true, worktree }
}

/**
 * Rename a branch and update DB.
 */
export async function renameWorktreeBranchOp(
  db: DatabaseService,
  params: { worktreeId: string; worktreePath: string; oldBranch: string; newBranch: string }
): Promise<{ success: boolean; error?: string }> {
  const gitService = createGitService(params.worktreePath)
  const result = await gitService.renameBranch(params.worktreePath, params.oldBranch, params.newBranch)
  if (result.success) {
    db.updateWorktree(params.worktreeId, { branch_name: params.newBranch, branch_renamed: 1 })
  }
  return result
}

/**
 * Create a worktree from an existing branch.
 */
export async function createWorktreeFromBranchOp(
  db: DatabaseService,
  params: { projectId: string; projectPath: string; projectName: string; branchName: string }
): Promise<{ success: boolean; worktree?: any; error?: string }> {
  const breedType = getBreedType(db)
  const gitService = createGitService(params.projectPath)
  const result = await gitService.createWorktreeFromBranch(params.projectName, params.branchName, breedType)

  if (!result.success || !result.path) {
    return { success: false, error: result.error || 'Failed to create worktree from branch' }
  }

  const worktree = db.createWorktree({
    project_id: params.projectId,
    name: result.name || params.branchName,
    branch_name: result.branchName || params.branchName,
    path: result.path
  })

  const project = db.getProject(params.projectId)
  if (project?.auto_assign_port) {
    assignPort(worktree.path)
  }

  return { success: true, worktree }
}
```

**Step 2: Update worktree-handlers.ts to call service functions**

Replace inline logic in each `ipcMain.handle` callback with calls to the imported service functions. Each handler becomes a thin wrapper:

```typescript
import {
  createWorktreeOp, deleteWorktreeOp, syncWorktreesOp,
  duplicateWorktreeOp, renameWorktreeBranchOp, createWorktreeFromBranchOp
} from '../services/worktree-ops'
import { getDatabase } from '../db'

// worktree:create handler becomes:
ipcMain.handle('worktree:create', async (_event, params) => {
  try {
    return await createWorktreeOp(getDatabase(), params)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})
```

Apply same pattern for delete, sync, duplicate, renameBranch, createFromBranch. Keep hasCommits, exists, branches, branchExists, openInTerminal, openInEditor as inline handlers (they're already thin or Electron-specific).

**Step 3: Verify**

Run: `pnpm build && pnpm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/main/services/worktree-ops.ts src/main/ipc/worktree-handlers.ts
git commit -m "refactor: extract worktree ops into shared service"
```

---

## Task 6: Extract Connection Ops Service

**Files:**
- Create: `src/main/services/connection-ops.ts`
- Modify: `src/main/ipc/connection-handlers.ts`

**Step 1: Create connection-ops.ts**

The filesystem utilities already exist in `src/main/services/connection-service.ts`. This new file adds the DB+filesystem orchestration layer.

```typescript
// src/main/services/connection-ops.ts
import { join } from 'path'
import { createLogger } from './logger'
import {
  createConnectionDir, deleteConnectionDir,
  createSymlink, removeSymlink, deriveSymlinkName,
  generateConnectionInstructions, generateConnectionColor
} from './connection-service'
import type { DatabaseService } from '../db/database'
import type { ConnectionWithMembers } from '../db/types'
import { randomUUID } from 'crypto'

const log = createLogger({ component: 'ConnectionOps' })

function deriveConnectionName(connection: ConnectionWithMembers): string {
  const projectNames = [...new Set(connection.members.map((m) => m.project_name))]
  return projectNames.join(' + ') || 'Connection'
}

function buildAgentsMdMembers(connection: ConnectionWithMembers) {
  return connection.members.map((m) => ({
    symlinkName: m.symlink_name,
    projectName: m.project_name,
    branchName: m.worktree_branch,
    worktreePath: m.worktree_path
  }))
}

export async function createConnectionOp(
  db: DatabaseService,
  worktreeIds: string[]
): Promise<{ success: boolean; connection?: ConnectionWithMembers; error?: string }> {
  const dirName = randomUUID().slice(0, 8)
  const dirPath = createConnectionDir(dirName)
  const color = generateConnectionColor()
  const connection = db.createConnection({ name: dirName, path: dirPath, color })
  const existingSymlinkNames: string[] = []

  for (const worktreeId of worktreeIds) {
    const worktree = db.getWorktree(worktreeId)
    if (!worktree) continue
    const project = db.getProject(worktree.project_id)
    if (!project) continue
    const symlinkName = deriveSymlinkName(project.name, existingSymlinkNames)
    existingSymlinkNames.push(symlinkName)
    createSymlink(worktree.path, join(dirPath, symlinkName))
    db.createConnectionMember({
      connection_id: connection.id,
      worktree_id: worktreeId,
      project_id: project.id,
      symlink_name: symlinkName
    })
  }

  const enriched = db.getConnection(connection.id)
  if (enriched) {
    db.updateConnection(connection.id, { name: deriveConnectionName(enriched) })
    generateConnectionInstructions(dirPath, buildAgentsMdMembers(enriched))
  }

  const final = db.getConnection(connection.id)
  return { success: true, connection: final ?? undefined }
}

export async function deleteConnectionOp(
  db: DatabaseService,
  connectionId: string
): Promise<{ success: boolean; error?: string }> {
  const connection = db.getConnection(connectionId)
  if (!connection) return { success: false, error: 'Connection not found' }
  deleteConnectionDir(connection.path)
  db.deleteConnection(connectionId)
  return { success: true }
}

export async function addConnectionMemberOp(
  db: DatabaseService,
  connectionId: string,
  worktreeId: string
): Promise<{ success: boolean; member?: any; error?: string }> {
  const connection = db.getConnection(connectionId)
  if (!connection) return { success: false, error: 'Connection not found' }
  const worktree = db.getWorktree(worktreeId)
  if (!worktree) return { success: false, error: 'Worktree not found' }
  const project = db.getProject(worktree.project_id)
  if (!project) return { success: false, error: 'Project not found' }

  const existingNames = connection.members.map((m) => m.symlink_name)
  const symlinkName = deriveSymlinkName(project.name, existingNames)
  createSymlink(worktree.path, join(connection.path, symlinkName))

  const member = db.createConnectionMember({
    connection_id: connectionId,
    worktree_id: worktreeId,
    project_id: project.id,
    symlink_name: symlinkName
  })

  const updated = db.getConnection(connectionId)
  if (updated) {
    db.updateConnection(connectionId, { name: deriveConnectionName(updated) })
    generateConnectionInstructions(updated.path, buildAgentsMdMembers(updated))
  }

  return {
    success: true,
    member: {
      ...member,
      worktree_name: worktree.name,
      worktree_branch: worktree.branch_name,
      worktree_path: worktree.path,
      project_name: project.name
    }
  }
}

export async function removeConnectionMemberOp(
  db: DatabaseService,
  connectionId: string,
  worktreeId: string
): Promise<{ success: boolean; connectionDeleted?: boolean; error?: string }> {
  const connection = db.getConnection(connectionId)
  if (!connection) return { success: false, error: 'Connection not found' }
  const member = connection.members.find((m) => m.worktree_id === worktreeId)
  if (!member) return { success: false, error: 'Member not found in connection' }

  removeSymlink(join(connection.path, member.symlink_name))
  db.deleteConnectionMember(connectionId, worktreeId)

  const remaining = db.getConnection(connectionId)
  if (!remaining || remaining.members.length === 0) {
    deleteConnectionDir(connection.path)
    db.deleteConnection(connectionId)
    return { success: true, connectionDeleted: true }
  }

  db.updateConnection(connectionId, { name: deriveConnectionName(remaining) })
  generateConnectionInstructions(remaining.path, buildAgentsMdMembers(remaining))
  return { success: true, connectionDeleted: false }
}

export async function removeWorktreeFromAllConnectionsOp(
  db: DatabaseService,
  worktreeId: string
): Promise<{ success: boolean; error?: string }> {
  const memberships = db.getConnectionMembersByWorktree(worktreeId)
  if (memberships.length === 0) return { success: true }

  for (const membership of memberships) {
    const connection = db.getConnection(membership.connection_id)
    if (!connection) continue
    const member = connection.members.find((m) => m.worktree_id === worktreeId)
    if (member) {
      removeSymlink(join(connection.path, member.symlink_name))
    }
    db.deleteConnectionMember(membership.connection_id, worktreeId)
    const remaining = db.getConnection(membership.connection_id)
    if (!remaining || remaining.members.length === 0) {
      deleteConnectionDir(connection.path)
      db.deleteConnection(membership.connection_id)
    } else {
      db.updateConnection(membership.connection_id, { name: deriveConnectionName(remaining) })
      generateConnectionInstructions(remaining.path, buildAgentsMdMembers(remaining))
    }
  }
  return { success: true }
}
```

**Step 2: Update connection-handlers.ts**

Replace inline orchestration with calls to `connection-ops.ts`. Keep Electron-specific handlers (openInTerminal, openInEditor) inline.

**Step 3: Verify**

Run: `pnpm build && pnpm test`

**Step 4: Commit**

```bash
git add src/main/services/connection-ops.ts src/main/ipc/connection-handlers.ts
git commit -m "refactor: extract connection ops into shared service"
```

---

## Task 7: System + Settings + File Resolvers

**Files:**
- Create: `src/server/resolvers/query/system.resolvers.ts`
- Create: `src/server/resolvers/mutation/system.resolvers.ts`
- Create: `src/server/resolvers/query/settings.resolvers.ts`
- Create: `src/server/resolvers/query/file.resolvers.ts`
- Create: `src/server/resolvers/query/file-tree.resolvers.ts`
- Create: `src/server/resolvers/mutation/file.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create query/system.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { getLogDir } from '../../main/services/logger'
import { detectAgentSdks, getAppPaths, getAppVersion } from '../../main/services/system-info'

export const systemQueryResolvers: Resolvers = {
  Query: {
    systemLogDir: () => getLogDir(),
    systemAppVersion: () => getAppVersion(),
    systemAppPaths: () => getAppPaths(),
    systemDetectAgentSdks: () => detectAgentSdks(),
    systemServerStatus: () => ({
      uptime: Math.floor(process.uptime()),
      connections: 0,
      requestCount: 0,
      locked: false,
      version: getAppVersion()
    }),
    dbSchemaVersion: async (_parent, _args, ctx) => {
      return ctx.db.getSchemaVersion()
    }
  }
}
```

Note: `dbSchemaVersion` is already in `db.resolvers.ts`. Only add it here if it was NOT already implemented there. Check before adding — if it already exists, omit it from this file to avoid conflicts.

**Step 2: Create mutation/system.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'

export const systemMutationResolvers: Resolvers = {
  Mutation: {
    systemKillSwitch: async (_parent, _args, ctx) => {
      ctx.db.deleteSetting('headless_api_key_hash')
      return true
    },
    systemRegisterPushToken: async (_parent, { token, platform }, ctx) => {
      ctx.db.setSetting('headless_push_token', token)
      ctx.db.setSetting('headless_push_platform', platform)
      return true
    }
  }
}
```

**Step 3: Create query/settings.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { detectEditors, detectTerminals } from '../../main/services/settings-detection'

export const settingsQueryResolvers: Resolvers = {
  Query: {
    detectedEditors: () => detectEditors(),
    detectedTerminals: () => detectTerminals()
  }
}
```

**Step 4: Create query/file.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { readFile, readPromptFile } from '../../main/services/file-ops'

export const fileQueryResolvers: Resolvers = {
  Query: {
    fileRead: async (_parent, { filePath }) => readFile(filePath),
    fileReadPrompt: async (_parent, { promptName }) => readPromptFile(promptName)
  }
}
```

**Step 5: Create query/file-tree.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { existsSync, statSync } from 'fs'
import { scanDirectory, scanSingleDirectory, scanFlat } from '../../main/ipc/file-tree-handlers'

export const fileTreeQueryResolvers: Resolvers = {
  Query: {
    fileTreeScan: async (_parent, { dirPath }) => {
      try {
        if (!existsSync(dirPath)) return { success: false, error: 'Directory does not exist' }
        if (!statSync(dirPath).isDirectory()) return { success: false, error: 'Path is not a directory' }
        const tree = await scanDirectory(dirPath, dirPath)
        return { success: true, tree }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    fileTreeScanFlat: async (_parent, { dirPath }) => {
      try {
        if (!existsSync(dirPath)) return { success: false, error: 'Directory does not exist' }
        if (!statSync(dirPath).isDirectory()) return { success: false, error: 'Path is not a directory' }
        const files = await scanFlat(dirPath)
        return { success: true, files }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    fileTreeLoadChildren: async (_parent, { dirPath, rootPath }) => {
      try {
        if (!existsSync(dirPath)) return { success: false, error: 'Directory does not exist' }
        const children = await scanSingleDirectory(dirPath, rootPath)
        return { success: true, children }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
```

**Step 6: Create mutation/file.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { writeFile } from '../../main/services/file-ops'
import { watchWorktree, unwatchWorktree } from '../../main/services/worktree-watcher'
// Note: file-tree watchers use the chokidar watchers from file-tree-handlers.ts
// For headless mode, we need a separate approach — import from file-tree-handlers if possible
// or create new watcher instances

export const fileMutationResolvers: Resolvers = {
  Mutation: {
    fileWrite: async (_parent, { filePath, content }) => writeFile(filePath, content),
    fileTreeWatch: async (_parent, { worktreePath }) => {
      try {
        // File tree watching for headless — emit via EventBus
        // The file-tree-handlers watcher infrastructure sends to both mainWindow and EventBus
        // For now, import and use the same watch/unwatch functions
        // TODO: Extract watch/unwatch from file-tree-handlers into a service
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    fileTreeUnwatch: async (_parent, { worktreePath }) => {
      try {
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
```

Note on `fileTreeWatch`/`fileTreeUnwatch`: The file-tree watcher in `file-tree-handlers.ts` is tied to `mainWindow`. For headless mode, the watcher needs to emit only via EventBus. The file-tree-handlers already emit to EventBus as a secondary channel. Consider extracting the watcher setup into a service or calling the IPC handler's internal functions. Implementation detail to resolve during coding.

**Step 7: Update resolvers/index.ts**

```typescript
import { systemQueryResolvers } from './query/system.resolvers'
import { systemMutationResolvers } from './mutation/system.resolvers'
import { settingsQueryResolvers } from './query/settings.resolvers'
import { fileQueryResolvers } from './query/file.resolvers'
import { fileTreeQueryResolvers } from './query/file-tree.resolvers'
import { fileMutationResolvers } from './mutation/file.resolvers'

export function mergeResolvers(): Resolvers {
  return deepMerge(
    dbQueryResolvers,
    dbMutationResolvers,
    systemQueryResolvers,
    systemMutationResolvers,
    settingsQueryResolvers,
    fileQueryResolvers,
    fileTreeQueryResolvers,
    fileMutationResolvers
  )
}
```

**Step 8: Verify**

Run: `pnpm build`

**Step 9: Commit**

```bash
git add src/server/resolvers/
git commit -m "feat: add system, settings, file, and file-tree resolvers"
```

---

## Task 8: Project + Worktree Resolvers

**Files:**
- Create: `src/server/resolvers/query/project.resolvers.ts`
- Create: `src/server/resolvers/mutation/project.resolvers.ts`
- Create: `src/server/resolvers/query/worktree.resolvers.ts`
- Create: `src/server/resolvers/mutation/worktree.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create query/project.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  validateProject, isGitRepository, detectProjectLanguage,
  loadLanguageIcons, getIconDataUrl
} from '../../main/services/project-ops'

export const projectQueryResolvers: Resolvers = {
  Query: {
    projectValidate: async (_parent, { path }) => validateProject(path),
    projectIsGitRepository: async (_parent, { path }) => isGitRepository(path),
    projectDetectLanguage: async (_parent, { projectPath }) => detectProjectLanguage(projectPath),
    projectLanguageIcons: () => loadLanguageIcons(),
    projectIconPath: (_parent, { filename }) => getIconDataUrl(filename)
  }
}
```

**Step 2: Create mutation/project.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { initRepository, uploadIcon, removeIcon } from '../../main/services/project-ops'

export const projectMutationResolvers: Resolvers = {
  Mutation: {
    projectInitRepository: async (_parent, { path }) => initRepository(path),
    projectUploadIcon: async (_parent, { projectId, data, filename }) => uploadIcon(projectId, data, filename),
    projectRemoveIcon: async (_parent, { projectId }) => removeIcon(projectId)
  }
}
```

**Step 3: Create query/worktree.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { existsSync } from 'fs'
import { createGitService } from '../../main/services/git-service'

export const worktreeQueryResolvers: Resolvers = {
  Query: {
    worktreeExists: (_parent, { worktreePath }) => existsSync(worktreePath),
    worktreeHasCommits: async (_parent, { projectPath }) => {
      try {
        const gitService = createGitService(projectPath)
        return await gitService.hasCommits()
      } catch {
        return false
      }
    },
    gitBranches: async (_parent, { projectPath }) => {
      try {
        const gitService = createGitService(projectPath)
        const branches = await gitService.getAllBranches()
        const currentBranch = await gitService.getCurrentBranch()
        return { success: true, branches, currentBranch }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitBranchExists: async (_parent, { projectPath, branchName }) => {
      try {
        const gitService = createGitService(projectPath)
        return await gitService.branchExists(branchName)
      } catch {
        return false
      }
    }
  }
}
```

**Step 4: Create mutation/worktree.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  createWorktreeOp, deleteWorktreeOp, syncWorktreesOp,
  duplicateWorktreeOp, renameWorktreeBranchOp, createWorktreeFromBranchOp
} from '../../main/services/worktree-ops'

// Reuse the mapWorktree function from db.resolvers.ts pattern
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapWorktree(row: any) {
  if (!row) return null
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branchName: row.branch_name,
    path: row.path,
    status: row.status,
    isDefault: Boolean(row.is_default),
    branchRenamed: row.branch_renamed ?? 0,
    lastMessageAt: row.last_message_at,
    sessionTitles: row.session_titles ?? '[]',
    lastModelProviderId: row.last_model_provider_id,
    lastModelId: row.last_model_id,
    lastModelVariant: row.last_model_variant,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at
  }
}

export const worktreeMutationResolvers: Resolvers = {
  Mutation: {
    createWorktree: async (_parent, { input }, ctx) => {
      try {
        const result = await createWorktreeOp(ctx.db, input)
        return { success: result.success, worktree: result.worktree ? mapWorktree(result.worktree) : null, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    deleteWorktree: async (_parent, { input }, ctx) => {
      try {
        return await deleteWorktreeOp(ctx.db, {
          worktreeId: input.worktreeId,
          worktreePath: input.worktreePath,
          branchName: input.branchName,
          projectPath: input.projectPath,
          archive: input.archive
        })
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    syncWorktrees: async (_parent, { projectId, projectPath }, ctx) => {
      try {
        return await syncWorktreesOp(ctx.db, { projectId, projectPath })
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    duplicateWorktree: async (_parent, { input }, ctx) => {
      try {
        const result = await duplicateWorktreeOp(ctx.db, input)
        return { success: result.success, worktree: result.worktree ? mapWorktree(result.worktree) : null, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    renameWorktreeBranch: async (_parent, { input }, ctx) => {
      try {
        return await renameWorktreeBranchOp(ctx.db, input)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    createWorktreeFromBranch: async (_parent, { input }, ctx) => {
      try {
        const result = await createWorktreeFromBranchOp(ctx.db, input)
        return { success: result.success, worktree: result.worktree ? mapWorktree(result.worktree) : null, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
```

**Step 5: Update resolvers/index.ts**

Add all four new resolver imports and merge them.

**Step 6: Verify**

Run: `pnpm build`

**Step 7: Commit**

```bash
git add src/server/resolvers/
git commit -m "feat: add project and worktree operation resolvers"
```

---

## Task 9: Git Query Resolvers

**Files:**
- Create: `src/server/resolvers/query/git.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create query/git.resolvers.ts**

All git query resolvers follow the same thin-wrapper pattern over GitService:

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { createGitService } from '../../main/services/git-service'
import { readFile } from 'fs/promises'
import { join, existsSync } from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const gitQueryResolvers: Resolvers = {
  Query: {
    gitFileStatuses: async (_parent, { worktreePath }) => {
      try {
        if (!existsSync(join(worktreePath, '.git'))) {
          return { success: true, files: [] }
        }
        const gitService = createGitService(worktreePath)
        return await gitService.getFileStatuses()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitDiff: async (_parent, { input }) => {
      try {
        const gitService = createGitService(input.worktreePath)
        if (input.isUntracked) {
          return await gitService.getUntrackedFileDiff(input.filePath)
        }
        return await gitService.getDiff(input.filePath, input.staged, input.contextLines ?? undefined)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitDiffStat: async (_parent, { worktreePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getDiffStat()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitFileContent: async (_parent, { worktreePath, filePath }) => {
      try {
        const fullPath = join(worktreePath, filePath)
        const content = await readFile(fullPath, 'utf-8')
        return { success: true, content }
      } catch (error) {
        return { success: false, content: null, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitRefContent: async (_parent, { worktreePath, ref, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRefContent(ref, filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitBranchInfo: async (_parent, { worktreePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getBranchInfo()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitBranchesWithStatus: async (_parent, { projectPath }) => {
      try {
        const gitService = createGitService(projectPath)
        const branches = await gitService.listBranchesWithStatus()
        return { success: true, branches }
      } catch (error) {
        return { success: false, branches: [], error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitIsBranchMerged: async (_parent, { worktreePath, branch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.isBranchMerged(branch)
      } catch (error) {
        return { success: false, isMerged: false }
      }
    },

    gitRemoteUrl: async (_parent, { worktreePath, remote }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.getRemoteUrl(remote || 'origin')
      } catch (error) {
        return { success: false, url: null, remote: null, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    gitListPRs: async (_parent, { projectPath }) => {
      try {
        await execAsync('git fetch origin', { cwd: projectPath })
        const { stdout } = await execAsync(
          'gh pr list --json number,title,author,headRefName --state open --limit 100',
          { cwd: projectPath }
        )
        const raw = JSON.parse(stdout) as Array<{ number: number; title: string; author: { login: string }; headRefName: string }>
        const prs = raw.map((pr) => ({ number: pr.number, title: pr.title, author: pr.author.login, headRefName: pr.headRefName }))
        return { success: true, prs }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('gh: command not found') || message.includes('not found')) {
          return { success: false, prs: [], error: 'GitHub CLI (gh) is not installed' }
        }
        return { success: false, prs: [], error: message }
      }
    }
  }
}
```

**Step 2: Update resolvers/index.ts**

**Step 3: Verify**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/server/resolvers/
git commit -m "feat: add git query resolvers"
```

---

## Task 10: Git Mutation Resolvers

**Files:**
- Create: `src/server/resolvers/mutation/git.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create mutation/git.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import { createGitService, parseWorktreeForBranch } from '../../main/services/git-service'
import { watchWorktree, unwatchWorktree } from '../../main/services/worktree-watcher'
import { watchBranch, unwatchBranch } from '../../main/services/branch-watcher'
import { getEventBus } from '../event-bus'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const gitMutationResolvers: Resolvers = {
  Mutation: {
    // --- Staging ---
    gitStageFile: async (_parent, { worktreePath, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageFile(filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitUnstageFile: async (_parent, { worktreePath, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageFile(filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitStageAll: async (_parent, { worktreePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageAll()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitUnstageAll: async (_parent, { worktreePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageAll()
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitStageHunk: async (_parent, { worktreePath, patch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.stageHunk(patch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitUnstageHunk: async (_parent, { worktreePath, patch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.unstageHunk(patch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitRevertHunk: async (_parent, { worktreePath, patch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.revertHunk(patch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    // --- Commit & Push ---
    gitDiscardChanges: async (_parent, { worktreePath, filePath }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.discardChanges(filePath)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitAddToGitignore: async (_parent, { worktreePath, pattern }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.addToGitignore(pattern)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitCommit: async (_parent, { worktreePath, message }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.commit(message)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitPush: async (_parent, { input }) => {
      try {
        const gitService = createGitService(input.worktreePath)
        return await gitService.push(input.remote ?? undefined, input.branch ?? undefined, input.force ?? undefined)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitPull: async (_parent, { input }) => {
      try {
        const gitService = createGitService(input.worktreePath)
        return await gitService.pull(input.remote ?? undefined, input.branch ?? undefined, input.rebase ?? undefined)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },

    // --- Merge & Branch ---
    gitMerge: async (_parent, { worktreePath, sourceBranch }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.merge(sourceBranch)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitDeleteBranch: async (_parent, { worktreePath, branchName }) => {
      try {
        const gitService = createGitService(worktreePath)
        return await gitService.deleteBranch(branchName)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitPrMerge: async (_parent, { worktreePath, prNumber }) => {
      try {
        await execAsync(`gh pr merge ${prNumber} --merge`, { cwd: worktreePath })
        const prInfoResult = await execAsync(`gh pr view ${prNumber} --json baseRefName -q '.baseRefName'`, { cwd: worktreePath })
        const targetBranch = prInfoResult.stdout.trim()
        const worktreeListResult = await execAsync('git worktree list --porcelain', { cwd: worktreePath })
        const targetWorktreePath = parseWorktreeForBranch(worktreeListResult.stdout, targetBranch)
        if (targetWorktreePath) {
          const currentBranch = await execAsync('git branch --show-current', { cwd: worktreePath })
          await execAsync(`git merge ${currentBranch.stdout.trim()}`, { cwd: targetWorktreePath })
        }
        try { getEventBus().emit('git:statusChanged', { worktreePath }) } catch { /* */ }
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    // --- Watching ---
    gitWatchWorktree: async (_parent, { worktreePath }) => {
      try {
        await watchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitUnwatchWorktree: async (_parent, { worktreePath }) => {
      try {
        await unwatchWorktree(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitWatchBranch: async (_parent, { worktreePath }) => {
      try {
        await watchBranch(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    gitUnwatchBranch: async (_parent, { worktreePath }) => {
      try {
        await unwatchBranch(worktreePath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
```

**Step 2: Update resolvers/index.ts**

**Step 3: Verify**

Run: `pnpm build`

**Step 4: Commit**

```bash
git add src/server/resolvers/
git commit -m "feat: add git mutation resolvers (staging, commit, push, merge, watching)"
```

---

## Task 11: Connection Resolvers

**Files:**
- Create: `src/server/resolvers/query/connection.resolvers.ts`
- Create: `src/server/resolvers/mutation/connection.resolvers.ts`
- Modify: `src/server/resolvers/index.ts`

**Step 1: Create query/connection.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapConnection(row: any) {
  if (!row) return null
  return {
    id: row.id,
    name: row.custom_name || row.name,
    status: row.status,
    path: row.path,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members: (row.members || []).map((m: any) => ({
      id: m.id,
      connectionId: m.connection_id,
      worktreeId: m.worktree_id,
      projectId: m.project_id,
      symlinkName: m.symlink_name,
      addedAt: m.added_at,
      worktreeName: m.worktree_name,
      worktreeBranch: m.worktree_branch,
      worktreePath: m.worktree_path,
      projectName: m.project_name
    }))
  }
}

export const connectionQueryResolvers: Resolvers = {
  Query: {
    connections: async (_parent, _args, ctx) => {
      return ctx.db.getAllConnections().map(mapConnection)
    },
    connection: async (_parent, { connectionId }, ctx) => {
      return mapConnection(ctx.db.getConnection(connectionId))
    }
  }
}
```

**Step 2: Create mutation/connection.resolvers.ts**

```typescript
import type { Resolvers } from '../../__generated__/resolvers-types'
import {
  createConnectionOp, deleteConnectionOp,
  addConnectionMemberOp, removeConnectionMemberOp,
  removeWorktreeFromAllConnectionsOp
} from '../../main/services/connection-ops'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapConnection(row: any) {
  if (!row) return null
  return {
    id: row.id,
    name: row.custom_name || row.name,
    status: row.status,
    path: row.path,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    members: (row.members || []).map((m: any) => ({
      id: m.id,
      connectionId: m.connection_id,
      worktreeId: m.worktree_id,
      projectId: m.project_id,
      symlinkName: m.symlink_name,
      addedAt: m.added_at,
      worktreeName: m.worktree_name,
      worktreeBranch: m.worktree_branch,
      worktreePath: m.worktree_path,
      projectName: m.project_name
    }))
  }
}

export const connectionMutationResolvers: Resolvers = {
  Mutation: {
    createConnection: async (_parent, { worktreeIds }, ctx) => {
      try {
        const result = await createConnectionOp(ctx.db, worktreeIds)
        return { success: result.success, connection: result.connection ? mapConnection(result.connection) : null, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    deleteConnection: async (_parent, { connectionId }, ctx) => {
      try {
        return await deleteConnectionOp(ctx.db, connectionId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    renameConnection: async (_parent, { connectionId, customName }, ctx) => {
      try {
        const existing = ctx.db.getConnection(connectionId)
        if (!existing) return null
        ctx.db.updateConnection(connectionId, { custom_name: customName || null })
        return mapConnection(ctx.db.getConnection(connectionId))
      } catch {
        return null
      }
    },
    addConnectionMember: async (_parent, { connectionId, worktreeId }, ctx) => {
      try {
        const result = await addConnectionMemberOp(ctx.db, connectionId, worktreeId)
        return { success: result.success, member: result.member ?? null, error: result.error }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    removeConnectionMember: async (_parent, { connectionId, worktreeId }, ctx) => {
      try {
        return await removeConnectionMemberOp(ctx.db, connectionId, worktreeId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    },
    removeWorktreeFromAllConnections: async (_parent, { worktreeId }, ctx) => {
      try {
        return await removeWorktreeFromAllConnectionsOp(ctx.db, worktreeId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  }
}
```

**Step 3: Update resolvers/index.ts with final resolver imports**

**Step 4: Verify**

Run: `pnpm build`

**Step 5: Commit**

```bash
git add src/server/resolvers/
git commit -m "feat: add connection query and mutation resolvers"
```

---

## Task 12: Integration Tests

**Files:**
- Create: `test/server/integration/operations.test.ts`
- Modify: `test/server/helpers/mock-db.ts` (add connection methods)

**Step 1: Add connection methods to MockDatabaseService**

The mock DB needs `createConnection`, `getConnection`, `getAllConnections`, `updateConnection`, `deleteConnection`, `createConnectionMember`, `deleteConnectionMember`, `getConnectionMembersByWorktree` methods. Add these following the existing mock pattern.

**Step 2: Create operations.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { createTestServer } from '../helpers/test-server'
import { MockDatabaseService } from '../helpers/mock-db'

describe('Operation Resolvers', () => {
  let mockDb: MockDatabaseService
  let server: ReturnType<typeof createTestServer>

  beforeEach(() => {
    mockDb = new MockDatabaseService()
    server = createTestServer(mockDb)
  })

  describe('System Queries', () => {
    it('systemAppVersion returns a string', async () => {
      const { data } = await server.execute('{ systemAppVersion }')
      expect(typeof data?.systemAppVersion).toBe('string')
    })

    it('systemAppPaths returns all fields', async () => {
      const { data } = await server.execute('{ systemAppPaths { userData home logs } }')
      expect(data?.systemAppPaths).toHaveProperty('userData')
      expect(data?.systemAppPaths).toHaveProperty('home')
      expect(data?.systemAppPaths).toHaveProperty('logs')
    })

    it('systemDetectAgentSdks returns booleans', async () => {
      const { data } = await server.execute('{ systemDetectAgentSdks { opencode claude } }')
      expect(typeof data?.systemDetectAgentSdks?.opencode).toBe('boolean')
      expect(typeof data?.systemDetectAgentSdks?.claude).toBe('boolean')
    })

    it('systemServerStatus returns expected shape', async () => {
      const { data } = await server.execute('{ systemServerStatus { uptime connections version } }')
      expect(typeof data?.systemServerStatus?.uptime).toBe('number')
      expect(typeof data?.systemServerStatus?.version).toBe('string')
    })

    it('dbSchemaVersion returns a number', async () => {
      const { data } = await server.execute('{ dbSchemaVersion }')
      expect(typeof data?.dbSchemaVersion).toBe('number')
    })
  })

  describe('System Mutations', () => {
    it('systemRegisterPushToken stores token', async () => {
      const { data } = await server.execute(`
        mutation { systemRegisterPushToken(token: "test-token", platform: "ios") }
      `)
      expect(data?.systemRegisterPushToken).toBe(true)
      expect(mockDb.getSetting('headless_push_token')).toBe('test-token')
      expect(mockDb.getSetting('headless_push_platform')).toBe('ios')
    })

    it('systemKillSwitch deletes API key hash', async () => {
      mockDb.setSetting('headless_api_key_hash', 'some-hash')
      const { data } = await server.execute('mutation { systemKillSwitch }')
      expect(data?.systemKillSwitch).toBe(true)
      expect(mockDb.getSetting('headless_api_key_hash')).toBeNull()
    })
  })

  describe('Settings Queries', () => {
    it('detectedEditors returns array of DetectedApp', async () => {
      const { data } = await server.execute('{ detectedEditors { id name command available } }')
      expect(Array.isArray(data?.detectedEditors)).toBe(true)
      if (data?.detectedEditors.length > 0) {
        expect(data.detectedEditors[0]).toHaveProperty('id')
        expect(data.detectedEditors[0]).toHaveProperty('name')
      }
    })

    it('detectedTerminals returns array', async () => {
      const { data } = await server.execute('{ detectedTerminals { id name available } }')
      expect(Array.isArray(data?.detectedTerminals)).toBe(true)
    })
  })

  // Note: File, FileTree, Git, Project, Worktree, and Connection resolver tests
  // require real filesystem/git operations or more sophisticated mocks.
  // Add targeted tests as needed. The above tests verify the resolver wiring
  // works correctly with the service layer.
})
```

**Step 3: Run tests**

Run: `pnpm vitest run test/server/integration/operations.test.ts`
Expected: All tests pass.

**Step 4: Verify full test suite**

Run: `pnpm build && pnpm test`
Expected: All pass.

**Step 5: Commit**

```bash
git add test/server/
git commit -m "test: add integration tests for Phase 5 operation resolvers"
```

---

## Task 13: Final Verification

**Step 1: Full build + test**

Run: `pnpm build && pnpm test`
Expected: Clean build, all tests pass.

**Step 2: Lint**

Run: `pnpm lint`
Fix any issues.

**Step 3: Final commit if any fixes needed**

---

## Summary of Files

### Created (20 files)

```
src/main/services/
  settings-detection.ts          — Editor/terminal detection
  system-info.ts                 — Agent SDK detection, app paths
  project-ops.ts                 — Project validation, icons, language
  file-ops.ts                    — File read/write
  worktree-ops.ts                — Worktree lifecycle orchestration
  connection-ops.ts              — Connection lifecycle orchestration

src/server/resolvers/
  query/
    system.resolvers.ts          — System queries
    project.resolvers.ts         — Project operation queries
    worktree.resolvers.ts        — Worktree operation queries
    git.resolvers.ts             — Git queries
    file.resolvers.ts            — File read queries
    file-tree.resolvers.ts       — File tree queries
    settings.resolvers.ts        — Settings detection queries
    connection.resolvers.ts      — Connection queries
  mutation/
    system.resolvers.ts          — System mutations
    project.resolvers.ts         — Project operation mutations
    worktree.resolvers.ts        — Worktree operation mutations
    git.resolvers.ts             — Git mutations
    file.resolvers.ts            — File write + tree watch mutations
    connection.resolvers.ts      — Connection mutations

test/server/integration/
  operations.test.ts             — Integration tests
```

### Modified (7 files)

| File | Change |
|------|--------|
| `src/server/resolvers/index.ts` | Import and merge all new resolvers |
| `src/main/ipc/worktree-handlers.ts` | Call worktree-ops service |
| `src/main/ipc/connection-handlers.ts` | Call connection-ops service |
| `src/main/ipc/settings-handlers.ts` | Import from settings-detection service |
| `src/main/ipc/project-handlers.ts` | Import from project-ops service |
| `src/main/ipc/file-handlers.ts` | Import from file-ops service |
| `test/server/helpers/mock-db.ts` | Add connection mock methods |
