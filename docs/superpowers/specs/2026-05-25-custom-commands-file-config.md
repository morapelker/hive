# Custom Commands File-Based Configuration

**Date:** 2026-05-25
**Status:** Design Approved
**Feature:** File-based configuration for custom project commands

## Overview

Add file-based configuration for custom project commands to make the JSON more accessible to users without building a full settings UI. Users can edit `~/.hive/custom-commands.json` with any text editor, and the app automatically syncs changes to the database.

## Problem Statement

Currently, custom commands are stored only in the SQLite database at `~/Library/Application Support/Hive/settings.db`. Users must manually edit the database with SQL commands to add or modify custom commands, which is:
- Technical and error-prone
- Requires knowledge of SQLite
- Not discoverable or user-friendly

## Solution

Provide a file-based configuration option where users can edit `~/.hive/custom-commands.json` with any text editor. The app automatically loads and syncs the file to the database.

## Requirements

1. User can create and edit `~/.hive/custom-commands.json` in their home directory
2. File is automatically loaded on app startup
3. File changes are detected and reloaded when user returns to Hive
4. File is the source of truth (one-way sync: file → database)
5. Template file with examples created on first run
6. Invalid JSON or commands handled gracefully with user feedback
7. Existing database-only workflow continues working (backward compatible)

## File Configuration

### File Location

**Path:** `~/.hive/custom-commands.json`

- Located in user's home directory (cross-platform)
- Easy to remember and document
- Follows convention of config files like `.bashrc`, `.gitconfig`
- App uses `app.getPath('home')` to resolve path reliably

### File Format

**Structure:** JSON array of command objects

```json
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
```

**Why array format:**
- Simpler for users (just edit the array)
- Matches internal data structure
- Easier to read and maintain
- No extra wrapper object needed

**Field Requirements:**
- `id` (string, required): Unique identifier (UUID format recommended)
- `name` (string, required): Display name in context menu
- `prompt` (string, required): Prompt template with optional {{project.*}} variables

### Template File

On first launch (if file doesn't exist), create template with 2-3 example commands:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Analyze Architecture",
    "prompt": "Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements."
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Review Dependencies",
    "prompt": "Review all dependencies in the {{project.language}} project at {{project.path}}. Check for outdated packages and security issues."
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "name": "Generate Tests",
    "prompt": "Generate comprehensive test coverage for {{project.name}}. Focus on {{project.description}}."
  }
]
```

**Template Creation Behavior:**
- Only create if file doesn't exist
- Show one-time info toast: "Custom commands file created at ~/.hive/custom-commands.json"
- Silent if file already exists

## Sync Strategy

### One-Way Sync: File → Database

The file is the source of truth when it exists:

1. **File exists:** Load from file → validate → save to database → use in app
2. **File doesn't exist:** Use existing database commands (backward compatible)
3. **File invalid:** Show error, keep existing database commands

**Why one-way (not database → file):**
- File editing is the user's explicit intent
- Prevents sync conflicts
- Simpler mental model: "edit file to change commands"
- Database remains the runtime storage (fast reads)

### When to Load File

**Startup (always):**
- Check if `~/.hive/custom-commands.json` exists
- If exists, load and sync to database
- If doesn't exist and it's first launch, create template

**App Activation (when user switches back to Hive):**
- Track file's last modification time (`mtime`)
- On activation, check if `mtime` changed
- If changed, reload file and sync to database
- Notify renderer to refresh store

**Manual Refresh (optional):**
- Add menu item or command palette action: "Reload Custom Commands"
- Forces file reload regardless of `mtime`
- Useful for troubleshooting

### Change Detection

**Implementation:**
- Store file `mtime` in main process memory
- On app activation event, read current `mtime`
- Compare stored vs current `mtime`
- If different, trigger reload

**Benefits:**
- Automatic detection of file changes
- No file watching (simpler, less resource usage)
- Works even if user edits while Hive is open

## Error Handling

### File Read Errors

| Error | Behavior | User Feedback |
|-------|----------|---------------|
| File doesn't exist | Create template file (first launch only) | One-time info toast |
| Invalid JSON | Keep existing database commands | Error toast with file path |
| Invalid commands (missing fields) | Filter them out, load valid ones | Console warning only |
| File too large (>1MB) | Don't load, keep database commands | Error toast |
| Permission denied | Don't load, keep database commands | Error toast with troubleshooting |

### Validation

**Command Validation (same as existing):**
- `id`: Must be string (generate UUID if missing, don't skip command)
- `name`: Must be non-empty string (skip command if invalid)
- `prompt`: Must be non-empty string (skip command if invalid)

**File-Level Validation:**
- Must parse as valid JSON
- Root element must be array
- Array must contain objects
- Size limit: 1MB max

### User Feedback

**Success Cases:**
- File loaded successfully → No toast (silent success)
- Valid commands added → Appear in menu immediately

**Error Cases:**
- Invalid JSON → Toast: "Failed to load custom commands: Invalid JSON in ~/.hive/custom-commands.json"
- No valid commands → Toast: "No valid commands found in ~/.hive/custom-commands.json"
- File too large → Toast: "Custom commands file too large (max 1MB)"
- Permission denied → Toast: "Cannot read ~/.hive/custom-commands.json. Check file permissions."

**Partial Success:**
- Some commands invalid → Console warning only (don't interrupt user)
- Example: "Skipped 2 invalid commands in custom-commands.json"

## Technical Implementation

### New Files

**`src/main/services/custom-commands-file-service.ts`**

Core service for file operations:

```typescript
export interface CustomCommandFileResult {
  success: boolean
  commands?: CustomProjectCommand[]
  error?: string
  mtime?: number
}

/**
 * Loads custom commands from ~/.hive/custom-commands.json
 * Validates and returns parsed commands with file mtime
 */
export function loadCustomCommandsFromFile(): CustomCommandFileResult

/**
 * Creates template file with example commands
 * Only creates if file doesn't already exist
 */
export function createTemplateFile(): { success: boolean; created: boolean; error?: string }

/**
 * Gets file modification time for change detection
 * Returns null if file doesn't exist
 */
export function getFileModTime(): number | null

/**
 * Gets the full path to custom commands file
 */
export function getCustomCommandsFilePath(): string
```

**Key Behaviors:**
- Uses `app.getPath('home')` to resolve `~/.hive/custom-commands.json`
- Validates JSON structure and individual commands
- Returns validation errors without throwing
- Handles all file system errors gracefully

### Modified Files

**`src/main/ipc/settings-handlers.ts`**

Add IPC handlers for file operations:

```typescript
// Get file path for display in UI
ipcMain.handle('get-custom-commands-file-path', async () => {
  return getCustomCommandsFilePath()
})

// Manual reload trigger
ipcMain.handle('reload-custom-commands', async () => {
  const result = loadCustomCommandsFromFile()
  if (result.success && result.commands) {
    // Save to database
    await saveCustomCommandsToDatabase(result.commands)
    return { success: true, count: result.commands.length }
  }
  return { success: false, error: result.error }
})
```

**`src/renderer/src/stores/useSettingsStore.ts`**

Modify settings load flow:

```typescript
async function loadSettingsFromDatabase(): Promise<AppSettings | null> {
  try {
    // Step 1: Check if custom commands file exists and load it
    const fileResult = await window.electron.ipcRenderer.invoke('load-custom-commands-file')

    if (fileResult.success && fileResult.commands) {
      // Save file commands to database (file is source of truth)
      await window.electron.ipcRenderer.invoke('save-custom-commands', fileResult.commands)
    }

    // Step 2: Load all settings from database (now has latest file data)
    const result = await window.electron.ipcRenderer.invoke('load-settings')

    // ... existing validation and parsing logic
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return null
}

// Track file mtime for change detection
interface SettingsState {
  // ... existing fields
  customCommandsFileMtime: number | null
}

// Manual refresh method
async reloadCustomCommands(): Promise<void> {
  const result = await window.electron.ipcRenderer.invoke('reload-custom-commands')
  if (result.success) {
    // Reload settings from database
    await this.loadSettings()
    toast.success(`Loaded ${result.count} custom commands`)
  } else {
    toast.error(`Failed to reload: ${result.error}`)
  }
}
```

**`src/main/index.ts`**

Add app lifecycle hooks:

```typescript
// On app ready
app.whenReady().then(() => {
  // ... existing initialization

  // Create template file if this is first launch
  const templateResult = createTemplateFile()
  if (templateResult.created) {
    console.log('Created custom commands template file')
  }

  // Store initial file mtime
  lastKnownMtime = getFileModTime()
})

// On app activation (user switches back to Hive)
let lastKnownMtime: number | null = null

app.on('activate', () => {
  // ... existing activation logic

  // Check if custom commands file changed
  const currentMtime = getFileModTime()
  if (currentMtime !== null && currentMtime !== lastKnownMtime) {
    lastKnownMtime = currentMtime

    // Notify all windows to reload custom commands
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('custom-commands-file-changed')
    })
  }
})
```

**`src/renderer/src/components/projects/ProjectItem.tsx`**

Add listener for file change events:

```typescript
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

## Data Flow

```
User edits ~/.hive/custom-commands.json
  ↓
User switches back to Hive (app activation)
  ↓
Main process detects file change (mtime comparison)
  ↓
Main process loads file → validates → saves to database
  ↓
Main process sends 'custom-commands-file-changed' event to renderer
  ↓
Renderer reloads settings from database
  ↓
Zustand store updates → components re-render
  ↓
ProjectItem menu shows updated commands
```

## Backward Compatibility

**No Breaking Changes:**
- If file doesn't exist, app uses database commands (existing behavior)
- Users who never create the file continue using database-only workflow
- Database remains the runtime storage (no changes to menu rendering)
- Existing validation and execution logic unchanged

**Migration Path:**
- Users can export current database commands to file (future enhancement)
- Or manually create file and copy commands from database
- Both database and file approaches work simultaneously

## Testing Strategy

### Unit Tests

**File Service Tests (`test/custom-commands-file-service.test.ts`):**
1. Load valid JSON file → returns commands
2. Load invalid JSON → returns error
3. Load non-existent file → returns empty result
4. Create template file → creates with examples
5. Create template when file exists → no-op
6. Get mtime of existing file → returns number
7. Get mtime of non-existent file → returns null
8. Validate command objects → filters invalid

**Settings Store Tests:**
1. Load settings with valid file → file commands sync to database
2. Load settings without file → use database commands
3. File change event → triggers reload
4. Manual reload → updates commands

### Integration Tests

**End-to-End Flow:**
1. Create `~/.hive/custom-commands.json` with valid commands
2. Start app → verify template created
3. Verify commands appear in project menu
4. Edit file (add new command)
5. Switch away and back to Hive
6. Verify new command appears in menu
7. Break JSON syntax
8. Switch back to Hive
9. Verify error toast shown, old commands still work

### Manual Testing Checklist

- [ ] Fresh install: template file created on first launch
- [ ] Valid file: commands load and appear in menu
- [ ] Invalid JSON: error toast, existing commands still work
- [ ] File change while app running: detected on activation
- [ ] File deleted: app continues with last loaded commands
- [ ] Large file (>1MB): error toast, not loaded
- [ ] Permission denied: error toast, fallback to database
- [ ] Manual reload: commands refresh without restart
- [ ] Template variables: still work with file-based commands
- [ ] Command execution: works same as before

## Success Criteria

✅ User can edit `~/.hive/custom-commands.json` with any text editor
✅ File changes automatically detected when user returns to Hive
✅ Template file with examples created on first launch
✅ Invalid JSON shows helpful error without breaking app
✅ Backward compatible: database-only workflow still works
✅ No performance impact on app startup or activation
✅ All existing custom command features continue working

## Future Enhancements (Out of Scope)

1. **Export to File** - Button to export current database commands to file
2. **Real-time File Watching** - Use fs.watch() instead of activation-based detection
3. **File Format Validation UI** - In-app JSON schema validator with helpful errors
4. **Multiple File Support** - Load from project-specific files like `.hive/commands.json`
5. **File → Database → File Sync** - Two-way sync (complex, not needed for initial version)
6. **Command Ordering UI** - Drag-and-drop in file or settings panel
7. **File Change Notifications** - Desktop notification when file reloaded successfully
8. **Conflict Resolution** - Handle simultaneous edits from multiple Hive instances

## Documentation Updates Needed

1. Update `docs/features/custom-project-commands.md` with file-based configuration section
2. Add troubleshooting guide for common file errors
3. Include example commands in documentation
4. Document template variables reference
5. Add FAQ: "File vs Database: Which takes precedence?"
