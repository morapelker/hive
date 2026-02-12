# Hive Phase 2 Implementation Plan

This document outlines the implementation plan for Hive Phase 2, focusing on file tree, git operations, command palette, and session/chat experience improvements.

---

## Overview

The implementation is divided into **12 focused sessions**, each with:
- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 2 builds upon Phase 1** - all Phase 1 infrastructure (Electron, React, SQLite, Zustand, shadcn/ui) is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 2)
```
test/
├── phase-2/
│   ├── session-1/
│   │   └── file-tree-foundation.test.ts
│   ├── session-2/
│   │   └── file-tree-git.test.ts
│   ├── session-3/
│   │   └── git-status-stage.test.ts
│   ├── session-4/
│   │   └── git-commit-push-pull.test.ts
│   ├── session-5/
│   │   └── diff-viewer.test.ts
│   ├── session-6/
│   │   └── command-palette.test.ts
│   ├── session-7/
│   │   └── keyboard-shortcuts.test.ts
│   ├── session-8/
│   │   └── settings-panel.test.ts
│   ├── session-9/
│   │   └── chat-layout.test.ts
│   ├── session-10/
│   │   └── tool-messages.test.ts
│   ├── session-11/
│   │   └── build-plan-mode.test.ts
│   └── session-12/
│       └── polish-performance.test.ts
```

### New Dependencies
```json
{
  "chokidar": "^3.5.3",
  "cmdk": "^0.2.0",
  "@tanstack/react-virtual": "^3.0.0",
  "diff2html": "^3.4.0"
}
```

---

## Session 1: File Tree Foundation

### Objectives
- Create file tree component for right sidebar
- Implement hierarchical folder/file display
- Set up file system watching with chokidar
- Build expand/collapse functionality

### Tasks
1. Create `FileTree.tsx` component with tree structure
2. Create `FileTreeNode.tsx` for individual file/folder items
3. Create `FileTreeHeader.tsx` with filter input and collapse button
4. Create `FileTreeFilter.tsx` for quick file search
5. Create `FileIcon.tsx` with extension-based icons
6. Install and configure chokidar for file watching
7. Create file-tree IPC handlers in main process
8. Implement debounced file system updates (100ms)
9. Add ignore patterns (node_modules, .git, build)
10. Create `useFileTreeStore.ts` Zustand store
11. Persist expanded paths per worktree
12. Implement lazy loading for large directories

### Definition of Done
- [ ] File tree renders in right sidebar
- [ ] Folders expand/collapse on click
- [ ] Files display with appropriate icons
- [ ] Filter input filters visible files
- [ ] File changes on disk update UI automatically
- [ ] Expanded state persists per worktree
- [ ] Performance: < 500ms load for 1000 files
- [ ] node_modules and .git are excluded

### Testing Criteria
```typescript
// test/phase-2/session-1/file-tree-foundation.test.ts
describe('Session 1: File Tree Foundation', () => {
  test('File tree renders in right sidebar', async () => {
    // Select worktree, verify file tree appears
  });

  test('Folders expand and collapse', async () => {
    // Click folder, verify children appear
    // Click again, verify children hidden
  });

  test('Files display with correct icons', async () => {
    // Verify .ts file has TypeScript icon
    // Verify .tsx file has React icon
    // Verify folder has folder icon
  });

  test('Filter input filters visible files', async () => {
    // Type "app", verify only matching files shown
  });

  test('File changes update UI automatically', async () => {
    // Create file on disk
    // Verify file appears in tree within 200ms
  });

  test('Expanded state persists after switching worktrees', async () => {
    // Expand folder, switch worktree, switch back
    // Verify folder is still expanded
  });

  test('File tree loads in under 500ms for 1000 files', async () => {
    // Time file tree load for large directory
  });

  test('node_modules is excluded from tree', async () => {
    // Verify node_modules folder not in tree
  });
});
```

---

## Session 2: File Tree Git Integration

### Objectives
- Add git status indicators to file tree
- Show modified, staged, untracked, conflicted states
- Implement file context menu with git actions

### Tasks
1. Extend git-service to get file statuses
2. Add status indicator component to FileTreeNode
3. Implement status colors (M=yellow, A=green, D=red, ?=gray, C=red bold)
4. Create file context menu component
5. Implement "Stage File" context menu action
6. Implement "Unstage File" context menu action
7. Implement "Discard Changes" context menu action
8. Implement "Add to .gitignore" context menu action
9. Implement "Open in Editor" context menu action
10. Implement "Open in Finder" context menu action
11. Implement "Copy Path" / "Copy Relative Path" actions
12. Update git status on file system changes

### Definition of Done
- [ ] Modified files show "M" indicator in yellow
- [ ] Staged files show "A" indicator in green
- [ ] Deleted files show "D" indicator in red
- [ ] Untracked files show "?" indicator in gray
- [ ] Conflicted files show "C" indicator in red bold
- [ ] Context menu appears on right-click
- [ ] Stage/Unstage actions work correctly
- [ ] Discard changes works with confirmation
- [ ] Open in Editor launches configured editor
- [ ] Copy path works for absolute and relative

### Testing Criteria
```typescript
// test/phase-2/session-2/file-tree-git.test.ts
describe('Session 2: File Tree Git Integration', () => {
  test('Modified files show M indicator', async () => {
    // Modify a tracked file
    // Verify M indicator appears in yellow
  });

  test('Staged files show A indicator', async () => {
    // Stage a file via git
    // Verify A indicator appears in green
  });

  test('Untracked files show ? indicator', async () => {
    // Create new file
    // Verify ? indicator appears in gray
  });

  test('Context menu appears on right-click', async () => {
    // Right-click file
    // Verify context menu with expected options
  });

  test('Stage file via context menu', async () => {
    // Right-click modified file, select Stage
    // Verify file is staged (A indicator)
  });

  test('Unstage file via context menu', async () => {
    // Right-click staged file, select Unstage
    // Verify file is unstaged (M indicator)
  });

  test('Discard changes shows confirmation', async () => {
    // Right-click modified file, select Discard
    // Verify confirmation dialog appears
  });

  test('Open in Editor launches editor', async () => {
    // Mock shell.openPath
    // Right-click file, select Open in Editor
    // Verify correct path opened
  });

  test('Copy path copies to clipboard', async () => {
    // Right-click file, select Copy Path
    // Verify clipboard contains absolute path
  });
});
```

---

## Session 3: Git Operations - Status & Stage/Unstage

### Objectives
- Create git status panel in right sidebar
- Display branch info with ahead/behind counts
- Implement stage/unstage file functionality
- Show staged, modified, and untracked file lists

### Tasks
1. Create `GitStatusPanel.tsx` component
2. Display current branch name
3. Display ahead/behind counts from remote
4. Create collapsible sections for Staged/Modified/Untracked
5. Implement "Stage All" button
6. Implement "Unstage All" button
7. Implement individual file stage/unstage via checkbox
8. Create `useGitStore.ts` Zustand store
9. Implement git:status IPC handler
10. Implement git:stage IPC handler
11. Implement git:unstage IPC handler
12. Add refresh button to manually refresh status
13. Auto-refresh status on file system changes

### Definition of Done
- [ ] Git status panel shows in right sidebar above file tree
- [ ] Current branch name displayed
- [ ] Ahead/behind counts shown when remote exists
- [ ] Staged files list is collapsible
- [ ] Modified files list is collapsible
- [ ] Untracked files list is collapsible
- [ ] Stage All stages all modified + untracked
- [ ] Unstage All unstages all staged files
- [ ] Individual files can be staged/unstaged
- [ ] Status refreshes automatically on file changes
- [ ] Manual refresh button works

### Testing Criteria
```typescript
// test/phase-2/session-3/git-status-stage.test.ts
describe('Session 3: Git Status & Stage/Unstage', () => {
  test('Git status panel renders', async () => {
    // Select worktree
    // Verify git status panel appears
  });

  test('Branch name is displayed', async () => {
    // Verify current branch name shown
  });

  test('Ahead/behind counts shown', async () => {
    // Create commits ahead of remote
    // Verify "↑2" indicator shown
  });

  test('Modified files shown in correct section', async () => {
    // Modify file
    // Verify file appears in Modified section
  });

  test('Stage All stages all files', async () => {
    // Create modified and untracked files
    // Click Stage All
    // Verify all files in Staged section
  });

  test('Unstage All unstages all files', async () => {
    // Stage files
    // Click Unstage All
    // Verify no files in Staged section
  });

  test('Individual file staging works', async () => {
    // Click checkbox on single file
    // Verify only that file is staged
  });

  test('Status auto-refreshes on file change', async () => {
    // Modify file on disk
    // Verify status updates within 200ms
  });

  test('Refresh button manually refreshes', async () => {
    // Click refresh button
    // Verify git status is re-fetched
  });
});
```

---

## Session 4: Git Operations - Commit, Push, Pull

### Objectives
- Create commit form with message validation
- Implement push/pull functionality
- Add progress indicators during operations
- Handle errors gracefully

### Tasks
1. Create `GitCommitForm.tsx` component
2. Implement two-part commit message (summary + description)
3. Add character count for summary (warn 50+, error 72+)
4. Implement commit validation (require staged files + message)
5. Create `GitPushPull.tsx` component
6. Implement push button with progress indicator
7. Implement pull button with progress indicator
8. Implement force push option with confirmation
9. Implement rebase pull option
10. Create git:commit IPC handler
11. Create git:push IPC handler
12. Create git:pull IPC handler
13. Show success toast on commit/push/pull
14. Show error toast with helpful messages on failure
15. Add keyboard shortcut: Cmd/Ctrl+Enter to commit

### Definition of Done
- [ ] Commit form shows summary + description fields
- [ ] Character count warns at 50, errors at 72
- [ ] Commit button disabled if no staged files
- [ ] Commit button disabled if no message
- [ ] Commit creates git commit with correct message
- [ ] Push button pushes to tracked remote
- [ ] Pull button pulls from tracked remote
- [ ] Force push requires confirmation
- [ ] Progress indicators show during operations
- [ ] Success toasts show on completion
- [ ] Error toasts show helpful messages
- [ ] Cmd/Ctrl+Enter triggers commit

### Testing Criteria
```typescript
// test/phase-2/session-4/git-commit-push-pull.test.ts
describe('Session 4: Git Commit, Push, Pull', () => {
  test('Commit form renders', async () => {
    // Verify summary and description fields exist
  });

  test('Character count warns at 50 characters', async () => {
    // Type 51 characters in summary
    // Verify warning indicator shown
  });

  test('Character count errors at 72 characters', async () => {
    // Type 73 characters in summary
    // Verify error indicator shown
  });

  test('Commit button disabled without staged files', async () => {
    // No staged files
    // Verify commit button is disabled
  });

  test('Commit creates git commit', async () => {
    // Stage file, enter message, click commit
    // Verify git log shows new commit
  });

  test('Push sends commits to remote', async () => {
    // Create commit, click push
    // Verify commits pushed (mock remote)
  });

  test('Pull fetches commits from remote', async () => {
    // Mock remote with new commits
    // Click pull, verify commits appear
  });

  test('Force push shows confirmation', async () => {
    // Click force push option
    // Verify confirmation dialog appears
  });

  test('Progress indicator shows during push', async () => {
    // Click push
    // Verify spinner/progress indicator visible
  });

  test('Error toast shows on push failure', async () => {
    // Mock push failure
    // Verify error toast with helpful message
  });

  test('Cmd+Enter triggers commit', async () => {
    // Stage file, enter message
    // Press Cmd+Enter
    // Verify commit created
  });
});
```

---

## Session 5: Diff Viewer

### Objectives
- Create diff viewer component
- Support unified and split view modes
- Show diffs for staged and unstaged changes
- Enable viewing diffs from file tree and git panel

### Tasks
1. Create `DiffViewer.tsx` component
2. Create `DiffModal.tsx` for full-screen diff view
3. Implement unified diff view (default)
4. Implement split diff view (side-by-side)
5. Add syntax highlighting for diff content
6. Add line numbers
7. Create git:diff IPC handler
8. Integrate with file tree context menu ("View Changes")
9. Integrate with git status panel (click file to view diff)
10. Add toggle between unified/split view
11. Add copy old/new content functionality
12. Style additions (green) and deletions (red)

### Definition of Done
- [ ] Diff viewer shows file changes
- [ ] Unified view shows +/- lines inline
- [ ] Split view shows old/new side by side
- [ ] Additions highlighted in green
- [ ] Deletions highlighted in red
- [ ] Line numbers displayed
- [ ] Context menu "View Changes" opens diff
- [ ] Git panel file click opens diff
- [ ] Toggle switches between unified/split
- [ ] Diff renders in < 100ms for 500-line diff

### Testing Criteria
```typescript
// test/phase-2/session-5/diff-viewer.test.ts
describe('Session 5: Diff Viewer', () => {
  test('Diff viewer renders for modified file', async () => {
    // Modify file
    // Open diff viewer
    // Verify diff content displayed
  });

  test('Unified view shows inline diff', async () => {
    // Verify + and - lines are inline
  });

  test('Split view shows side by side', async () => {
    // Toggle to split view
    // Verify two columns displayed
  });

  test('Additions highlighted in green', async () => {
    // Add line to file
    // Verify line has green background
  });

  test('Deletions highlighted in red', async () => {
    // Delete line from file
    // Verify line has red background
  });

  test('Line numbers displayed', async () => {
    // Verify line numbers on left side
  });

  test('Context menu View Changes opens diff', async () => {
    // Right-click modified file
    // Select View Changes
    // Verify diff modal opens
  });

  test('Git panel file click opens diff', async () => {
    // Click file in git status panel
    // Verify diff modal opens
  });

  test('Diff renders under 100ms', async () => {
    // Time diff render for 500-line file
  });
});
```

---

## Session 6: Command Palette

### Objectives
- Create command palette component
- Implement fuzzy search
- Register commands from all features
- Support nested commands

### Tasks
1. Install and configure cmdk
2. Create `CommandPalette.tsx` component
3. Create `CommandList.tsx` for results display
4. Create `CommandItem.tsx` for individual commands
5. Create command registry system
6. Register navigation commands (projects, worktrees, sessions)
7. Register action commands (new worktree, new session)
8. Register git commands (commit, push, pull, stage, discard)
9. Register settings commands (theme, open settings)
10. Register file commands (open in editor, reveal in finder)
11. Implement fuzzy search across all commands
12. Add recent commands section
13. Display keyboard shortcuts inline
14. Implement nested commands (e.g., "Switch to worktree" → worktree list)
15. Add keyboard shortcut: Cmd/Ctrl+P to open

### Definition of Done
- [ ] Command palette opens with Cmd/Ctrl+P
- [ ] Fuzzy search finds commands by partial match
- [ ] Recent commands shown at top
- [ ] Keyboard shortcuts displayed inline
- [ ] All navigation commands work
- [ ] All action commands work
- [ ] All git commands work
- [ ] Nested commands show sub-items
- [ ] Escape closes palette
- [ ] Arrow keys navigate, Enter selects

### Testing Criteria
```typescript
// test/phase-2/session-6/command-palette.test.ts
describe('Session 6: Command Palette', () => {
  test('Command palette opens with Cmd+P', async () => {
    // Press Cmd+P
    // Verify palette is visible
  });

  test('Fuzzy search finds commands', async () => {
    // Type "nw" for "New Worktree"
    // Verify New Worktree command shown
  });

  test('Recent commands shown at top', async () => {
    // Execute command, reopen palette
    // Verify command in Recent section
  });

  test('Keyboard shortcuts displayed', async () => {
    // Verify "New Session" shows "⌘N"
  });

  test('Navigation commands work', async () => {
    // Select "Switch to worktree" command
    // Verify worktree list shown or switched
  });

  test('Git commands work', async () => {
    // Select "Commit Changes" command
    // Verify commit form focused
  });

  test('Nested commands show sub-items', async () => {
    // Select "Switch to worktree"
    // Verify list of worktrees shown
  });

  test('Escape closes palette', async () => {
    // Open palette, press Escape
    // Verify palette closed
  });

  test('Arrow keys navigate items', async () => {
    // Open palette, press Down
    // Verify next item selected
  });
});
```

---

## Session 7: Keyboard Shortcuts System

### Objectives
- Create centralized keyboard shortcuts system
- Implement default shortcuts as per PRD
- Make shortcuts customizable
- Handle conflicts

### Tasks
1. Create keyboard shortcuts registry
2. Create `useKeyboardShortcuts` hook
3. Implement all default shortcuts from PRD
4. Create shortcut display component (for command palette)
5. Implement Cmd/Ctrl+N for new session
6. Implement Cmd/Ctrl+W for close session (noop if none)
7. Implement Cmd/Ctrl+Shift+N for new worktree
8. Implement Shift+Tab for build/plan mode toggle
9. Implement all git shortcuts (Cmd+Shift+C/P/L)
10. Implement sidebar toggles (Cmd+B, Cmd+Shift+B)
11. Implement focus shortcuts (Cmd+1, Cmd+2)
12. Store shortcut overrides in settings
13. Create conflict detection for duplicate bindings
14. Add reset to defaults functionality

### Definition of Done
- [ ] Cmd/Ctrl+N creates new session
- [ ] Cmd/Ctrl+W closes session (noop if none open)
- [ ] Cmd/Ctrl+Shift+N creates new worktree
- [ ] Shift+Tab toggles build/plan mode
- [ ] Cmd/Ctrl+P opens command palette
- [ ] Cmd/Ctrl+K opens session history
- [ ] All git shortcuts work
- [ ] Sidebar toggles work
- [ ] Focus shortcuts work
- [ ] Custom shortcuts persist
- [ ] Conflicts are detected and warned

### Testing Criteria
```typescript
// test/phase-2/session-7/keyboard-shortcuts.test.ts
describe('Session 7: Keyboard Shortcuts', () => {
  test('Cmd+N creates new session', async () => {
    // Select worktree
    // Press Cmd+N
    // Verify new session tab created
  });

  test('Cmd+W closes session', async () => {
    // Create session
    // Press Cmd+W
    // Verify session closed
  });

  test('Cmd+W is noop when no sessions', async () => {
    // No sessions open
    // Press Cmd+W
    // Verify nothing happens (window not closed)
  });

  test('Shift+Tab toggles build/plan mode', async () => {
    // Create session
    // Press Shift+Tab
    // Verify mode changed
  });

  test('Cmd+Shift+C focuses commit form', async () => {
    // Press Cmd+Shift+C
    // Verify commit form focused
  });

  test('Cmd+B toggles left sidebar', async () => {
    // Press Cmd+B
    // Verify left sidebar collapsed
    // Press again, verify expanded
  });

  test('Custom shortcut persists', async () => {
    // Change shortcut in settings
    // Restart app
    // Verify custom shortcut works
  });

  test('Conflict detection warns user', async () => {
    // Attempt to assign duplicate shortcut
    // Verify warning shown
  });
});
```

---

## Session 8: Settings Panel

### Objectives
- Create settings modal with all sections
- Implement editor/terminal configuration
- Implement git settings
- Implement shortcut customization UI

### Tasks
1. Create `SettingsModal.tsx` component
2. Create `SettingsGeneral.tsx` (theme, startup behavior)
3. Create `SettingsEditor.tsx` (default editor selection)
4. Create `SettingsTerminal.tsx` (default terminal selection)
5. Create `SettingsGit.tsx` (commit template, auto-fetch)
6. Create `SettingsShortcuts.tsx` (shortcut editor)
7. Create `useSettingsStore.ts` Zustand store
8. Implement editor detection (VS Code, Cursor, Sublime, etc.)
9. Implement terminal detection (Terminal, iTerm, Warp, etc.)
10. Implement custom command input for editor/terminal
11. Create settings IPC handlers
12. Persist all settings to SQLite
13. Add keyboard shortcut: Cmd/Ctrl+, to open settings

### Definition of Done
- [ ] Settings modal opens with Cmd/Ctrl+,
- [ ] Theme can be changed (dark/light/system)
- [ ] Default editor can be selected
- [ ] Custom editor command can be entered
- [ ] Default terminal can be selected
- [ ] Custom terminal command can be entered
- [ ] Git settings can be configured
- [ ] Shortcuts can be customized
- [ ] All settings persist across restarts
- [ ] Reset to defaults works

### Testing Criteria
```typescript
// test/phase-2/session-8/settings-panel.test.ts
describe('Session 8: Settings Panel', () => {
  test('Settings modal opens with Cmd+,', async () => {
    // Press Cmd+,
    // Verify settings modal visible
  });

  test('Theme selection persists', async () => {
    // Change theme to light
    // Restart app
    // Verify light theme applied
  });

  test('Editor selection works', async () => {
    // Select VS Code
    // Use Open in Editor
    // Verify VS Code opened (mock)
  });

  test('Custom editor command works', async () => {
    // Enter custom command
    // Verify command executed
  });

  test('Terminal selection works', async () => {
    // Select iTerm
    // Use Open in Terminal
    // Verify iTerm opened (mock)
  });

  test('Shortcut customization works', async () => {
    // Change Cmd+N to Cmd+Shift+T
    // Press Cmd+Shift+T
    // Verify new session created
  });

  test('Reset to defaults works', async () => {
    // Change settings
    // Click Reset to Defaults
    // Verify original values restored
  });
});
```

---

## Session 9: Chat Layout Redesign

### Objectives
- Redesign chat layout with new visual style
- Implement user bubbles on right
- Implement assistant text on canvas (no bubble)
- Remove avatars

### Tasks
1. Create `UserBubble.tsx` component (right-aligned, subtle bg)
2. Create `AssistantCanvas.tsx` component (full-width, no container)
3. Create `MessageRenderer.tsx` to route by role
4. Update SessionView to use new components
5. Remove avatar components
6. Implement generous whitespace spacing
7. Ensure code blocks still render correctly
8. Update markdown rendering for assistant messages
9. Move "+" button to left of tab bar
10. Update SessionTabs.tsx layout
11. Test with long messages and code blocks

### Definition of Done
- [ ] User messages appear as bubbles on right
- [ ] User bubbles have subtle background color
- [ ] Assistant messages appear as plain text (left)
- [ ] No avatars displayed
- [ ] Code blocks render with syntax highlighting
- [ ] Whitespace is generous and readable
- [ ] "+" button is on left of tab bar
- [ ] Layout works with long messages
- [ ] Layout works with multiple code blocks

### Testing Criteria
```typescript
// test/phase-2/session-9/chat-layout.test.ts
describe('Session 9: Chat Layout Redesign', () => {
  test('User messages rendered as right-aligned bubbles', async () => {
    // Send user message
    // Verify bubble is right-aligned
    // Verify has background color
  });

  test('Assistant messages rendered as plain text', async () => {
    // Receive assistant message
    // Verify no container/bubble
    // Verify left-aligned
  });

  test('No avatars displayed', async () => {
    // Verify no avatar elements in DOM
  });

  test('Code blocks render correctly', async () => {
    // Receive message with code block
    // Verify syntax highlighting
    // Verify copy button present
  });

  test('+ button is on left of tab bar', async () => {
    // Verify + button is first element in tab bar
  });

  test('Layout handles long messages', async () => {
    // Send very long message
    // Verify proper wrapping
    // Verify scrolling works
  });

  test('Layout handles multiple code blocks', async () => {
    // Receive message with 3 code blocks
    // Verify all render correctly
  });
});
```

---

## Session 10: Tool Message Rendering

### Objectives
- Implement tool message cards
- Show real-time tool execution status
- Make tool messages collapsible
- Display tool-specific icons and information

### Tasks
1. Create `ToolCard.tsx` component
2. Create `StreamingCursor.tsx` for streaming indicator
3. Implement tool status states (pending, running, success, error)
4. Create icons for each tool type (Read, Write, Edit, Bash, Glob/Grep)
5. Implement collapsible tool output
6. Show execution time for completed tools
7. Show error messages for failed tools
8. Update opencode message handler to emit tool events
9. Integrate tool cards into AssistantCanvas
10. Handle interleaved text and tool messages
11. Implement streaming text accumulation
12. Add spinner for pending tools

### Definition of Done
- [ ] Tool messages render as cards
- [ ] Pending tools show spinner
- [ ] Running tools show progress indicator
- [ ] Successful tools show checkmark
- [ ] Failed tools show error icon and message
- [ ] Tool cards are collapsible
- [ ] Execution time displayed on completion
- [ ] Read tool shows file path
- [ ] Edit tool shows file path and line
- [ ] Bash tool shows command
- [ ] Streaming text accumulates correctly

### Testing Criteria
```typescript
// test/phase-2/session-10/tool-messages.test.ts
describe('Session 10: Tool Message Rendering', () => {
  test('Tool card renders for tool_use event', async () => {
    // Emit tool_use event
    // Verify tool card appears
  });

  test('Pending tool shows spinner', async () => {
    // Tool use without result yet
    // Verify spinner visible
  });

  test('Completed tool shows checkmark', async () => {
    // Emit tool_result success
    // Verify checkmark visible
  });

  test('Failed tool shows error', async () => {
    // Emit tool_result with error
    // Verify error icon and message
  });

  test('Tool cards are collapsible', async () => {
    // Click tool card
    // Verify output collapses/expands
  });

  test('Execution time displayed', async () => {
    // Complete tool use
    // Verify duration shown (e.g., "45ms")
  });

  test('Read tool shows file path', async () => {
    // Emit Read tool use
    // Verify file path displayed
  });

  test('Bash tool shows command', async () => {
    // Emit Bash tool use
    // Verify command displayed
  });

  test('Streaming text accumulates', async () => {
    // Emit multiple text chunks
    // Verify text accumulates in order
  });

  test('Tool messages render within 50ms', async () => {
    // Time tool message render
  });
});
```

---

## Session 11: Build/Plan Mode & Auto-Start Session

### Objectives
- Implement Build/Plan mode toggle
- Create mode indicator in UI
- Implement auto-start session on worktree selection
- Add settings for auto-start behavior

### Tasks
1. Create `ModeToggle.tsx` component
2. Add mode state to session store
3. Implement Shift+Tab keyboard shortcut for toggle
4. Send mode to OpenCode backend with prompts
5. Display current mode prominently in header
6. Persist mode per session in database
7. Implement auto-start session logic
8. Check for existing sessions when selecting worktree
9. Create new session if none exist
10. Add autoStartSession setting (default: true)
11. Add setting to Settings > General panel
12. Show loading state during auto-session creation

### Definition of Done
- [ ] Build/Plan toggle visible in session header
- [ ] Shift+Tab toggles between modes
- [ ] Mode indicator clearly shows current mode
- [ ] Mode persists per session
- [ ] Mode sent to OpenCode with prompts
- [ ] Auto-start creates session when none exist
- [ ] Auto-start can be disabled in settings
- [ ] Loading state shown during connection
- [ ] Existing sessions are loaded (not replaced)

### Testing Criteria
```typescript
// test/phase-2/session-11/build-plan-mode.test.ts
describe('Session 11: Build/Plan Mode & Auto-Start', () => {
  test('Mode toggle visible in session header', async () => {
    // Create session
    // Verify mode toggle visible
  });

  test('Shift+Tab toggles mode', async () => {
    // Default is Build
    // Press Shift+Tab
    // Verify mode is Plan
    // Press again, verify Build
  });

  test('Mode persists per session', async () => {
    // Set session to Plan mode
    // Switch to another session
    // Switch back
    // Verify still Plan mode
  });

  test('Auto-start creates session when none exist', async () => {
    // Create worktree with no sessions
    // Select worktree
    // Verify session auto-created
  });

  test('Auto-start loads existing session', async () => {
    // Create worktree with session
    // Select worktree
    // Verify existing session loaded (not new)
  });

  test('Auto-start can be disabled', async () => {
    // Disable autoStartSession in settings
    // Select worktree with no sessions
    // Verify no session created
  });

  test('Loading state shown during auto-start', async () => {
    // Select worktree
    // Verify loading spinner while connecting
  });
});
```

---

## Session 12: Polish & Performance

### Objectives
- Performance optimization for all new features
- Virtual scrolling for large file trees
- Final UI polish
- Comprehensive error handling

### Tasks
1. Implement virtual scrolling for file tree (@tanstack/react-virtual)
2. Optimize git status updates (batch, debounce)
3. Memoize command palette filtering
4. Add error boundaries for new components
5. Add toast notifications for all git operations
6. Polish animations and transitions
7. Test with large repos (10k+ files)
8. Test with many commands (100+)
9. Profile and optimize render performance
10. Ensure all operations under target times
11. Add loading states to all async operations
12. Final accessibility pass (keyboard nav, aria labels)

### Definition of Done
- [ ] File tree loads < 500ms for 1000 files
- [ ] Git status refresh < 200ms
- [ ] Command palette opens < 50ms
- [ ] File watcher CPU < 1% idle
- [ ] Diff renders < 100ms for 500 lines
- [ ] Tool messages render < 50ms
- [ ] Mode toggle responds < 100ms
- [ ] All async operations have loading states
- [ ] All errors show user-friendly toasts
- [ ] Keyboard navigation works throughout
- [ ] Aria labels present for accessibility

### Testing Criteria
```typescript
// test/phase-2/session-12/polish-performance.test.ts
describe('Session 12: Polish & Performance', () => {
  test('File tree virtual scrolling works', async () => {
    // Render 10,000 files
    // Verify only visible items in DOM
  });

  test('File tree loads under 500ms', async () => {
    // Time load for 1000 files
    // Assert < 500ms
  });

  test('Git status refreshes under 200ms', async () => {
    // Time git status fetch
    // Assert < 200ms
  });

  test('Command palette opens under 50ms', async () => {
    // Time Cmd+P to visible
    // Assert < 50ms
  });

  test('Error boundary catches component errors', async () => {
    // Throw error in component
    // Verify boundary UI shown
  });

  test('Toast shows on git commit success', async () => {
    // Commit successfully
    // Verify success toast
  });

  test('Toast shows on git push failure', async () => {
    // Mock push failure
    // Verify error toast
  });

  test('Keyboard navigation in command palette', async () => {
    // Navigate with arrows and enter
    // Verify correct behavior
  });

  test('Aria labels present', async () => {
    // Query aria-label attributes
    // Verify key elements labeled
  });
});
```

---

## Dependencies & Order

```
Session 1 (File Tree Foundation)
    |
    v
Session 2 (File Tree Git Integration)
    |
    +---> Session 5 (Diff Viewer)
    |
    v
Session 3 (Git Status & Stage)
    |
    v
Session 4 (Commit, Push, Pull)
    |
    +----------------------------------+
    |                                  |
    v                                  v
Session 6 (Command Palette)    Session 9 (Chat Layout)
    |                                  |
    v                                  v
Session 7 (Keyboard Shortcuts) Session 10 (Tool Messages)
    |                                  |
    v                                  v
Session 8 (Settings Panel)     Session 11 (Build/Plan Mode)
    |                                  |
    +----------------------------------+
                    |
                    v
            Session 12 (Polish & Performance)
```

### Parallel Tracks
- **Track A** (Git & File Tree): Sessions 1 → 2 → 3 → 4 → 5
- **Track B** (Commands & Settings): Sessions 6 → 7 → 8
- **Track C** (Chat Experience): Sessions 9 → 10 → 11

Track A must complete Sessions 1-2 before Track B and C can integrate git commands.

---

## Notes

### Assumed Phase 1 Infrastructure
- Electron + Vite + React + TypeScript
- SQLite database with projects, worktrees, sessions tables
- Zustand stores for projects, worktrees, sessions
- IPC communication pattern
- shadcn/ui components
- simple-git integration

### Out of Scope (Phase 2)
Per PRD Phase 2, these are NOT included:
- Cloud sync / backup
- Team collaboration
- Plugin / extension system
- Merge conflict resolution UI
- Interactive rebase
- Git blame view
- File rename/move/delete from UI
- Multiple windows
- Onboarding / tutorial flow
- Auto-updates

### Performance Targets
| Operation | Target |
|-----------|--------|
| File Tree Load (1000 files) | < 500ms |
| Git Status Refresh | < 200ms |
| Command Palette Open | < 50ms |
| File Watcher CPU (idle) | < 1% |
| Diff Render (500 lines) | < 100ms |
| Tool Message Render | < 50ms |
| Mode Toggle Response | < 100ms |
| Auto-Session Creation | < 2s |
