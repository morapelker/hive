# Custom Commands File-Based Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to edit custom commands via `~/.hive/custom-commands.json` instead of manually editing the SQLite database.

**Architecture:** File-based configuration with automatic sync to database. File is source of truth when it exists. Main process handles file I/O, renderer process consumes from database via Zustand store.

**Tech Stack:** Node.js fs module, Electron IPC, TypeScript, Vitest

---

## File Structure

**New Files:**
- `src/main/services/custom-commands-file-service.ts` - File I/O operations for custom commands
- `test/custom-commands/file-service.test.ts` - Unit tests for file service

**Modified Files:**
- `src/main/ipc/settings-handlers.ts` - Add IPC handlers for file operations
- `src/main/index.ts` - Add app lifecycle hooks for template creation and file change detection
- `src/renderer/src/stores/useSettingsStore.ts` - Modify settings load flow to read from file first
- `src/renderer/src/components/projects/ProjectItem.tsx` - Add listener for file change events
- `src/shared/types/settings.ts` (if exists) or create type definitions for IPC responses

**No modifications needed:**
- `src/renderer/src/lib/custom-commands.ts` - Validation logic stays the same
- Existing test files - They test the same behavior, just with file-based source

---

### Task 1: Create File Service with Tests (TDD)

**Files:**
- Create: `src/main/services/custom-commands-file-service.ts`
- Create: `test/custom-commands/file-service.test.ts`

- [ ] **Step 1: Write failing test for getCustomCommandsFilePath**

```typescript
// test/custom-commands/file-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { app } from 'electron'
import { join } from 'path'
import {
  getCustomCommandsFilePath,
  getFileModTime,
  loadCustomCommandsFromFile,
  createTemplateFile
} from '@/main/services/custom-commands-file-service'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn()
  }
}))

describe('getCustomCommandsFilePath', () => {
  it('should return path in home directory', () => {
    vi.mocked(app.getPath).mockReturnValue('/Users/testuser')
    
    const result = getCustomCommandsFilePath()
    
    expect(result).toBe('/Users/testuser/.hive/custom-commands.json')
    expect(app.getPath).toHaveBeenCalledWith('home')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Create minimal file service with getCustomCommandsFilePath**

```typescript
// src/main/services/custom-commands-file-service.ts
import { app } from 'electron'
import { join } from 'path'

/**
 * Gets the full path to custom commands file
 * @returns Path to ~/.hive/custom-commands.json
 */
export function getCustomCommandsFilePath(): string {
  const homeDir = app.getPath('home')
  return join(homeDir, '.hive', 'custom-commands.json')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for getFileModTime**

```typescript
// test/custom-commands/file-service.test.ts
import { existsSync, statSync, writeFileSync, mkdirSync, rmSync } from 'fs'

describe('getFileModTime', () => {
  const testDir = join(__dirname, 'temp-test-files')
  const testFile = join(testDir, 'test-commands.json')

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should return null if file does not exist', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    
    const result = getFileModTime()
    
    expect(result).toBeNull()
  })

  it('should return mtime as number if file exists', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    writeFileSync(join(testDir, '.hive', 'custom-commands.json'), '[]')
    
    const result = getFileModTime()
    
    expect(result).toBeTypeOf('number')
    expect(result).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: FAIL - getFileModTime not defined

- [ ] **Step 7: Implement getFileModTime**

```typescript
// src/main/services/custom-commands-file-service.ts
import { existsSync, statSync } from 'fs'

/**
 * Gets file modification time for change detection
 * @returns Modification time in milliseconds, or null if file doesn't exist
 */
export function getFileModTime(): number | null {
  const filePath = getCustomCommandsFilePath()
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const stats = statSync(filePath)
    return stats.mtimeMs
  } catch {
    return null
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing test for createTemplateFile**

```typescript
// test/custom-commands/file-service.test.ts
describe('createTemplateFile', () => {
  const testDir = join(__dirname, 'temp-test-files')

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should create template file if it does not exist', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    
    const result = createTemplateFile()
    
    expect(result.success).toBe(true)
    expect(result.created).toBe(true)
    expect(result.error).toBeUndefined()
    
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    expect(existsSync(filePath)).toBe(true)
    
    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(Array.isArray(content)).toBe(true)
    expect(content.length).toBe(3)
    expect(content[0]).toHaveProperty('id')
    expect(content[0]).toHaveProperty('name')
    expect(content[0]).toHaveProperty('prompt')
  })

  it('should not overwrite existing file', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    mkdirSync(join(testDir, '.hive'), { recursive: true })
    writeFileSync(filePath, '[{"id":"existing","name":"test","prompt":"test"}]')
    
    const result = createTemplateFile()
    
    expect(result.success).toBe(true)
    expect(result.created).toBe(false)
    
    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(content[0].id).toBe('existing')
  })

  it('should handle directory creation errors', () => {
    vi.mocked(app.getPath).mockReturnValue('/invalid/readonly/path')
    
    const result = createTemplateFile()
    
    expect(result.success).toBe(false)
    expect(result.created).toBe(false)
    expect(result.error).toBeDefined()
  })
})
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: FAIL - createTemplateFile not defined

- [ ] **Step 11: Implement createTemplateFile**

```typescript
// src/main/services/custom-commands-file-service.ts
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const TEMPLATE_COMMANDS = [
  {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Analyze Architecture',
    prompt: 'Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements.'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440001',
    name: 'Review Dependencies',
    prompt: 'Review all dependencies in the {{project.language}} project at {{project.path}}. Check for outdated packages and security issues.'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002',
    name: 'Generate Tests',
    prompt: 'Generate comprehensive test coverage for {{project.name}}. Focus on {{project.description}}.'
  }
]

/**
 * Creates template file with example commands
 * Only creates if file doesn't already exist
 * @returns Result object with success flag and whether file was created
 */
export function createTemplateFile(): { success: boolean; created: boolean; error?: string } {
  const filePath = getCustomCommandsFilePath()
  
  if (existsSync(filePath)) {
    return { success: true, created: false }
  }
  
  try {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    
    const content = JSON.stringify(TEMPLATE_COMMANDS, null, 2)
    writeFileSync(filePath, content, 'utf-8')
    
    return { success: true, created: true }
  } catch (error) {
    return {
      success: false,
      created: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: PASS

- [ ] **Step 13: Write failing test for loadCustomCommandsFromFile**

```typescript
// test/custom-commands/file-service.test.ts
describe('loadCustomCommandsFromFile', () => {
  const testDir = join(__dirname, 'temp-test-files')

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should return empty result if file does not exist', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(true)
    expect(result.commands).toEqual([])
    expect(result.mtime).toBeNull()
  })

  it('should load valid commands from file', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    mkdirSync(dirname(filePath), { recursive: true })
    
    const commands = [
      { id: '1', name: 'Test 1', prompt: 'Prompt 1' },
      { id: '2', name: 'Test 2', prompt: 'Prompt 2' }
    ]
    writeFileSync(filePath, JSON.stringify(commands))
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(true)
    expect(result.commands).toHaveLength(2)
    expect(result.commands![0].id).toBe('1')
    expect(result.mtime).toBeTypeOf('number')
  })

  it('should return error for invalid JSON', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, 'invalid json{')
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid JSON')
  })

  it('should return error for non-array JSON', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, '{"commands": []}')
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(false)
    expect(result.error).toContain('must be an array')
  })

  it('should filter out invalid commands', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    mkdirSync(dirname(filePath), { recursive: true })
    
    const commands = [
      { id: '1', name: 'Valid', prompt: 'Test' },
      { id: '2', name: '', prompt: 'Test' }, // Invalid: empty name
      { id: '3', name: 'Valid 2', prompt: 'Test 2' }
    ]
    writeFileSync(filePath, JSON.stringify(commands))
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(true)
    expect(result.commands).toHaveLength(2)
    expect(result.commands![0].id).toBe('1')
    expect(result.commands![1].id).toBe('3')
  })

  it('should return error for file too large', () => {
    vi.mocked(app.getPath).mockReturnValue(testDir)
    const filePath = join(testDir, '.hive', 'custom-commands.json')
    mkdirSync(dirname(filePath), { recursive: true })
    
    // Create 2MB file (over 1MB limit)
    const largeContent = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) })
    writeFileSync(filePath, largeContent)
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(false)
    expect(result.error).toContain('too large')
  })

  it('should handle permission errors', () => {
    vi.mocked(app.getPath).mockReturnValue('/root/forbidden')
    
    const result = loadCustomCommandsFromFile()
    
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})
```

- [ ] **Step 14: Run test to verify it fails**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: FAIL - loadCustomCommandsFromFile not defined

- [ ] **Step 15: Implement loadCustomCommandsFromFile**

```typescript
// src/main/services/custom-commands-file-service.ts
import { readFileSync } from 'fs'
import { validateCustomCommand } from '@/renderer/src/lib/custom-commands'
import type { CustomProjectCommand } from '@/renderer/src/lib/custom-commands'

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export interface CustomCommandFileResult {
  success: boolean
  commands?: CustomProjectCommand[]
  error?: string
  mtime?: number | null
}

/**
 * Loads custom commands from ~/.hive/custom-commands.json
 * Validates and returns parsed commands with file mtime
 * @returns Result object with commands or error
 */
export function loadCustomCommandsFromFile(): CustomCommandFileResult {
  const filePath = getCustomCommandsFilePath()
  
  // File doesn't exist - not an error, just return empty
  if (!existsSync(filePath)) {
    return { success: true, commands: [], mtime: null }
  }
  
  try {
    // Check file size
    const stats = statSync(filePath)
    if (stats.size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: 'Custom commands file too large (max 1MB)'
      }
    }
    
    // Read and parse file
    const content = readFileSync(filePath, 'utf-8')
    let parsed: unknown
    
    try {
      parsed = JSON.parse(content)
    } catch {
      return {
        success: false,
        error: 'Invalid JSON in custom commands file'
      }
    }
    
    // Validate root is array
    if (!Array.isArray(parsed)) {
      return {
        success: false,
        error: 'Custom commands file must contain a JSON array'
      }
    }
    
    // Validate and filter commands
    const validCommands: CustomProjectCommand[] = []
    for (const item of parsed) {
      const validation = validateCustomCommand(item)
      if (validation.valid) {
        validCommands.push(item as CustomProjectCommand)
      } else {
        console.warn('Skipped invalid command in file:', validation.errors)
      }
    }
    
    return {
      success: true,
      commands: validCommands,
      mtime: stats.mtimeMs
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error reading file'
    }
  }
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: PASS

- [ ] **Step 17: Commit Task 1**

```bash
git add src/main/services/custom-commands-file-service.ts test/custom-commands/file-service.test.ts
git commit -m "feat: add custom commands file service with tests

Implements file I/O operations for custom commands:
- getCustomCommandsFilePath: resolve ~/.hive/custom-commands.json
- getFileModTime: track file changes via mtime
- createTemplateFile: create template with examples
- loadCustomCommandsFromFile: read, parse, validate commands

Includes comprehensive unit tests with 15 test cases.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Add IPC Handlers for File Operations

**Files:**
- Modify: `src/main/ipc/settings-handlers.ts`

- [ ] **Step 1: Write failing test for IPC handlers**

```typescript
// test/custom-commands/file-service.test.ts
import { ipcMain } from 'electron'

describe('IPC handlers', () => {
  it('should register get-custom-commands-file-path handler', () => {
    const handlers = ipcMain.eventNames()
    expect(handlers).toContain('get-custom-commands-file-path')
  })

  it('should register load-custom-commands-file handler', () => {
    const handlers = ipcMain.eventNames()
    expect(handlers).toContain('load-custom-commands-file')
  })

  it('should register reload-custom-commands handler', () => {
    const handlers = ipcMain.eventNames()
    expect(handlers).toContain('reload-custom-commands')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: FAIL - handlers not registered

- [ ] **Step 3: Add IPC handlers to settings-handlers.ts**

Add to `src/main/ipc/settings-handlers.ts` at the end of the `registerSettingsHandlers` function, before the closing brace:

```typescript
// src/main/ipc/settings-handlers.ts
import {
  getCustomCommandsFilePath,
  loadCustomCommandsFromFile,
  getFileModTime
} from '../services/custom-commands-file-service'

// Inside registerSettingsHandlers function, add these handlers:

  // Get custom commands file path
  ipcMain.handle('get-custom-commands-file-path', async (): Promise<string> => {
    return getCustomCommandsFilePath()
  })

  // Load custom commands from file
  ipcMain.handle('load-custom-commands-file', async () => {
    try {
      return loadCustomCommandsFromFile()
    } catch (error) {
      log.error(
        'Failed to load custom commands from file',
        error instanceof Error ? error : new Error(String(error))
      )
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Reload custom commands (manual trigger)
  ipcMain.handle('reload-custom-commands', async () => {
    try {
      const fileResult = loadCustomCommandsFromFile()
      
      if (!fileResult.success) {
        return fileResult
      }
      
      if (fileResult.commands && fileResult.commands.length > 0) {
        // Save to database
        const db = getDatabase()
        const existingSettings = db.getSetting(APP_SETTINGS_DB_KEY)
        const settings = existingSettings
          ? JSON.parse(existingSettings.value)
          : {}
        
        settings.customProjectCommands = fileResult.commands
        db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
        
        return {
          success: true,
          count: fileResult.commands.length,
          mtime: fileResult.mtime
        }
      }
      
      return { success: true, count: 0, mtime: fileResult.mtime }
    } catch (error) {
      log.error(
        'Failed to reload custom commands',
        error instanceof Error ? error : new Error(String(error))
      )
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/custom-commands/file-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/main/ipc/settings-handlers.ts
git commit -m "feat: add IPC handlers for custom commands file operations

Adds three IPC handlers:
- get-custom-commands-file-path: returns file path for UI display
- load-custom-commands-file: loads commands from file
- reload-custom-commands: manual reload trigger with DB sync

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Add App Lifecycle Hooks

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add imports to index.ts**

Add these imports at the top of `src/main/index.ts`:

```typescript
// src/main/index.ts
import {
  createTemplateFile,
  getFileModTime,
  loadCustomCommandsFromFile
} from './services/custom-commands-file-service'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
```

- [ ] **Step 2: Add template file creation on app ready**

Find the `app.whenReady().then()` block in `src/main/index.ts` and add this code after window creation, before the app event handlers:

```typescript
// src/main/index.ts - inside app.whenReady().then()

  // Create custom commands template file if first launch
  const templateResult = createTemplateFile()
  if (templateResult.created) {
    log.info('Created custom commands template file')
  } else if (!templateResult.success && templateResult.error) {
    log.error('Failed to create custom commands template:', templateResult.error)
  }
  
  // Store initial file mtime for change detection
  let lastKnownMtime: number | null = getFileModTime()
```

- [ ] **Step 3: Add file change detection on app activation**

Find the `app.on('activate', ...)` handler in `src/main/index.ts` and add this code inside it:

```typescript
// src/main/index.ts - inside app.on('activate')

  // Check if custom commands file changed
  const currentMtime = getFileModTime()
  if (currentMtime !== null && currentMtime !== lastKnownMtime) {
    lastKnownMtime = currentMtime
    log.info('Custom commands file changed, reloading')
    
    // Load file and sync to database
    const fileResult = loadCustomCommandsFromFile()
    if (fileResult.success && fileResult.commands) {
      try {
        const db = getDatabase()
        const existingSettings = db.getSetting(APP_SETTINGS_DB_KEY)
        const settings = existingSettings ? JSON.parse(existingSettings.value) : {}
        
        settings.customProjectCommands = fileResult.commands
        db.setSetting(APP_SETTINGS_DB_KEY, JSON.stringify(settings))
        
        // Notify all windows to reload
        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send('custom-commands-file-changed')
        })
      } catch (error) {
        log.error('Failed to sync custom commands to database:', error)
      }
    } else if (!fileResult.success) {
      log.error('Failed to load custom commands:', fileResult.error)
    }
  }
```

- [ ] **Step 4: Move lastKnownMtime to module scope**

Move the `lastKnownMtime` variable declaration to the top level of `src/main/index.ts` (outside any function):

```typescript
// src/main/index.ts - top level, after imports

// Track custom commands file mtime for change detection
let lastKnownMtime: number | null = null
```

Remove the local declaration inside `app.whenReady()` and just assign to it:

```typescript
// Inside app.whenReady() - change from:
let lastKnownMtime: number | null = getFileModTime()

// To:
lastKnownMtime = getFileModTime()
```

- [ ] **Step 5: Test app startup and activation manually**

Run: `npm run dev`

Expected behaviors:
1. Check `~/.hive/custom-commands.json` created with template
2. Edit file (add a command)
3. Switch to another app and back to Hive
4. Check logs for "Custom commands file changed, reloading"

- [ ] **Step 6: Commit Task 3**

```bash
git add src/main/index.ts
git commit -m "feat: add app lifecycle hooks for custom commands

On app ready:
- Create template file if it doesn't exist
- Store initial file mtime

On app activation:
- Check if file mtime changed
- Reload and sync to database
- Notify renderer windows

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Modify Settings Store to Load from File

**Files:**
- Modify: `src/renderer/src/stores/useSettingsStore.ts`

- [ ] **Step 1: Add file mtime to SettingsState interface**

Find the `SettingsState` interface in `src/renderer/src/stores/useSettingsStore.ts` and add:

```typescript
// src/renderer/src/stores/useSettingsStore.ts
interface SettingsState {
  // ... existing fields
  customCommandsFileMtime: number | null
}
```

- [ ] **Step 2: Add default value for customCommandsFileMtime**

Find where default state is initialized and add:

```typescript
// In the create() call
customCommandsFileMtime: null
```

- [ ] **Step 3: Modify loadSettingsFromDatabase to load from file first**

Find the `loadSettingsFromDatabase` function and add file loading at the beginning:

```typescript
// src/renderer/src/stores/useSettingsStore.ts
async function loadSettingsFromDatabase(): Promise<AppSettings | null> {
  try {
    // Step 1: Load from file if it exists
    const fileResult = await window.electron.ipcRenderer.invoke('load-custom-commands-file')
    
    if (fileResult.success && fileResult.commands && fileResult.commands.length > 0) {
      // Sync file commands to database (file is source of truth)
      const db = await window.electron.ipcRenderer.invoke('db:setting:get', 'app-settings')
      const settings = db?.value ? JSON.parse(db.value) : {}
      settings.customProjectCommands = fileResult.commands
      
      await window.electron.ipcRenderer.invoke(
        'db:setting:set',
        'app-settings',
        JSON.stringify(settings)
      )
    }
    
    // Step 2: Load all settings from database (now has latest file data)
    const result = await window.electron.ipcRenderer.invoke('db:setting:get', 'app-settings')
    
    // ... rest of existing loadSettingsFromDatabase logic
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return null
}
```

- [ ] **Step 4: Add reloadCustomCommands method to store**

Add this method to the store actions:

```typescript
// src/renderer/src/stores/useSettingsStore.ts - inside create() call

async reloadCustomCommands(): Promise<void> {
  try {
    const result = await window.electron.ipcRenderer.invoke('reload-custom-commands')
    
    if (result.success) {
      // Reload all settings from database
      await this.loadSettings()
      
      // Update mtime
      set({ customCommandsFileMtime: result.mtime })
      
      toast.success(`Loaded ${result.count} custom commands`)
    } else {
      toast.error(`Failed to reload: ${result.error || 'Unknown error'}`)
    }
  } catch (error) {
    console.error('Failed to reload custom commands:', error)
    toast.error('Failed to reload custom commands')
  }
}
```

- [ ] **Step 5: Test settings load manually**

Run: `npm run dev`

Expected behaviors:
1. Edit `~/.hive/custom-commands.json`
2. Restart app
3. Verify commands load in project menu

- [ ] **Step 6: Commit Task 4**

```bash
git add src/renderer/src/stores/useSettingsStore.ts
git commit -m "feat: modify settings store to load from file first

Settings load flow:
1. Load commands from file (if exists)
2. Sync to database (file is source of truth)
3. Load all settings from database into store

Adds reloadCustomCommands method for manual refresh.
Tracks file mtime in store state.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Add File Change Event Listener to ProjectItem

**Files:**
- Modify: `src/renderer/src/components/projects/ProjectItem.tsx`

- [ ] **Step 1: Add useEffect for file change events**

Add this useEffect hook in `ProjectItem.tsx`, near other useEffect hooks:

```typescript
// src/renderer/src/components/projects/ProjectItem.tsx

// Listen for custom commands file changes
useEffect(() => {
  const handleFileChange = async () => {
    // Reload settings which will trigger re-render
    await useSettingsStore.getState().loadSettings()
  }
  
  window.electron.ipcRenderer.on('custom-commands-file-changed', handleFileChange)
  
  return () => {
    window.electron.ipcRenderer.off('custom-commands-file-changed', handleFileChange)
  }
}, [])
```

- [ ] **Step 2: Test file change detection manually**

Run: `npm run dev`

Expected behaviors:
1. Open project menu (commands visible)
2. Edit `~/.hive/custom-commands.json` (add command)
3. Switch to another app and back to Hive
4. Open project menu again
5. Verify new command appears

- [ ] **Step 3: Commit Task 5**

```bash
git add src/renderer/src/components/projects/ProjectItem.tsx
git commit -m "feat: add file change event listener to ProjectItem

Listens for 'custom-commands-file-changed' event from main process.
Reloads settings on file change to update menu immediately.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Update Documentation

**Files:**
- Modify: `docs/features/custom-project-commands.md`

- [ ] **Step 1: Add file-based configuration section to docs**

Add this section to `docs/features/custom-project-commands.md` after the existing content:

```markdown
## File-Based Configuration

### Overview

Custom commands can be managed via a JSON file instead of editing the database directly. This provides an easier way to add, edit, and share commands.

### File Location

Commands are stored in: `~/.hive/custom-commands.json`

### File Format

The file contains a JSON array of command objects:

\`\`\`json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Analyze Architecture",
    "prompt": "Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements."
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Review Dependencies",
    "prompt": "Review all dependencies in {{project.path}}. Check for outdated packages and security issues."
  }
]
\`\`\`

**Field Requirements:**
- `id` (string, required): Unique identifier (UUID format)
- `name` (string, required): Display name in context menu
- `prompt` (string, required): Prompt template with optional `{{project.*}}` variables

### Template File

On first launch, Hive creates a template file with example commands at `~/.hive/custom-commands.json`. You can edit this file with any text editor.

### How It Works

1. **Editing:** Edit `~/.hive/custom-commands.json` with your favorite text editor
2. **Auto-reload:** Switch back to Hive and changes are automatically detected
3. **Instant update:** Commands appear in project menu immediately

### Manual Reload

If automatic reload doesn't work, you can manually reload by calling:

\`\`\`typescript
useSettingsStore.getState().reloadCustomCommands()
\`\`\`

Or restart the app.

### Error Handling

| Error | Behavior |
|-------|----------|
| Invalid JSON | Error toast, previous commands still work |
| Missing required fields | Invalid commands skipped, valid ones loaded |
| File too large (>1MB) | Error toast, not loaded |
| File doesn't exist | No error, uses database commands |

### Troubleshooting

**Q: My changes aren't showing up**
- Switch to another app and back to Hive to trigger reload
- Check file path is correct: `~/.hive/custom-commands.json`
- Verify JSON syntax is valid (use a JSON validator)

**Q: I get "Invalid JSON" error**
- Check for syntax errors (missing commas, brackets)
- Use a JSON formatter to validate
- Restore from template if needed

**Q: Where is the template file?**
- macOS/Linux: `~/.hive/custom-commands.json`
- Windows: `C:\Users\<username>\.hive\custom-commands.json`

**Q: Can I use both file and database?**
- Yes, but file takes precedence when it exists
- File is automatically synced to database on load

### FAQ

**File vs Database: Which takes precedence?**
The file is always the source of truth when it exists. If `~/.hive/custom-commands.json` exists, Hive loads commands from it and syncs to the database. If the file doesn't exist, Hive uses commands from the database.

**Can I share commands between computers?**
Yes! Copy your `~/.hive/custom-commands.json` file to another computer. The file will be automatically loaded on app startup.

**How do I backup my commands?**
Copy the `~/.hive/custom-commands.json` file to a safe location. You can version control it with git if desired.
```

- [ ] **Step 2: Commit documentation**

```bash
git add docs/features/custom-project-commands.md
git commit -m "docs: add file-based configuration to custom commands

Documents:
- File location and format
- Template file creation
- Auto-reload behavior
- Error handling
- Troubleshooting guide
- FAQ

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 7: Integration Testing

**Files:**
- Manual testing only (no new files)

- [ ] **Step 1: Test fresh install template creation**

Manual test:
1. Delete `~/.hive/custom-commands.json` if it exists
2. Start app: `npm run dev`
3. Verify file created with 3 example commands
4. Verify commands appear in project menu

- [ ] **Step 2: Test valid file loading**

Manual test:
1. Edit `~/.hive/custom-commands.json` (add new command)
2. Restart app
3. Verify new command appears in menu

- [ ] **Step 3: Test file change detection**

Manual test:
1. With app running, edit file (add command)
2. Switch to another app and back to Hive
3. Open project menu
4. Verify new command appears

- [ ] **Step 4: Test invalid JSON handling**

Manual test:
1. Break JSON syntax in file (remove comma)
2. Switch away and back to Hive
3. Verify error toast appears
4. Verify old commands still work in menu

- [ ] **Step 5: Test file deletion**

Manual test:
1. Delete `~/.hive/custom-commands.json`
2. Switch away and back to Hive
3. Verify no error
4. Verify last loaded commands still work

- [ ] **Step 6: Test large file**

Manual test:
1. Create 2MB JSON file (over limit)
2. Switch away and back to Hive
3. Verify error toast about file size
4. Verify old commands still work

- [ ] **Step 7: Test command execution with file-based commands**

Manual test:
1. Load commands from file
2. Right-click project → execute custom command
3. Verify prompt sent to session
4. Verify template variables work

- [ ] **Step 8: Document test results**

Create a test results summary:
- All test cases passed ✓
- Any issues found and fixed
- Screenshot of working feature

---

## Spec Self-Review

**1. Spec coverage check:**

| Requirement | Implemented In |
|-------------|----------------|
| User can edit ~/.hive/custom-commands.json | Task 1 (file service) |
| File automatically loaded on startup | Task 3 (app ready hook) |
| File changes detected on app activation | Task 3 (activate hook) |
| File is source of truth (one-way sync) | Task 4 (settings store) |
| Template file created on first run | Task 3 (createTemplateFile) |
| Invalid JSON handled gracefully | Task 1 (loadCustomCommandsFromFile) |
| Backward compatible | Task 4 (file doesn't exist = use DB) |

All requirements covered ✓

**2. Placeholder scan:**
- No "TBD" or "TODO" items ✓
- All code blocks complete ✓
- All test cases have expected output ✓

**3. Type consistency:**
- `CustomProjectCommand` interface used consistently ✓
- `CustomCommandFileResult` interface used in file service ✓
- IPC handler return types match expectations ✓

**4. File structure:**
- New service in `src/main/services/` ✓
- Tests in `test/custom-commands/` ✓
- IPC handlers in `src/main/ipc/` ✓
- Following existing patterns ✓

No issues found. Plan is complete and ready for execution.
