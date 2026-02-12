# Hive - Phase 2 Product Requirements Document

## Overview

**Phase 2** builds on the foundation established in Phase 1, focusing on **developer workflow enhancements**. The primary additions are a fully functional file tree in the right sidebar and basic Git operations (commit, push, pull) integrated into the UI.

### Phase 2 Goals
- Enable file navigation and exploration within worktrees
- Provide visual Git status indicators across the UI
- Allow basic Git operations without leaving the app
- Introduce command palette for quick actions
- Add customizable keyboard shortcuts
- Improve session and chat experience with modern UI patterns
- Support Build/Plan mode toggle for AI interactions

---

## Technical Additions

| Component | Technology |
|-----------|------------|
| File System Watching | chokidar |
| Git Diff Rendering | diff2html or custom |
| Command Palette | cmdk (patak-dev/cmdk) |
| Virtualized Lists | @tanstack/react-virtual |

---

## Features

### 1. File Tree (Right Sidebar)

#### 1.1 File Tree Display
The right sidebar transforms from placeholder to a fully functional file tree.

```
┌──────────────────────┐
│ 📁 src/              │  ← Expandable folder
│   📁 components/     │
│     📄 App.tsx    M  │  ← Modified indicator
│     📄 Header.tsx    │
│   📁 hooks/          │
│     📄 useApi.ts  A  │  ← Added (staged)
│   📄 index.ts        │
│ 📁 tests/            │
│ 📄 package.json   M  │
│ 📄 .gitignore        │
└──────────────────────┘
```

**Features**:
- Hierarchical folder/file display
- Expand/collapse folders (persisted per worktree)
- File icons based on extension (using file-icons or similar)
- Git status indicators inline:
  - `M` Modified (yellow)
  - `A` Added/Staged (green)
  - `D` Deleted (red)
  - `?` Untracked (gray)
  - `C` Conflicted (red, bold)
- Search/filter input at top of panel
- Lazy loading for large directories

#### 1.2 File Tree Interactions

| Action | Behavior |
|--------|----------|
| **Single Click** | Select file (highlight) |
| **Double Click** | Open in configured editor |
| **Right Click** | Context menu |
| **Drag & Drop** | Future: move files |

**Context Menu Options**:
- Open in Editor
- Open in Finder/Explorer
- Copy Path
- Copy Relative Path
- Rename (future)
- Delete (future, with confirmation)
- Add to .gitignore
- Stage File / Unstage File
- Discard Changes

#### 1.3 File Tree Header

```
┌──────────────────────────┐
│ Files           [−] [×]  │  ← Collapse/Close buttons
├──────────────────────────┤
│ 🔍 Filter files...       │  ← Quick filter
├──────────────────────────┤
│ 📁 src/                  │
│ ...                      │
└──────────────────────────┘
```

#### 1.4 File Tree Data Model

```typescript
interface FileTreeNode {
  name: string;
  path: string;           // Relative to worktree root
  absolutePath: string;   // Full system path
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  gitStatus?: GitFileStatus;
  isExpanded?: boolean;   // For directories
}

type GitFileStatus =
  | 'modified'      // M - Working tree modified
  | 'staged'        // A - Staged for commit
  | 'deleted'       // D - Deleted
  | 'untracked'     // ? - New file, not tracked
  | 'conflicted'    // C - Merge conflict
  | 'renamed'       // R - Renamed
  | 'ignored'       // ! - Ignored by .gitignore
  | 'unchanged';    // Clean

interface FileTreeState {
  worktreeId: string;
  rootPath: string;
  nodes: FileTreeNode[];
  expandedPaths: Set<string>;  // Persisted
  selectedPath: string | null;
  filterQuery: string;
}
```

#### 1.5 File System Watching
- Use `chokidar` to watch worktree directory
- Debounce updates (100ms) to prevent UI thrashing
- Ignore patterns: `node_modules`, `.git`, build directories
- Configurable ignore patterns in settings

---

### 2. Git Operations Panel

#### 2.1 Git Status Overview
A collapsible panel above or within the file tree showing Git summary.

```
┌──────────────────────────┐
│ Git Status         [↻]   │  ← Refresh button
├──────────────────────────┤
│ Branch: feature/login    │
│ ↑2 ↓1 from origin        │  ← Ahead/behind
├──────────────────────────┤
│ Staged (2)           [▼] │
│   📄 App.tsx             │
│   📄 api.ts              │
├──────────────────────────┤
│ Modified (3)         [▼] │
│   📄 Header.tsx          │
│   📄 styles.css          │
│   📄 utils.ts            │
├──────────────────────────┤
│ Untracked (1)        [▼] │
│   📄 newfile.ts          │
└──────────────────────────┘
```

#### 2.2 Commit Interface

```
┌──────────────────────────┐
│ Commit Message           │
├──────────────────────────┤
│ ┌──────────────────────┐ │
│ │ feat: add login      │ │  ← Summary line
│ ├──────────────────────┤ │
│ │ - Added OAuth flow   │ │  ← Description (optional)
│ │ - Updated tests      │ │
│ └──────────────────────┘ │
├──────────────────────────┤
│ [Stage All] [Commit]     │
└──────────────────────────┘
```

**Commit Features**:
- Two-part input: summary (required) + description (optional)
- Character count for summary (warn at 50+, error at 72+)
- Stage all / Unstage all buttons
- Individual file staging via checkboxes or drag
- Commit button (disabled if no staged files or empty message)
- Keyboard shortcut: `Cmd/Ctrl+Enter` to commit

#### 2.3 Push/Pull Interface

```
┌──────────────────────────┐
│ [↓ Pull]  [↑ Push]       │
├──────────────────────────┤
│ Last push: 2 hours ago   │
│ Remote: origin/main      │
└──────────────────────────┘
```

**Push Features**:
- Push current branch to tracked remote
- Force push option (with confirmation dialog)
- Set upstream if not set (`-u` flag)
- Progress indicator during operation

**Pull Features**:
- Pull from tracked remote
- Rebase option (`--rebase`)
- Handle merge conflicts (show conflict state, don't auto-resolve)
- Progress indicator during operation

#### 2.4 Git Operations Data Model

```typescript
interface GitStatus {
  branch: string;
  remoteBranch?: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  modified: GitFileChange[];
  untracked: string[];
  conflicted: string[];
}

interface GitFileChange {
  path: string;
  status: GitFileStatus;
  oldPath?: string;       // For renames
  additions?: number;     // Line count
  deletions?: number;
}

interface CommitOptions {
  message: string;
  description?: string;
  amend?: boolean;        // Future
}

interface PushOptions {
  force?: boolean;
  setUpstream?: boolean;
}

interface PullOptions {
  rebase?: boolean;
}
```

#### 2.5 Git IPC Handlers

```typescript
interface GitIpcChannels {
  'git:status': { args: { worktreeId: string }; return: GitStatus };
  'git:stage': { args: { worktreeId: string; paths: string[] }; return: void };
  'git:unstage': { args: { worktreeId: string; paths: string[] }; return: void };
  'git:commit': { args: { worktreeId: string; options: CommitOptions }; return: string }; // Returns commit hash
  'git:push': { args: { worktreeId: string; options?: PushOptions }; return: void };
  'git:pull': { args: { worktreeId: string; options?: PullOptions }; return: void };
  'git:discard': { args: { worktreeId: string; paths: string[] }; return: void };
  'git:diff': { args: { worktreeId: string; path: string }; return: string }; // Diff content
}
```

---

### 3. Command Palette

#### 3.1 Overview
A searchable command palette accessible via `Cmd/Ctrl+P`.

```
┌─────────────────────────────────────────────┐
│ 🔍 Type a command or search...              │
├─────────────────────────────────────────────┤
│ Recent                                      │
│   📂 Open Project: hive-electron            │
│   🌳 Switch to: tokyo                       │
├─────────────────────────────────────────────┤
│ Commands                                    │
│   📂 Open Project...              ⌘O        │
│   🌳 Create Worktree              ⌘N        │
│   💬 New Session                  ⌘T        │
│   📜 Session History              ⌘K        │
│   ⚙️  Open Settings               ⌘,        │
│   🎨 Toggle Theme                 ⌘⇧T       │
├─────────────────────────────────────────────┤
│ Git                                         │
│   ✓  Commit Changes               ⌘⇧C       │
│   ↑  Push                         ⌘⇧P       │
│   ↓  Pull                         ⌘⇧L       │
└─────────────────────────────────────────────┘
```

#### 3.2 Command Categories
- **Navigation**: Switch projects, worktrees, sessions
- **Actions**: Create worktree, new session, open history
- **Git**: Commit, push, pull, stage, discard
- **Settings**: Theme toggle, open preferences
- **Files**: Open file in editor, reveal in finder

#### 3.3 Command Palette Features
- Fuzzy search across all commands
- Recent commands section
- Keyboard navigation (arrows, enter, escape)
- Command shortcuts displayed inline
- Nested commands (e.g., "Switch to worktree" → shows worktree list)

#### 3.4 Command Data Model

```typescript
interface Command {
  id: string;
  label: string;
  category: 'navigation' | 'actions' | 'git' | 'settings' | 'files';
  icon?: string;          // Lucide icon name
  shortcut?: string;      // Display string (e.g., "⌘K")
  keywords?: string[];    // Additional search terms
  action: () => void | Promise<void>;
  when?: () => boolean;   // Condition for visibility
}

interface CommandPaletteState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  recentCommands: string[];  // Command IDs
}
```

---

### 4. Keyboard Shortcuts System

#### 4.1 Default Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Command Palette | `⌘P` | `Ctrl+P` |
| Session History | `⌘K` | `Ctrl+K` |
| **New Session** | `⌘N` | `Ctrl+N` |
| **Close Session** | `⌘W` | `Ctrl+W` |
| New Worktree | `⌘⇧N` | `Ctrl+Shift+N` |
| Open Project | `⌘O` | `Ctrl+O` |
| Settings | `⌘,` | `Ctrl+,` |
| Toggle Theme | `⌘⇧T` | `Ctrl+Shift+T` |
| **Toggle Build/Plan Mode** | `⇧Tab` | `Shift+Tab` |
| Git Commit | `⌘⇧C` | `Ctrl+Shift+C` |
| Git Push | `⌘⇧P` | `Ctrl+Shift+P` |
| Git Pull | `⌘⇧L` | `Ctrl+Shift+L` |
| Toggle Left Sidebar | `⌘B` | `Ctrl+B` |
| Toggle Right Sidebar | `⌘⇧B` | `Ctrl+Shift+B` |
| Focus File Tree | `⌘1` | `Ctrl+1` |
| Focus Session | `⌘2` | `Ctrl+2` |

**Session Shortcut Behaviors**:
- `⌘N` / `Ctrl+N`: Creates new session in current worktree (requires active worktree)
- `⌘W` / `Ctrl+W`: Closes current session tab. **Noop if no sessions are active** - does not close the app window

#### 4.2 Shortcut Customization
- Settings panel for viewing/editing shortcuts
- Conflict detection (warn if shortcut already used)
- Reset to defaults option
- Import/export shortcuts (JSON)

#### 4.3 Shortcut Data Model

```typescript
interface KeyboardShortcut {
  id: string;              // Unique action identifier
  label: string;           // Display name
  category: string;        // Grouping in settings
  defaultBinding: KeyBinding;
  currentBinding: KeyBinding;
}

interface KeyBinding {
  key: string;             // Primary key (e.g., "k", "Enter")
  modifiers: Modifier[];   // ["meta", "shift"]
}

type Modifier = 'meta' | 'ctrl' | 'alt' | 'shift';

// Stored in settings table
interface ShortcutOverrides {
  [actionId: string]: KeyBinding;
}
```

---

### 5. Settings Panel

#### 5.1 Settings Categories

```
┌─────────────────────────────────────────────┐
│ Settings                              [×]   │
├────────────┬────────────────────────────────┤
│ General    │ Theme                          │
│ Editor     │ ○ Light  ● Dark  ○ System      │
│ Terminal   │                                │
│ Git        │ Sidebar                        │
│ Shortcuts  │ □ Show file tree on startup    │
│            │                                │
│            │ Default Editor                 │
│            │ [VS Code           ▼]          │
│            │                                │
│            │ Default Terminal               │
│            │ [iTerm             ▼]          │
└────────────┴────────────────────────────────┘
```

#### 5.2 Settings Sections

**General**:
- Theme selection
- Sidebar visibility defaults
- Window behavior (restore on startup)

**Editor**:
- Default external editor (VS Code, Cursor, Sublime, etc.)
- Custom editor command

**Terminal**:
- Default terminal app (Terminal, iTerm, Warp, etc.)
- Custom terminal command

**Git**:
- Default commit message template
- Auto-fetch interval (or disabled)
- Sign commits (GPG)

**Shortcuts**:
- Full shortcut editor (see 4.2)

#### 5.3 Settings Data Model

```typescript
interface AppSettings {
  // General
  theme: 'light' | 'dark' | 'system';
  showFileTreeOnStartup: boolean;
  restoreWindowState: boolean;

  // Editor
  defaultEditor: 'vscode' | 'cursor' | 'sublime' | 'atom' | 'custom';
  customEditorCommand?: string;

  // Terminal
  defaultTerminal: 'terminal' | 'iterm' | 'warp' | 'hyper' | 'custom';
  customTerminalCommand?: string;

  // Git
  autoFetchInterval: number;  // Minutes, 0 = disabled
  signCommits: boolean;
  commitMessageTemplate?: string;

  // Shortcuts
  shortcutOverrides: ShortcutOverrides;

  // File Tree
  fileTreeIgnorePatterns: string[];  // Glob patterns
}
```

---

### 6. Diff Viewer

#### 6.1 Inline Diff Display
When viewing a file's changes, show a diff view.

```
┌─────────────────────────────────────────────┐
│ src/components/Header.tsx    [Split] [Uni] │
├─────────────────────────────────────────────┤
│  10 │   return (                            │
│  11 │-    <header className="old-class">    │  ← Deletion (red)
│  11 │+    <header className="new-class">    │  ← Addition (green)
│  12 │       <h1>Title</h1>                  │
│  13 │+      <nav>Navigation</nav>           │  ← New line
│  14 │     </header>                         │
└─────────────────────────────────────────────┘
```

**Diff View Options**:
- Unified view (default)
- Split view (side-by-side)
- Line-by-line navigation
- Copy old/new content

#### 6.2 Diff Modal
- Triggered from file tree context menu or Git status panel
- Modal with full diff content
- Stage/unstage individual hunks (future)

---

### 7. Session & Chat Experience

#### 7.1 Session Tab Bar Redesign

Move the "+" button (new session) to the left side of the tab bar for better UX.

```
┌─────────────────────────────────────────────────────────────┐
│ [+]  │ Session 1 │ Session 2 │ Session 3 │              │
└─────────────────────────────────────────────────────────────┘
  ↑
  New session button on left
```

**Rationale**: Left-aligned creation is more natural for LTR languages and follows common patterns (browser tabs, IDE tabs).

#### 7.2 Auto-Start Session on Worktree Selection

When a user selects a worktree that has no active sessions:
- Automatically create and connect to a new OpenCode session
- Show loading state during connection
- Display empty chat canvas ready for input

**Behavior Flow**:
```
User clicks worktree → Check for existing sessions
  ├─ Has sessions → Load most recent session
  └─ No sessions → Auto-create new session → Connect → Ready state
```

**Settings Option**:
- `autoStartSession: boolean` (default: true)
- Can be disabled in Settings → General

#### 7.3 Build/Plan Mode Toggle

Support two AI interaction modes toggled via `Shift+Tab`:

```
┌─────────────────────────────────────────────────────────────┐
│ Mode: [🔨 Build] [📋 Plan]           ← Toggle with Shift+Tab │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Chat content...                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

| Mode | Behavior |
|------|----------|
| **Build** (default) | AI executes changes directly, writes code, runs commands |
| **Plan** | AI creates detailed plans without executing, explains approach |

**Mode Indicator**:
- Visual toggle in session header/toolbar
- Current mode displayed prominently
- Keyboard shortcut: `Shift+Tab` to toggle
- Mode persisted per session

**Data Model**:
```typescript
interface SessionMode {
  mode: 'build' | 'plan';
}

// Add to Session interface
interface Session {
  // ... existing fields
  mode: 'build' | 'plan';  // NEW
}
```

#### 7.4 OpenCode Message Rendering Improvements

Fix the current rendering issues with streaming messages and tool calls.

**Current Problem**:
- Original message re-renders until response completes
- Tool messages not displayed as they execute
- Poor visual feedback during AI processing

**New Rendering Approach**:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                          ┌─────────────────────────────────┐│
│                          │ Can you fix the login bug?     ││  ← User bubble (right)
│                          └─────────────────────────────────┘│
│                                                             │
│ I'll investigate the login issue.                           │  ← Assistant text (left, no bubble)
│                                                             │
│ ┌─ Tool: Read ──────────────────────────────────────────┐  │
│ │ 📄 src/auth/login.ts                                   │  │  ← Tool message (collapsible)
│ │ Reading file... ✓                                      │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                             │
│ ┌─ Tool: Edit ──────────────────────────────────────────┐  │
│ │ 📝 src/auth/login.ts:45                                │  │
│ │ Applying changes... ⏳                                 │  │  ← In-progress indicator
│ └────────────────────────────────────────────────────────┘  │
│                                                             │
│ I found the issue. The session token wasn't being...        │  ← Streaming text continues
│ █                                                           │  ← Cursor during streaming
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Tool Message Types**:
| Tool | Display |
|------|---------|
| Read | File icon + path, collapsible content preview |
| Write | File icon + path, show diff or "Created file" |
| Edit | File icon + path + line, show changes |
| Bash | Terminal icon, command + output (collapsible) |
| Glob/Grep | Search icon, results count + collapsible list |

**Rendering States**:
- `pending` - Tool call initiated, spinner
- `running` - Actively executing, progress indicator
- `success` - Completed, checkmark, collapsible result
- `error` - Failed, error icon, error message

**Data Model**:
```typescript
interface ToolMessage {
  id: string;
  type: 'tool_use' | 'tool_result';
  toolName: string;
  status: 'pending' | 'running' | 'success' | 'error';
  input?: Record<string, unknown>;   // Tool arguments
  output?: string;                    // Tool result
  error?: string;                     // Error message if failed
  timestamp: string;
  durationMs?: number;                // Execution time
}

interface StreamingMessage {
  id: string;
  role: 'assistant';
  content: string;                    // Accumulated text
  toolCalls: ToolMessage[];           // Interleaved tool messages
  isStreaming: boolean;
  cursor?: number;                    // Position for streaming indicator
}
```

#### 7.5 Chat Layout Redesign

Replace avatar-based layout with a modern canvas-style design.

**Old Layout** (Phase 1):
```
┌─────────────────────────────────────────────┐
│ 👤 User                                     │
│ ┌─────────────────────────────────────────┐ │
│ │ Can you help me with X?                 │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 🤖 Assistant                                │
│ ┌─────────────────────────────────────────┐ │
│ │ Sure, here's how to do X...             │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**New Layout** (Phase 2):
```
┌─────────────────────────────────────────────┐
│                                             │
│                    ┌───────────────────────┐│
│                    │ Help me with X?       ││  ← User: bubble, right-aligned
│                    └───────────────────────┘│
│                                             │
│ Sure, here's how to do X.                   │  ← Assistant: plain text, left-aligned
│                                             │
│ First, you need to understand that...       │
│                                             │
│ ```typescript                               │  ← Code blocks rendered inline
│ const example = "code";                     │
│ ```                                         │
│                                             │
│                    ┌───────────────────────┐│
│                    │ What about Y?         ││
│                    └───────────────────────┘│
│                                             │
│ For Y, the approach is different...         │
│                                             │
└─────────────────────────────────────────────┘
```

**Design Principles**:
- **User messages**: Compact bubbles, right-aligned, subtle background color
- **Assistant messages**: Full-width text, no container, reads like a document
- **Code blocks**: Syntax highlighted, copy button, language label
- **Tool messages**: Collapsible cards between text sections
- **No avatars**: Cleaner, more content-focused design
- **Generous whitespace**: Easy to scan and read

**Component Structure**:
```typescript
// Message rendering based on role
function MessageRenderer({ message }: { message: Message }) {
  if (message.role === 'user') {
    return <UserBubble content={message.content} />;
  }

  if (message.role === 'assistant') {
    return (
      <AssistantCanvas
        content={message.content}
        toolCalls={message.toolCalls}
        isStreaming={message.isStreaming}
      />
    );
  }
}

// User bubble - compact, right-aligned
function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="bg-primary/10 rounded-2xl px-4 py-2 max-w-[80%]">
        {content}
      </div>
    </div>
  );
}

// Assistant canvas - full width, document-like
function AssistantCanvas({ content, toolCalls, isStreaming }) {
  return (
    <div className="prose prose-sm max-w-none">
      <MarkdownRenderer content={content} />
      {toolCalls.map(tool => <ToolCard key={tool.id} tool={tool} />)}
      {isStreaming && <StreamingCursor />}
    </div>
  );
}
```

---

## Application Architecture Updates

### 7.1 New IPC Handlers

```
src/main/ipc/
├── project-handlers.ts    (existing)
├── worktree-handlers.ts   (existing)
├── session-handlers.ts    (existing)
├── opencode-handlers.ts   (existing)
├── git-handlers.ts        (NEW - enhanced)
├── filetree-handlers.ts   (NEW)
└── settings-handlers.ts   (NEW)
```

### 7.2 New Renderer Components

```
src/renderer/components/
├── filetree/
│   ├── FileTree.tsx
│   ├── FileTreeNode.tsx
│   ├── FileTreeHeader.tsx
│   ├── FileTreeFilter.tsx
│   └── FileIcon.tsx
├── git/
│   ├── GitStatusPanel.tsx
│   ├── GitCommitForm.tsx
│   ├── GitPushPull.tsx
│   ├── DiffViewer.tsx
│   └── DiffModal.tsx
├── command-palette/
│   ├── CommandPalette.tsx
│   ├── CommandList.tsx
│   └── CommandItem.tsx
├── settings/
│   ├── SettingsModal.tsx
│   ├── SettingsGeneral.tsx
│   ├── SettingsEditor.tsx
│   ├── SettingsTerminal.tsx
│   ├── SettingsGit.tsx
│   └── SettingsShortcuts.tsx
└── sessions/                  (UPDATED)
    ├── SessionTabs.tsx        (modified - + button left)
    ├── SessionView.tsx        (modified - new layout)
    ├── SessionHistory.tsx     (existing)
    ├── UserBubble.tsx         (NEW)
    ├── AssistantCanvas.tsx    (NEW)
    ├── ToolCard.tsx           (NEW)
    ├── StreamingCursor.tsx    (NEW)
    └── ModeToggle.tsx         (NEW)
```

### 7.3 New Stores

```typescript
// useFileTreeStore.ts
interface FileTreeStore {
  nodes: FileTreeNode[];
  expandedPaths: Set<string>;
  selectedPath: string | null;
  filterQuery: string;
  isLoading: boolean;

  loadTree: (worktreeId: string) => Promise<void>;
  toggleExpand: (path: string) => void;
  setSelected: (path: string | null) => void;
  setFilter: (query: string) => void;
  refresh: () => Promise<void>;
}

// useGitStore.ts
interface GitStore {
  status: GitStatus | null;
  isLoading: boolean;
  isPushing: boolean;
  isPulling: boolean;

  fetchStatus: (worktreeId: string) => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  commit: (options: CommitOptions) => Promise<void>;
  push: (options?: PushOptions) => Promise<void>;
  pull: (options?: PullOptions) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
}

// useCommandPaletteStore.ts
interface CommandPaletteStore {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  recentCommands: string[];

  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  executeCommand: (id: string) => void;
}

// useSettingsStore.ts
interface SettingsStore {
  settings: AppSettings;
  isModalOpen: boolean;

  loadSettings: () => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  resetToDefaults: () => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
}

// useSessionStore.ts (UPDATED - add mode support)
interface SessionStore {
  // ... existing fields
  currentMode: 'build' | 'plan';
  streamingMessage: StreamingMessage | null;

  toggleMode: () => void;
  setMode: (mode: 'build' | 'plan') => void;
  updateStreamingMessage: (content: string, toolCalls?: ToolMessage[]) => void;
  clearStreamingMessage: () => void;
}
```

---

## Database Schema Updates

```sql
-- No new tables required
-- Settings table already exists, will store:
--   'app_settings' -> JSON blob of AppSettings
--   'shortcut_overrides' -> JSON blob of ShortcutOverrides
--   'file_tree_expanded_{worktreeId}' -> JSON array of expanded paths
```

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| File Tree Load Time | < 500ms for 1000 files |
| Git Status Refresh | < 200ms |
| Command Palette Open | < 50ms |
| File Watcher CPU | < 1% idle |
| Diff Render | < 100ms for 500-line diff |

### Performance Optimizations
- Virtual scrolling for file tree (large repos)
- Debounced file system events
- Lazy git status per file (on-demand)
- Memoized command list filtering

---

## Out of Scope (Phase 2)

- Cloud sync / backup
- Team collaboration features
- Plugin / extension system
- Merge conflict resolution UI
- Interactive rebase
- Git blame view
- File rename/move/delete from UI
- Multiple windows
- Onboarding / tutorial flow
- Auto-updates

---

## Open Items / Future Considerations

1. **Merge Conflict UI**: How to handle conflicts (Phase 3?)
2. **Git Authentication**: SSH keys, credential helpers, GitHub CLI integration
3. **Large Repo Performance**: Repos with 10k+ files
4. **Stash Management**: Quick stash/pop UI (Phase 3?)
5. **Branch Comparison**: Diff between branches

---

## Success Metrics (Post-Launch)

- File tree loads in < 500ms for 95% of worktrees
- Users can commit changes in < 10 seconds (from staged)
- Command palette used 5+ times per session (power users)
- Zero data loss from git operations
- Git push/pull success rate > 99%
- Tool messages render within 50ms of receiving event
- Mode toggle responds in < 100ms
- Auto-session creation completes in < 2 seconds

---

## Implementation Priority

### Sprint 1: File Tree Foundation
1. FileTree component with basic display
2. File system watching with chokidar
3. Git status integration in file tree
4. File tree context menu (open, copy path)

### Sprint 2: Git Operations
1. Git status panel
2. Stage/unstage functionality
3. Commit form with validation
4. Push/pull buttons with progress

### Sprint 3: Command Palette & Shortcuts
1. Command palette component (cmdk)
2. Command registry system
3. Keyboard shortcuts hook
4. Settings panel for shortcuts

### Sprint 4: Session & Chat Experience
1. New chat layout (user bubbles, assistant canvas)
2. Tool message rendering with streaming states
3. Build/Plan mode toggle (Shift+Tab)
4. Auto-start session on worktree selection
5. Move + button to left of tab bar

### Sprint 5: Polish & Settings
1. Settings modal with all sections
2. Diff viewer component
3. Editor/terminal integration
4. Performance optimization
