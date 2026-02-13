# Hive Implementation Plan

This document outlines the implementation plan for Hive, an Electron-based desktop application for managing multiple git projects and their worktrees with integrated OpenCode AI sessions.

---

## Overview

The implementation is divided into **11 focused sessions**, each with:

- Clear objectives
- Definition of done
- Testing criteria for verification

---

## Testing Infrastructure

### Test Stack

- **Vitest** - Fast, Vite-native unit testing (shared config with Electron-Vite)
- **React Testing Library** - Component testing with user-centric approach
- **Playwright** - E2E testing with official Electron support
- **@testing-library/user-event** - Realistic user interaction simulation
- **In-memory SQLite** - Database test isolation

### Test File Structure

```
test/
├── setup.ts                    # Global test setup
├── utils/
│   ├── electron-test-utils.ts  # Electron testing helpers
│   └── db-test-utils.ts        # Database testing helpers
├── session-1/
│   └── scaffolding.test.ts
├── session-2/
│   └── layout.test.ts
├── session-3/
│   └── database.test.ts
├── session-4/
│   └── projects.test.ts
├── session-5/
│   └── worktrees.test.ts
├── session-6/
│   └── theming.test.ts
├── session-7/
│   └── session-tabs.test.ts
├── session-8/
│   └── session-view.test.ts
├── session-9/
│   └── session-history.test.ts
├── session-10/
│   └── polish.test.ts
└── session-11/
    └── opencode-integration.test.ts
```

---

## Session 1: Project Scaffolding & Core Infrastructure

### Objectives

- Initialize Electron + Vite + React + TypeScript project
- Set up Tailwind CSS and shadcn/ui
- Configure project structure as per PRD
- Set up development tooling (ESLint, Prettier, pnpm)

### Tasks

1. Initialize Electron-Vite project with React + TypeScript template
2. Configure pnpm as package manager
3. Set up Tailwind CSS with dark mode support
4. Initialize shadcn/ui with required components
5. Create directory structure as per PRD architecture
6. Configure TypeScript paths and aliases
7. Set up ESLint and Prettier configurations
8. Create basic window with proper Electron security settings
9. Set up preload script with context bridge
10. Set up Vitest, React Testing Library, and Playwright

### Definition of Done

- [ ] Project builds successfully with `pnpm build`
- [ ] Development server runs with `pnpm dev`
- [ ] Electron window opens with React app rendered
- [ ] Tailwind CSS classes work correctly
- [ ] shadcn/ui Button component renders properly
- [ ] Dark/light mode toggles work via Tailwind classes
- [ ] Context isolation is enabled, nodeIntegration is disabled
- [ ] Preload script exposes typed API to renderer
- [ ] Test suite runs with `pnpm test`

### Testing Criteria

```typescript
// test/session-1/scaffolding.test.ts
describe('Session 1: Project Scaffolding', () => {
  test('Electron app launches without errors', async () => {
    // App should launch and create main window
  })

  test('React app renders in renderer process', async () => {
    // Verify React root element exists
  })

  test('Tailwind CSS classes are applied', async () => {
    // Verify a test element has correct Tailwind styles
  })

  test('shadcn/ui components render correctly', async () => {
    // Verify Button component renders with correct styling
  })

  test('Preload API is available in renderer', async () => {
    // Verify window.db exists and has query methods
  })

  test('Context isolation is enabled', async () => {
    // Verify window.require is undefined
    // Verify window.process is undefined
  })
})
```

---

## Session 2: Application Layout & UI Shell

### Objectives

- Implement the three-panel layout (Left Sidebar, Main Pane, Right Sidebar)
- Create resizable panels with proper constraints
- Build collapsible right sidebar
- Add window title bar and basic chrome

### Tasks

1. Create `LeftSidebar.tsx` component (240px default, 200-400px resizable)
2. Create `MainPane.tsx` component (fills remaining space)
3. Create `RightSidebar.tsx` component (280px, collapsible placeholder)
4. Implement resize handles between panels
5. Add resize constraints (min/max widths)
6. Persist panel sizes to localStorage
7. Create basic header/toolbar area
8. Add theme toggle button in header

### Definition of Done

- [ ] Three-panel layout renders correctly
- [ ] Left sidebar is resizable between 200-400px
- [ ] Right sidebar is collapsible via toggle button
- [ ] Panel sizes persist across app restarts
- [ ] Main pane fills remaining horizontal space
- [ ] Layout is responsive to window resize
- [ ] Theme toggle switches between dark/light modes
- [ ] Right sidebar shows "File Tree — Coming Soon" placeholder

### Testing Criteria

```typescript
// test/session-2/layout.test.ts
describe('Session 2: Application Layout', () => {
  test('Three-panel layout renders', async () => {
    // Verify all three panels exist in DOM
  })

  test('Left sidebar has correct default width', async () => {
    // Verify left sidebar is 240px wide
  })

  test('Left sidebar respects min/max constraints', async () => {
    // Attempt to resize below 200px - should be prevented
    // Attempt to resize above 400px - should be prevented
  })

  test('Right sidebar collapses and expands', async () => {
    // Click collapse button, verify width is 0 or hidden
    // Click expand button, verify width is restored
  })

  test('Panel sizes persist after restart', async () => {
    // Resize panel, reload app, verify size is preserved
  })

  test('Theme toggle switches modes', async () => {
    // Click toggle, verify body has 'dark' class
    // Click again, verify body does not have 'dark' class
  })

  test('Main pane fills remaining space', async () => {
    // Calculate expected width based on sidebar widths
    // Verify main pane width matches expected
  })
})
```

---

## Session 3: SQLite Database & Schema

### Objectives

- Set up SQLite database with better-sqlite3
- Implement schema as defined in PRD
- Create migration system
- Build database service with CRUD operations

### Tasks

1. Install and configure better-sqlite3
2. Create database initialization in main process
3. Implement schema creation (projects, worktrees, sessions, session_messages, settings)
4. Create migration system with version tracking
5. Build DatabaseService class with typed methods
6. Implement IPC handlers for database operations
7. Create database connection pooling/management
8. Add database location at `~/.hive/hive.db`

### Definition of Done

- [ ] Database file is created at `~/.hive/hive.db`
- [ ] All tables are created with correct schema
- [ ] Foreign key constraints work correctly
- [ ] Indexes are created for performance
- [ ] Migration system tracks and runs migrations
- [ ] DatabaseService provides typed CRUD operations
- [ ] IPC handlers expose database to renderer
- [ ] Database operations complete in < 50ms

### Testing Criteria

```typescript
// test/session-3/database.test.ts
describe('Session 3: Database', () => {
  test('Database file is created in correct location', async () => {
    // Verify ~/.hive/hive.db exists after app init
  })

  test('All tables are created', async () => {
    // Query sqlite_master for projects, worktrees, sessions,
    // session_messages, settings tables
  })

  test('Foreign key constraints are enforced', async () => {
    // Attempt to insert worktree with invalid project_id
    // Should throw constraint violation
  })

  test('Indexes exist for performance', async () => {
    // Query sqlite_master for expected indexes
  })

  test('Schema version is tracked', async () => {
    // Verify settings table has schema_version key
  })

  test('CRUD operations work for projects', async () => {
    // Create, Read, Update, Delete a project
  })

  test('CRUD operations work for worktrees', async () => {
    // Create project, then CRUD worktree
  })

  test('Cascade delete works', async () => {
    // Create project with worktrees and sessions
    // Delete project, verify children are deleted
  })

  test('Database operations complete under 50ms', async () => {
    // Time typical operations, assert < 50ms
  })
})
```

---

## Session 4: Project Management (Add/List/Remove)

### Objectives

- Implement project list in left sidebar
- Build "Add Project" functionality with folder picker
- Create project validation (git repo check)
- Implement project removal and context menu

### Tasks

1. Create `ProjectList.tsx` component
2. Create `ProjectItem.tsx` component with expand/collapse
3. Create `AddProjectButton.tsx` with folder picker dialog
4. Implement project validation (must be git repo)
5. Create Zustand store for projects (`useProjectStore.ts`)
6. Implement IPC handlers for project operations
7. Add context menu (Remove, Open in Finder, Copy Path, Edit Name)
8. Implement toast notifications for success/error states
9. Update lastAccessedAt on project interaction

### Definition of Done

- [ ] Project list displays all added projects
- [ ] "Add Project" button opens native folder picker
- [ ] Non-git directories are rejected with error toast
- [ ] Duplicate projects are rejected with error toast
- [ ] Projects are persisted to SQLite database
- [ ] Context menu works with all actions
- [ ] Projects can be removed from Hive
- [ ] Project names are editable
- [ ] lastAccessedAt updates on interaction

### Testing Criteria

```typescript
// test/session-4/projects.test.ts
describe('Session 4: Project Management', () => {
  test('Project list renders empty state', async () => {
    // Verify empty state message when no projects
  })

  test('Add project via folder picker', async () => {
    // Mock folder picker, verify project appears in list
  })

  test('Reject non-git directory', async () => {
    // Attempt to add non-git folder
    // Verify error toast appears
    // Verify project is not added
  })

  test('Reject duplicate project', async () => {
    // Add project, attempt to add same path again
    // Verify error toast appears
  })

  test('Project persists after restart', async () => {
    // Add project, restart app, verify project still listed
  })

  test('Remove project via context menu', async () => {
    // Right-click project, select Remove
    // Verify project is removed from list
    // Verify project is removed from database
  })

  test('Open in Finder works', async () => {
    // Verify shell.showItemInFolder is called with correct path
  })

  test('Copy path to clipboard', async () => {
    // Verify clipboard.writeText is called with project path
  })

  test('Edit project name', async () => {
    // Edit name, verify database is updated
    // Verify UI reflects new name
  })

  test('lastAccessedAt updates on interaction', async () => {
    // Click project, verify timestamp updated
  })
})
```

---

## Session 5: Git Service & Worktree Operations

### Objectives

- Implement Git service using simple-git
- Build worktree creation with city naming algorithm
- Implement worktree list display
- Create worktree actions (Archive, Unbranch, etc.)

### Tasks

1. Install and configure simple-git
2. Create GitService class in main process
3. Implement city name selection algorithm with collision handling
4. Create worktree at `~/.hive-worktrees/{project}/{city}`
5. Create `WorktreeList.tsx` and `WorktreeItem.tsx` components
6. Implement worktree creation flow ("+" button)
7. Implement Archive action (remove worktree + delete branch)
8. Implement Unbranch action (remove worktree, keep branch)
9. Add Open in Terminal / Open in Editor actions
10. Create worktree context menu
11. Implement worktree synchronization on app startup
12. Create Zustand store for worktrees (`useWorktreeStore.ts`)

### Definition of Done

- [ ] Worktrees display under their parent project
- [ ] "+" button creates new worktree with city name
- [ ] City names avoid collisions with existing branches
- [ ] Worktrees are created at `~/.hive-worktrees/{project}/{city}`
- [ ] Archive removes worktree AND deletes branch
- [ ] Unbranch removes worktree but preserves branch
- [ ] Open in Terminal launches terminal at worktree path
- [ ] Open in Editor opens worktree in configured editor
- [ ] Worktree status syncs with actual git state on startup

### Testing Criteria

```typescript
// test/session-5/worktrees.test.ts
describe('Session 5: Git Worktree Operations', () => {
  test('Create worktree with city name', async () => {
    // Click "+" button on project
    // Verify worktree appears in list with city name
    // Verify git worktree exists on disk
    // Verify git branch exists
  })

  test('City name avoids existing branch collision', async () => {
    // Create branch named "tokyo" manually
    // Create worktree, verify name is not "tokyo"
  })

  test('City name adds suffix after 10 collisions', async () => {
    // Mock random to always return same cities
    // Verify suffix (-v1, -v2) is added
  })

  test('Worktree path is correct', async () => {
    // Verify path is ~/.hive-worktrees/{project-name}/{city-name}
  })

  test('Archive removes worktree and branch', async () => {
    // Create worktree, archive it
    // Verify worktree directory deleted
    // Verify git branch deleted
    // Verify status is "archived" in database
  })

  test('Unbranch removes worktree but keeps branch', async () => {
    // Create worktree, unbranch it
    // Verify worktree directory deleted
    // Verify git branch still exists
  })

  test('Open in Terminal launches terminal', async () => {
    // Verify correct shell command is executed
  })

  test('Worktree sync detects missing worktrees', async () => {
    // Create worktree, manually delete directory
    // Restart app, verify worktree is marked appropriately
  })

  test('Clicking worktree sets it as active', async () => {
    // Click worktree, verify it becomes active selection
    // Verify lastAccessedAt is updated
  })
})
```

---

## Session 6: Theme System & Settings Persistence

### Objectives

- Implement complete theming system (dark/light/system)
- Create settings persistence in SQLite
- Build theme toggle UI with proper state management

### Tasks

1. Create Zustand theme store (`useThemeStore.ts`)
2. Implement CSS variables for theming (shadcn/ui approach)
3. Add system theme detection (prefers-color-scheme)
4. Create theme toggle dropdown (Dark / Light / System)
5. Persist theme preference to SQLite settings table
6. Apply theme class to document on app load
7. Listen for system theme changes when "System" selected
8. Create IPC handlers for settings operations

### Definition of Done

- [ ] Three theme options available: Dark, Light, System
- [ ] Theme persists across app restarts
- [ ] "System" option follows OS preference
- [ ] Theme changes apply immediately without flicker
- [ ] All UI components respect current theme
- [ ] Theme is readable from SQLite settings table
- [ ] System theme changes are detected in real-time

### Testing Criteria

```typescript
// test/session-6/theming.test.ts
describe('Session 6: Theme System', () => {
  test('Default theme is dark', async () => {
    // Fresh install, verify dark theme is applied
  })

  test('Theme toggle cycles through options', async () => {
    // Click toggle, verify each option is applied
  })

  test('Theme persists after restart', async () => {
    // Set to light, restart, verify light is applied
  })

  test('System theme follows OS preference', async () => {
    // Set to system, mock OS preference
    // Verify correct theme is applied
  })

  test('All shadcn components respect theme', async () => {
    // Render various components
    // Verify CSS variables are applied correctly
  })

  test('Theme setting is stored in database', async () => {
    // Query settings table for theme key
    // Verify value matches current theme
  })

  test('No flash of wrong theme on load', async () => {
    // Set theme, reload, measure time to correct theme
    // Should be applied before first paint
  })
})
```

---

## Session 7: Session Tabs & Tab Management

### Objectives

- Implement session tab bar UI
- Build tab creation, switching, closing
- Implement tab drag-to-reorder
- Create session Zustand store

### Tasks

1. Create `SessionTabs.tsx` component
2. Create Zustand store for sessions (`useSessionStore.ts`)
3. Implement tab switching
4. Implement tab close (x button, middle-click)
5. Implement "+" button to create new session
6. Add tab drag-to-reorder functionality
7. Implement tab overflow with scroll arrows
8. Create session data model in database
9. Link sessions to active worktree
10. Show empty state when no sessions

### Definition of Done

- [ ] Tab bar renders for active worktree
- [ ] Clicking tab switches active session
- [ ] "+" button creates new session tab
- [ ] x button closes session tab
- [ ] Middle-click closes session tab
- [ ] Tabs can be reordered via drag-and-drop
- [ ] Tab overflow shows scroll arrows
- [ ] Sessions are persisted to database
- [ ] Switching worktrees shows that worktree's sessions

### Testing Criteria

```typescript
// test/session-7/session-tabs.test.ts
describe('Session 7: Session Tabs', () => {
  test('Tab bar renders for active worktree', async () => {
    // Select worktree, verify tab bar appears
  })

  test('Create new session via + button', async () => {
    // Click +, verify new tab appears
    // Verify session in database
  })

  test('Click tab switches active session', async () => {
    // Create multiple tabs, click each
    // Verify content area updates
  })

  test('Close tab via x button', async () => {
    // Click x, verify tab is removed
  })

  test('Close tab via middle-click', async () => {
    // Middle-click tab, verify tab is removed
  })

  test('Drag tab to reorder', async () => {
    // Create 3 tabs, drag first to last
    // Verify order is updated in UI and database
  })

  test('Tab overflow shows scroll arrows', async () => {
    // Create many tabs, verify arrows appear
    // Click arrows, verify scroll behavior
  })

  test('Switching worktree shows different sessions', async () => {
    // Create sessions in worktree A
    // Switch to worktree B
    // Verify different sessions shown
  })

  test('Empty state when no sessions', async () => {
    // Select worktree with no sessions
    // Verify empty state message
  })
})
```

---

## Session 8: Session View (Placeholder) & Basic Layout

### Objectives

- Create session view placeholder UI
- Build message list structure
- Create input area structure
- Prepare for OpenCode integration

### Tasks

1. Create `SessionView.tsx` component
2. Design message list layout (scrollable)
3. Create message input area (textarea + send button)
4. Add placeholder content for demo
5. Create loading/connecting state UI
6. Create error state UI
7. Design code block component structure
8. Prepare interface types for OpenCode integration

### Definition of Done

- [ ] Session view renders when session tab is active
- [ ] Message list area is scrollable
- [ ] Input area has textarea and send button
- [ ] Placeholder messages demonstrate layout
- [ ] Loading spinner shows during "connecting"
- [ ] Error state shows retry option
- [ ] Code blocks have syntax highlighting placeholder
- [ ] Interface types match OpenCode SDK expectations

### Testing Criteria

```typescript
// test/session-8/session-view.test.ts
describe('Session 8: Session View', () => {
  test('Session view renders for active tab', async () => {
    // Select tab, verify session view appears
  })

  test('Message list is scrollable', async () => {
    // Add many messages, verify scroll works
  })

  test('Input area accepts text', async () => {
    // Type in textarea, verify value updates
  })

  test('Send button is present', async () => {
    // Verify send button exists and is clickable
  })

  test('Loading state shows spinner', async () => {
    // Set loading state, verify spinner visible
  })

  test('Error state shows retry button', async () => {
    // Set error state, verify retry button visible
  })

  test('Code block structure renders', async () => {
    // Add code message, verify code block styling
  })
})
```

---

## Session 9: Session History & Search

### Objectives

- Implement session history panel
- Build search across sessions
- Create filter by project/worktree/date
- Handle orphaned sessions display

### Tasks

1. Create `SessionHistory.tsx` component
2. Implement history panel UI (modal or slide-out)
3. Build search input with keyword search
4. Implement filter by project dropdown
5. Implement filter by worktree (including archived)
6. Implement date range filter
7. Create session preview on hover/select
8. Implement "Load into tab" action
9. Style orphaned sessions with visual indicator
10. Add keyboard shortcut (Cmd/Ctrl + K) for quick access

### Definition of Done

- [ ] Session history panel opens via menu/shortcut
- [ ] Search finds sessions by keyword
- [ ] Filter by project works
- [ ] Filter by worktree works (including archived)
- [ ] Date range filter works
- [ ] Session preview shows content snippet
- [ ] "Load" action opens session in new tab
- [ ] Orphaned sessions have visual indicator (muted/italic)
- [ ] Cmd/Ctrl + K opens history panel

### Testing Criteria

```typescript
// test/session-9/session-history.test.ts
describe('Session 9: Session History', () => {
  test('History panel opens via keyboard shortcut', async () => {
    // Press Cmd+K, verify panel opens
  })

  test('Search finds sessions by keyword', async () => {
    // Create sessions with specific content
    // Search for keyword, verify matches shown
  })

  test('Filter by project', async () => {
    // Create sessions in different projects
    // Filter by one project, verify only those shown
  })

  test('Filter by worktree includes archived', async () => {
    // Create archived worktree with sessions
    // Filter by archived worktree, verify sessions shown
  })

  test('Date range filter works', async () => {
    // Create sessions on different dates
    // Filter by range, verify correct sessions
  })

  test('Session preview shows content', async () => {
    // Hover/select session, verify preview appears
  })

  test('Load session into new tab', async () => {
    // Click load, verify tab appears with session
  })

  test('Orphaned sessions have visual indicator', async () => {
    // Archive worktree, view its sessions
    // Verify muted/italic styling
  })
})
```

---

## Session 10: Error Handling, Logging & Polish

### Objectives

- Implement comprehensive error handling
- Set up logging system
- Add toast notifications
- Final UI polish and performance optimization

### Tasks

1. Create logging service (writes to `~/.hive/logs/`)
2. Implement error boundary components
3. Create toast notification system
4. Add loading states to all async operations
5. Implement graceful degradation for git failures
6. Add retry options where appropriate
7. Optimize database queries with proper indexing
8. Add performance monitoring for key operations
9. Verify < 3 second launch time
10. Verify < 200MB idle memory
11. Final UI polish pass

### Definition of Done

- [ ] Logs are written to `~/.hive/logs/`
- [ ] Error boundaries catch and display React errors
- [ ] Toast notifications show for all user actions
- [ ] Loading spinners on all async operations
- [ ] Git operation failures show helpful messages
- [ ] Retry buttons work for recoverable errors
- [ ] App launches in < 3 seconds
- [ ] Idle memory < 200MB
- [ ] UI feedback < 100ms for interactions
- [ ] Database queries < 50ms

### Testing Criteria

```typescript
// test/session-10/polish.test.ts
describe('Session 10: Error Handling & Polish', () => {
  test('Logs are created in correct location', async () => {
    // Trigger log event, verify file in ~/.hive/logs/
  })

  test('Error boundary catches React errors', async () => {
    // Throw error in component, verify boundary UI
  })

  test('Toast shows on project add success', async () => {
    // Add project, verify success toast
  })

  test('Toast shows on project add failure', async () => {
    // Add invalid project, verify error toast
  })

  test('Loading spinner shows during git operations', async () => {
    // Trigger git operation, verify spinner visible
  })

  test('Git failure shows helpful error message', async () => {
    // Mock git failure, verify user-friendly message
  })

  test('App launches in under 3 seconds', async () => {
    // Time from launch to interactive
  })

  test('Idle memory is under 200MB', async () => {
    // Measure memory after idle period
  })

  test('UI feedback is under 100ms', async () => {
    // Time click to visual feedback
  })

  test('Database queries complete under 50ms', async () => {
    // Time typical queries
  })
})
```

---

## Session 11: OpenCode SDK Integration

### Objectives

- Integrate OpenCode SDK for AI coding sessions
- Implement real-time streaming responses
- Connect session UI to actual OpenCode backend
- Handle session lifecycle management

### Tasks

1. Install and configure OpenCode SDK
2. Create OpenCodeService class in main process
3. Implement process spawning for OpenCode sessions
4. Create IPC streaming channel for real-time responses
5. Connect SessionView to OpenCode backend
6. Implement message sending functionality
7. Implement streaming response display
8. Handle session connection/disconnection lifecycle
9. Implement session history retrieval from OpenCode
10. Add code block actions (copy, apply)
11. Handle OpenCode errors gracefully

### Definition of Done

- [ ] OpenCode SDK is installed and configured
- [ ] Sessions connect to OpenCode backend
- [ ] User messages are sent to OpenCode
- [ ] Streaming responses display in real-time
- [ ] Code blocks render with syntax highlighting
- [ ] Copy code action works
- [ ] Session history loads from OpenCode
- [ ] Connection errors show user-friendly messages
- [ ] Disconnection is handled gracefully
- [ ] Multiple concurrent sessions work correctly

### Testing Criteria

```typescript
// test/session-11/opencode-integration.test.ts
describe('Session 11: OpenCode Integration', () => {
  test('OpenCode service initializes correctly', async () => {
    // Verify OpenCodeService is available in main process
  })

  test('Session connects to OpenCode backend', async () => {
    // Create session, verify connection established
  })

  test('User message is sent to OpenCode', async () => {
    // Type message, click send
    // Verify message sent to OpenCode API
  })

  test('Streaming response displays in real-time', async () => {
    // Send message, verify response streams character by character
  })

  test('Code blocks render with syntax highlighting', async () => {
    // Receive code response, verify syntax highlighting applied
  })

  test('Copy code action copies to clipboard', async () => {
    // Click copy on code block
    // Verify clipboard contains code
  })

  test('Session history loads correctly', async () => {
    // Open existing session, verify history displayed
  })

  test('Connection error shows retry option', async () => {
    // Mock connection failure
    // Verify error message and retry button
  })

  test('Multiple sessions work concurrently', async () => {
    // Open 3 sessions in different tabs
    // Send messages to each, verify independent operation
  })

  test('Session disconnects cleanly on close', async () => {
    // Close session tab
    // Verify OpenCode connection is terminated
  })
})
```

---

## Dependencies & Order

```
Session 1 (Scaffolding)
    |
    v
Session 2 (Layout)
    |
    +------------------+
    |                  |
    v                  v
Session 3 (Database)   Session 6 (Theming) [can run parallel]
    |
    v
Session 4 (Projects)
    |
    v
Session 5 (Worktrees)
    |
    v
Session 7 (Session Tabs)
    |
    v
Session 8 (Session View)
    |
    v
Session 9 (Session History)
    |
    v
Session 10 (Polish)
    |
    v
Session 11 (OpenCode Integration)
```

---

## Notes

### OpenCode Integration (Session 11)

Session 11 requires OpenCode SDK documentation. Implementation details include:

- Process spawning in main process
- IPC streaming for real-time responses
- Session lifecycle management

This session can begin once OpenCode SDK documentation is available.

### Right Sidebar

The right sidebar is explicitly a placeholder in v1. Implementation in Session 2 is minimal (collapsible panel with "Coming Soon" message).

### Out of Scope Reminders

Per PRD, these are NOT included in v1:

- Keyboard shortcuts customization
- Plugin system
- Cloud sync
- Team features
- Advanced git operations (commits, push, pull, merge)
- Multiple windows
- Auto-updates
- Onboarding flow
- Command palette (except Cmd+K for session history)
