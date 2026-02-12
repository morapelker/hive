# Hive - Product Requirements Document

## Overview

**Hive** is an Electron-based desktop application for managing multiple git projects and their worktrees, with integrated OpenCode AI coding sessions. It provides a streamlined interface for developers who work across multiple repositories and branches simultaneously.

---

## Technical Stack

| Layer | Technology |
|-------|------------|
| Framework | Electron (latest stable) |
| Frontend | React 18+ with TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| State Management | Zustand |
| Database | SQLite (via better-sqlite3) |
| Build Tool | Electron Vite |
| Package Manager | pnpm |
| Git Operations | simple-git |
| Icons | lucide-react |

---

## Application Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  Window Title Bar                                                   │
├────────────────┬─────────────────────────────┬──────────────────────┤
│                │                             │                      │
│  Left Sidebar  │     Main Pane               │   Right Sidebar      │
│  (Projects)    │     (OpenCode Sessions)     │   (Placeholder)      │
│                │                             │                      │
│  - Project A   │  ┌─────┬─────┬─────┐        │   Future:            │
│    ├─ tokyo    │  │ Tab │ Tab │ Tab │        │   - File Tree        │
│    ├─ paris    │  ├─────┴─────┴─────┤        │   - Changed Files    │
│    └─ london   │  │                 │        │                      │
│  - Project B   │  │  Session View   │        │                      │
│    └─ berlin   │  │                 │        │                      │
│                │  │                 │        │                      │
│  [+ Add Proj]  │  └─────────────────┘        │                      │
│                │                             │                      │
└────────────────┴─────────────────────────────┴──────────────────────┘
```

### Panel Dimensions
- **Left Sidebar**: 240px default, resizable (min: 200px, max: 400px)
- **Right Sidebar**: 280px default, resizable, collapsible
- **Main Pane**: Fills remaining space

---

## Features

### 1. Project Management (Left Sidebar)

#### 1.1 Project List
- Display all added projects in a vertical scrollable list
- Each project item shows:
  - **Project name** (derived from folder name or custom)
  - **Path indicator** (tooltip on hover)
  - **Expand/collapse chevron** for worktrees
  - **"+" button** to create new worktree (visible on hover or always)
- Context menu (right-click):
  - Remove project from Hive
  - Open in Finder/Explorer
  - Copy path to clipboard
  - Edit project name

#### 1.2 Add Project
- "Add Project" button fixed at bottom of sidebar
- Opens native OS folder picker dialog
- **Validation**:
  - Must be a valid directory
  - Must be a git repository (contains `.git`)
  - Must not already be added
- On success: stores project in SQLite database
- On failure: displays appropriate error toast

#### 1.3 Project Data Model
```typescript
interface Project {
  id: string;              // UUID v4
  name: string;            // Display name (default: folder name)
  path: string;            // Absolute path to git repo root
  description?: string;    // Optional user description
  tags?: string[];         // Optional tags for organization
  createdAt: string;       // ISO 8601 timestamp
  lastAccessedAt: string;  // ISO 8601 timestamp
}
```

---

### 2. Git Worktree Management

#### 2.1 Worktree Display
- Worktrees displayed as expandable tree under each project
- **Default state**: expanded
- Only explicitly created worktrees are shown (main/master branch does NOT appear)
- Each worktree item shows:
  - City name (branch name)
  - Active session count badge (if > 0)
  - Status indicator (active/archived)
- Clicking a worktree:
  - Sets it as the active worktree
  - Loads its sessions in the main pane
  - Updates `lastAccessedAt` timestamp

#### 2.2 Worktree Creation
Triggered by "+" button next to project name.

**Auto-naming Algorithm**:
```
1. Select random city from CITY_NAMES list
2. Normalize to lowercase with hyphens (e.g., "New York" → "new-york")
3. Check if branch name exists in repository (git branch --list)
4. If exists:
   a. Pick another random city (track tried cities to avoid repeats)
   b. Repeat up to 10 attempts
5. After 10 collisions, append suffix: "-v1", "-v2", etc.
6. Create git branch: git branch {city-name}
7. Create worktree at: ~/.hive-worktrees/{project-name}/{city-name}
   Command: git worktree add {path} {branch-name}
```

**Worktree Storage Location**:
```
~/.hive-worktrees/
├── project-alpha/
│   ├── tokyo/
│   ├── paris/
│   └── london/
└── project-beta/
    └── berlin/
```

#### 2.3 Worktree Actions
Available via context menu (right-click) or overflow menu:

| Action | Behavior |
|--------|----------|
| **Archive** | Removes worktree (`git worktree remove`) AND deletes branch (`git branch -D`). Sessions marked as orphaned. |
| **Unbranch** | Removes worktree only (`git worktree remove`), preserves branch for future use. Sessions marked as orphaned. |
| **Open in Terminal** | Opens worktree path in default terminal app |
| **Open in Editor** | Opens worktree path in VS Code (or configured editor) |
| **Copy Path** | Copies worktree absolute path to clipboard |

#### 2.4 Worktree Data Model
```typescript
interface Worktree {
  id: string;              // UUID v4
  projectId: string;       // FK to Project.id
  name: string;            // City name (display)
  branchName: string;      // Git branch name (same as name, lowercase-hyphenated)
  path: string;            // Absolute path: ~/.hive-worktrees/{project}/{city}
  status: 'active' | 'archived';
  createdAt: string;       // ISO 8601
  lastAccessedAt: string;  // ISO 8601
}
```

#### 2.5 Worktree Synchronization
On app startup and periodically:
- Verify worktree paths still exist on disk
- Sync with `git worktree list` output
- Mark missing worktrees appropriately
- Clean up orphaned database entries

---

### 3. OpenCode Sessions (Main Pane)

#### 3.1 Session Tabs
- Horizontal tab bar at top of main pane
- Tabs for the **currently selected worktree** only
- Each tab displays:
  - Session name or auto-generated title (first message snippet)
  - Close button (×)
  - Active/loading indicator
- Tab interactions:
  - Click to switch active session
  - Drag to reorder
  - Middle-click or × to close
  - "+" button at end to create new session
- Tab overflow: horizontal scroll with arrow buttons when many tabs

#### 3.2 Session View
The main content area below the tab bar.

**TODO: OpenCode SDK Integration**
```typescript
// Placeholder for OpenCode SDK integration
// Implementation details to be determined based on OpenCode SDK documentation

interface OpenCodeIntegration {
  // Initialize connection to OpenCode for a worktree path
  connect(worktreePath: string): Promise<OpenCodeSession>;
  
  // Send message to active session
  sendMessage(sessionId: string, message: string): Promise<void>;
  
  // Subscribe to streaming responses
  onResponse(sessionId: string, callback: (chunk: string) => void): void;
  
  // Get session history
  getHistory(sessionId: string): Promise<Message[]>;
  
  // Terminate session
  disconnect(sessionId: string): Promise<void>;
}
```

**Session View Components** (to be implemented):
- Conversation history (scrollable)
- User message input area
- Streaming response display
- Code block rendering with syntax highlighting
- Copy/apply code actions

#### 3.3 Session History
Access via:
- Command palette (Cmd/Ctrl + K → "Load Session")
- Menu: File → Load Session from History

**History Panel Features**:
- Search by keywords across all sessions
- Filter by:
  - Project
  - Worktree (including archived/orphaned)
  - Date range
  - Status (completed, orphaned)
- Session preview on hover/select
- Load into new tab action

**Orphaned Sessions**:
- Sessions whose worktree was archived/unbranched
- Displayed with visual indicator (muted, italic, or badge)
- Still searchable and loadable (read-only context)

#### 3.4 Session Data Model
```typescript
interface Session {
  id: string;              // UUID v4
  worktreeId: string;      // FK to Worktree.id (nullable if orphaned)
  projectId: string;       // FK to Project.id (for orphan context)
  name?: string;           // Optional user-defined name
  status: 'active' | 'completed' | 'orphaned' | 'error';
  opencodeSessionId?: string;  // External ID from OpenCode SDK
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  completedAt?: string;    // ISO 8601
}

interface SessionMessage {
  id: string;
  sessionId: string;       // FK to Session.id
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;       // ISO 8601
}
```

---

### 4. Right Sidebar (Placeholder)

#### 4.1 Current Implementation
- Static placeholder panel
- Display text: "File Tree — Coming Soon"
- Collapsible via toggle button or drag

#### 4.2 Future Scope (Not v1)
- File tree for current worktree
- Git status indicators on files
- Changed files list
- Quick file actions

---

### 5. Theming

#### 5.1 Supported Themes
- **Dark mode** (default)
- **Light mode**
- **System** (follows OS preference)

#### 5.2 Implementation
- Tailwind CSS `class` dark mode strategy
- shadcn/ui CSS variables for component theming
- Theme toggle in header/toolbar area
- Preference persisted in SQLite `settings` table

---

### 6. Data Persistence

#### 6.1 SQLite Database

**Location**: `~/.hive/hive.db`

**Tables**:

```sql
-- Projects table
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  tags TEXT,  -- JSON array
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Worktrees table
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opencode_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- Session messages table (for history/search)
CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Settings table
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_worktrees_project ON worktrees(project_id);
CREATE INDEX idx_sessions_worktree ON sessions(worktree_id);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_messages_session ON session_messages(session_id);
```

#### 6.2 Schema Migrations
- Version tracked in `settings` table (`schema_version`)
- Migrations run automatically on app startup
- Migration files in `src/main/db/migrations/`

---

### 7. Application Architecture

#### 7.1 Process Model

```
┌─────────────────────────────────────────────────────────────────┐
│                       Main Process                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  SQLite Service │  │  Git Service    │  │ OpenCode Manager│  │
│  │  (better-sqlite3│  │  (simple-git)   │  │ (child processes│  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                              │                                   │
│                    IPC Handlers (typed)                          │
└──────────────────────────────┬──────────────────────────────────┘
                               │ contextBridge / preload
┌──────────────────────────────▼──────────────────────────────────┐
│                      Renderer Process                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    React Application                         ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐      ││
│  │  │ Zustand     │  │ Components  │  │ IPC Client      │      ││
│  │  │ Stores      │  │ (shadcn/ui) │  │ (typed hooks)   │      ││
│  │  └─────────────┘  └─────────────┘  └─────────────────┘      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

#### 7.2 Directory Structure

```
hive-electron/
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── components.json              # shadcn/ui config
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # Main entry point
│   │   ├── ipc/                 # IPC handlers
│   │   │   ├── projects.ts
│   │   │   ├── worktrees.ts
│   │   │   └── sessions.ts
│   │   ├── services/
│   │   │   ├── database.ts      # SQLite service
│   │   │   ├── git.ts           # Git operations
│   │   │   └── opencode.ts      # OpenCode process manager
│   │   └── db/
│   │       ├── schema.ts
│   │       └── migrations/
│   ├── preload/                 # Preload scripts
│   │   └── index.ts
│   └── renderer/                # React application
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── ui/              # shadcn/ui components
│       │   ├── layout/
│       │   │   ├── LeftSidebar.tsx
│       │   │   ├── MainPane.tsx
│       │   │   └── RightSidebar.tsx
│       │   ├── projects/
│       │   │   ├── ProjectList.tsx
│       │   │   ├── ProjectItem.tsx
│       │   │   └── AddProjectButton.tsx
│       │   ├── worktrees/
│       │   │   ├── WorktreeList.tsx
│       │   │   └── WorktreeItem.tsx
│       │   └── sessions/
│       │       ├── SessionTabs.tsx
│       │       ├── SessionView.tsx
│       │       └── SessionHistory.tsx
│       ├── stores/
│       │   ├── useProjectStore.ts
│       │   ├── useWorktreeStore.ts
│       │   ├── useSessionStore.ts
│       │   └── useThemeStore.ts
│       ├── hooks/
│       │   └── useIpc.ts
│       ├── lib/
│       │   └── utils.ts
│       └── styles/
│           └── globals.css
├── resources/                   # App icons, assets
└── scripts/                     # Build scripts
```

#### 7.3 IPC Communication

Type-safe IPC using a simple pattern:

```typescript
// shared/types.ts - Shared between main and renderer
interface IpcChannels {
  'projects:list': { args: void; return: Project[] };
  'projects:add': { args: { path: string }; return: Project };
  'projects:remove': { args: { id: string }; return: void };
  'worktrees:create': { args: { projectId: string }; return: Worktree };
  'worktrees:archive': { args: { id: string }; return: void };
  // ... etc
}

// preload/index.ts
contextBridge.exposeInMainWorld('api', {
  invoke: <K extends keyof IpcChannels>(
    channel: K,
    args: IpcChannels[K]['args']
  ): Promise<IpcChannels[K]['return']> => ipcRenderer.invoke(channel, args)
});
```

---

### 8. City Names for Worktree Naming

Comprehensive list of 200+ major world cities (lowercase, hyphenated):

```typescript
export const CITY_NAMES = [
  // Asia
  'tokyo', 'osaka', 'kyoto', 'seoul', 'busan', 'beijing', 'shanghai',
  'shenzhen', 'guangzhou', 'hong-kong', 'taipei', 'singapore',
  'bangkok', 'jakarta', 'manila', 'hanoi', 'ho-chi-minh', 'kuala-lumpur',
  'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'hyderabad',
  
  // Middle East
  'dubai', 'abu-dhabi', 'doha', 'riyadh', 'jeddah', 'tel-aviv',
  'jerusalem', 'beirut', 'amman', 'kuwait-city', 'muscat', 'manama',
  
  // Europe
  'london', 'paris', 'berlin', 'munich', 'frankfurt', 'hamburg',
  'amsterdam', 'rotterdam', 'brussels', 'antwerp', 'vienna', 'zurich',
  'geneva', 'milan', 'rome', 'florence', 'venice', 'naples', 'madrid',
  'barcelona', 'valencia', 'seville', 'lisbon', 'porto', 'dublin',
  'edinburgh', 'glasgow', 'manchester', 'birmingham', 'stockholm',
  'gothenburg', 'oslo', 'bergen', 'copenhagen', 'helsinki', 'prague',
  'budapest', 'warsaw', 'krakow', 'bucharest', 'sofia', 'athens',
  'thessaloniki', 'istanbul', 'moscow', 'saint-petersburg', 'kiev',
  'minsk', 'vilnius', 'riga', 'tallinn', 'zagreb', 'belgrade',
  'ljubljana', 'bratislava', 'luxembourg', 'monaco', 'reykjavik',
  
  // Africa
  'cairo', 'alexandria', 'casablanca', 'marrakech', 'tunis', 'algiers',
  'lagos', 'abuja', 'accra', 'nairobi', 'mombasa', 'addis-ababa',
  'johannesburg', 'cape-town', 'durban', 'pretoria', 'dar-es-salaam',
  'kampala', 'kigali', 'dakar', 'abidjan',
  
  // North America
  'new-york', 'los-angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
  'san-antonio', 'san-diego', 'dallas', 'austin', 'san-jose', 'san-francisco',
  'seattle', 'denver', 'boston', 'atlanta', 'miami', 'orlando', 'tampa',
  'portland', 'las-vegas', 'detroit', 'minneapolis', 'charlotte', 'nashville',
  'baltimore', 'milwaukee', 'pittsburgh', 'st-louis', 'indianapolis',
  'columbus', 'cleveland', 'cincinnati', 'kansas-city', 'new-orleans',
  'salt-lake-city', 'toronto', 'vancouver', 'montreal', 'calgary',
  'edmonton', 'ottawa', 'winnipeg', 'quebec-city', 'halifax',
  'mexico-city', 'guadalajara', 'monterrey', 'cancun', 'tijuana',
  
  // South America
  'sao-paulo', 'rio-de-janeiro', 'brasilia', 'salvador', 'fortaleza',
  'buenos-aires', 'cordoba', 'mendoza', 'santiago', 'valparaiso',
  'lima', 'bogota', 'medellin', 'cartagena', 'caracas', 'quito',
  'guayaquil', 'montevideo', 'asuncion', 'la-paz', 'santa-cruz',
  
  // Oceania
  'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'auckland',
  'wellington', 'christchurch', 'queenstown', 'fiji', 'honolulu',
  
  // Caribbean & Central America
  'havana', 'san-juan', 'santo-domingo', 'kingston', 'nassau',
  'panama-city', 'san-jose', 'guatemala-city', 'tegucigalpa', 'managua',
];
```

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| App Launch Time | < 3 seconds to interactive |
| Idle Memory | < 200 MB |
| UI Responsiveness | < 100ms feedback on interactions |
| Database Operations | < 50ms for typical queries |
| Git Operations | Async with loading indicators |

### Error Handling
- Graceful degradation when git operations fail
- Clear error messages in toast notifications
- Recovery options where possible (retry, skip, etc.)
- Logging to `~/.hive/logs/` for debugging

### Security
- No remote code execution
- Sanitize all paths and inputs
- Context isolation enabled
- Node integration disabled in renderer

---

## Out of Scope (v1)

- Keyboard shortcuts / customization
- Plugin / extension system
- Cloud sync / backup
- Team collaboration features
- Git operations beyond worktree (commits, push, pull, merge)
- Right sidebar file tree implementation
- Multiple windows
- Auto-updates
- Onboarding / tutorial flow
- Command palette (future v2)

---

## Open Items / Future Considerations

1. **Editor Integration**: How to determine "default editor" for "Open in Editor" action
2. **Terminal Integration**: Which terminal app to use (configurable in settings?)
3. **OpenCode Version Compatibility**: Minimum supported OpenCode version
4. **Worktree Cleanup**: Periodic cleanup of orphaned worktrees on disk
5. **Backup Strategy**: Should we offer database export/import?

---

## Success Metrics (Post-Launch)

- Users can add a project in < 30 seconds
- Users can create a worktree in < 5 seconds
- Session loading time < 2 seconds
- Zero data loss incidents
- Crash-free rate > 99.5%
