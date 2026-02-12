# Hive - Phase 4 Product Requirements Document

## Overview

**Phase 4** focuses on **modernizing the app's look and feel, improving developer workflow, and adding power-user features**. The primary work includes a full visual redesign with a dark-first theme system, model selection, streaming markdown rendering, file preview, session auto-naming, project language detection, and quick-action shortcuts in the header.

### Phase 4 Goals
- Redesign the app with a modern dark theme (purple primary) and offer ~10 selectable themes
- Add a Settings page with theme/appearance controls
- Show and allow changing the active AI model, persisted globally per user
- Render markdown incrementally as streamed responses arrive (throttled)
- Change mode toggle shortcut from Shift+Tab to Tab (global, no tab insertion)
- Auto-detect project language and display language icons per project
- Split the right sidebar: file picker (top half) + 3-tab panel (Setup/Run/Terminal)
- Auto-name sessions based on the first message using Claude Haiku
- Add a file viewer tab with syntax highlighting and Cmd+F search
- Add a header quick-action bar (last operation + Open dropdown)

---

## Technical Additions

| Component | Technology |
|-----------|------------|
| Theme System | CSS custom properties + Tailwind theme variants |
| Model Listing | OpenCode SDK `client.config.providers()` |
| Streaming Throttle | `requestAnimationFrame` / `setTimeout` throttle (~100ms) |
| Language Detection | File-based heuristics (package.json, go.mod, Cargo.toml, etc.) |
| File Viewer | react-syntax-highlighter (already installed) + custom search |
| Session Naming | Anthropic Claude Haiku API call via OpenCode |

---

## Features

### 1. UI Redesign — Modern Dark Theme with Theme Selector

#### 1.1 Current State
The app uses a basic dark/light/system toggle stored in `useThemeStore`. There is no concept of color accent, theme presets, or a dedicated appearance settings section.

#### 1.2 New Design

**Default Theme**: Dark background with **purple** as the primary accent color for buttons, active states, borders, and interactive elements.

**Theme Architecture**:
- Themes are defined as sets of CSS custom properties (HSL values) applied to `:root`
- Each theme sets: `--primary`, `--primary-foreground`, `--accent`, `--background`, `--foreground`, `--card`, `--border`, `--muted`, etc.
- Tailwind's existing `bg-primary`, `text-primary`, `border-primary` classes automatically pick up the theme

**~10 Theme Presets**:

| # | Name | Type | Primary Accent | Description |
|---|------|------|---------------|-------------|
| 1 | **Amethyst** (default) | Dark | Purple (`270 60% 55%`) | Deep dark with purple accents |
| 2 | **Obsidian** | Dark | Neutral gray | Minimal, monochrome dark |
| 3 | **Midnight Blue** | Dark | Blue (`220 70% 55%`) | Classic dark blue IDE feel |
| 4 | **Emerald Night** | Dark | Green (`160 60% 45%`) | Dark with green accents |
| 5 | **Crimson** | Dark | Red (`0 65% 55%`) | Dark with warm red accents |
| 6 | **Sunset** | Dark | Orange (`25 80% 55%`) | Dark with warm orange tones |
| 7 | **Daylight** | Light | Purple (`270 60% 50%`) | Clean light with purple accents |
| 8 | **Cloud** | Light | Blue (`220 65% 50%`) | Soft light blue professional |
| 9 | **Mint** | Light | Green (`160 55% 40%`) | Light with fresh green tones |
| 10 | **Rose** | Light | Pink (`340 65% 55%`) | Light with pink accents |

Each theme is a simple object:
```typescript
interface ThemePreset {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string> // CSS custom property values
}
```

#### 1.3 Theme Application

```typescript
function applyTheme(preset: ThemePreset) {
  const root = document.documentElement
  // Set dark/light class
  root.classList.toggle('dark', preset.type === 'dark')
  // Apply CSS custom properties
  for (const [key, value] of Object.entries(preset.colors)) {
    root.style.setProperty(`--${key}`, value)
  }
}
```

#### 1.4 Settings Menu — Appearance Section

Add a new **"Appearance"** section to the existing SettingsModal (first item in the nav).

```
┌─────────────────────────────────────────────────────┐
│  Settings                                           │
│ ┌──────────┬──────────────────────────────────────┐ │
│ │ Appearance │  Theme                              │ │
│ │ General    │                                     │ │
│ │ Editor     │  ┌──────┐ ┌──────┐ ┌──────┐       │ │
│ │ Terminal   │  │Ameth.│ │Obsid.│ │Mid.Bl│       │ │
│ │ Git        │  │  ●   │ │      │ │      │       │ │
│ │ Shortcuts  │  └──────┘ └──────┘ └──────┘       │ │
│ │            │  ┌──────┐ ┌──────┐ ┌──────┐       │ │
│ │            │  │Em.Ni.│ │Crims.│ │Sunset│       │ │
│ │            │  └──────┘ └──────┘ └──────┘       │ │
│ │            │  ┌──────┐ ┌──────┐ ┌──────┐       │ │
│ │            │  │Dayli.│ │Cloud │ │ Mint │       │ │
│ │            │  └──────┘ └──────┘ └──────┘       │ │
│ │            │  ┌──────┐                          │ │
│ │            │  │ Rose │                          │ │
│ │            │  └──────┘                          │ │
│ └──────────┴──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

Each theme card shows:
- A mini color preview (small rectangle with the theme's bg + primary color swatch)
- Theme name below
- Checkmark or highlighted border on the active theme
- Clicking applies the theme immediately

#### 1.5 Persistence

- Store selected theme ID in the settings database (key: `'selected_theme'`)
- On app startup, load theme ID → apply preset
- Remove the old theme dropdown from the Header — theme is now in Settings

#### 1.6 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/lib/themes.ts` | **NEW** — Theme preset definitions |
| `src/renderer/src/stores/useThemeStore.ts` | Replace dark/light/system with theme preset system |
| `src/renderer/src/components/settings/SettingsAppearance.tsx` | **NEW** — Appearance settings section |
| `src/renderer/src/components/settings/SettingsModal.tsx` | Add Appearance section to nav |
| `src/renderer/src/components/layout/Header.tsx` | Remove theme dropdown, replace with settings gear icon |
| `src/renderer/src/index.css` | Update CSS custom properties for theme system |

---

### 2. Model Selection

#### 2.1 Current State
Model is hardcoded as `claude-opus-4-5-20251101` in `opencode-service.ts`. There is no UI to view or change the model.

#### 2.2 New Design

Show the current model name in a compact pill inside the input area (below the textarea, next to the hint text). Tapping it opens a dropdown/popover to select a different model.

```
┌─── purple border (amethyst theme) ──────────────────┐
│ [Build]                                              │
│                                                      │
│  Type your message...                                │
│                                                      │
│  claude-opus-4-5 ▾        Enter to send  [>]        │
└──────────────────────────────────────────────────────┘
```

Tapping the model pill opens a popover:

```
┌───────────────────────────────┐
│  Select Model                 │
│ ┌───────────────────────────┐ │
│ │ * claude-opus-4-5         │ │  <- active (checkmark)
│ │   claude-sonnet-4-5       │ │
│ │   claude-haiku-3-5        │ │
│ │   gpt-4o                  │ │
│ │   ...                     │ │
│ └───────────────────────────┘ │
└───────────────────────────────┘
```

#### 2.3 Model List Retrieval

Use the OpenCode SDK's `client.config.providers()` API:

```typescript
// In opencode-service.ts
async getAvailableModels(): Promise<{ providers: Provider[], default: Record<string, string> }> {
  const instance = await this.getOrCreateInstance()
  const result = await instance.client.config.providers()
  return result.data
}
```

The response contains providers (e.g., "anthropic", "openai") each with a `models` dictionary. Flatten all models into a single list for the dropdown, grouped by provider.

#### 2.4 Persistence

- **This is a global per-user setting** — changing the model applies to ALL sessions (past and future), all projects
- Store in settings database: key `'selected_model'`, value `JSON.stringify({ providerID, modelID })`
- On app startup, load the selected model. If none set, use the first available or `claude-opus-4-5-20251101` as fallback
- The `prompt()` method in opencode-service reads the stored model instead of the hardcoded default

#### 2.5 Display Name

Show a shortened, human-friendly model name in the pill:
- `claude-opus-4-5-20251101` -> `claude-opus-4-5`
- `claude-sonnet-4-5-20250514` -> `claude-sonnet-4-5`
- Use the `model.name` field from the SDK if available, otherwise strip date suffixes

#### 2.6 Files to Modify/Create

| File | Change |
|------|--------|
| `src/main/services/opencode-service.ts` | Add `getAvailableModels()`, read model from settings in `prompt()` |
| `src/main/ipc/opencode-handlers.ts` | Add `opencode:models` IPC handler |
| `src/preload/index.ts` | Expose `listModels()` on `opencodeOps` |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | **NEW** — Model pill + popover dropdown |
| `src/renderer/src/components/sessions/SessionView.tsx` | Integrate ModelSelector in input area |
| `src/renderer/src/stores/useSettingsStore.ts` | Add `selectedModel` to persisted settings |

---

### 3. Streaming Markdown Rendering with Throttle

#### 3.1 Current State
Streamed text content accumulates in `streamingContent` / `streamingParts`, but the `MarkdownRenderer` component re-renders on every token. Full markdown parsing on each keystroke is expensive.

#### 3.2 New Approach

Add a throttle mechanism that batches streaming updates and renders partial markdown at a controlled interval (~100ms).

**Strategy**:
1. Accumulate raw text in a ref (no re-render on each token)
2. Use a throttle timer (100ms) to periodically flush the accumulated text into rendered markdown state
3. The `MarkdownRenderer` only re-renders at the throttled interval
4. On stream completion, do one final render with the complete text

```typescript
const rawContentRef = useRef('')
const [renderedContent, setRenderedContent] = useState('')
const throttleRef = useRef<NodeJS.Timeout | null>(null)

// On each streaming token:
function onStreamToken(delta: string) {
  rawContentRef.current += delta
  if (!throttleRef.current) {
    throttleRef.current = setTimeout(() => {
      setRenderedContent(rawContentRef.current)
      throttleRef.current = null
    }, 100)
  }
}

// On stream complete:
function onStreamEnd() {
  if (throttleRef.current) clearTimeout(throttleRef.current)
  setRenderedContent(rawContentRef.current)
}
```

#### 3.3 Partial Markdown Handling

`react-markdown` handles incomplete markdown gracefully — unclosed fences, partial lists, etc. render as-is and update correctly when the next chunk completes them. No special handling needed.

#### 3.4 Files to Modify

| File | Change |
|------|--------|
| `src/renderer/src/components/sessions/SessionView.tsx` | Add throttle logic around streaming content updates |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx` | Ensure partial content renders through MarkdownRenderer |

---

### 4. Tab Key for Mode Toggle (Replace Shift+Tab)

#### 4.1 Current State
`Shift+Tab` toggles between Build and Plan modes. The shortcut is registered in the keyboard shortcut system.

#### 4.2 New Behavior

- **`Tab`** (unmodified) toggles mode globally
- The `Tab` keypress must be intercepted **globally** (not just when textarea is focused) and **must not insert a tab character** into the textarea
- `preventDefault()` on the Tab keydown event before it reaches the textarea

#### 4.3 Implementation

Register a global `keydown` listener at the window level (or in the SessionView component) that captures `Tab` without modifiers:

```typescript
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleMode()
    }
  }
  window.addEventListener('keydown', handleKeyDown, true) // capture phase
  return () => window.removeEventListener('keydown', handleKeyDown, true)
}, [toggleMode])
```

#### 4.4 Update Hint Text

- ModeToggle tooltip: change "Shift+Tab to toggle" -> "Tab to toggle"
- Input area hint: update if any reference to Shift+Tab exists

#### 4.5 Files to Modify

| File | Change |
|------|--------|
| `src/renderer/src/components/sessions/SessionView.tsx` | Change global keydown listener from Shift+Tab to Tab, preventDefault |
| `src/renderer/src/components/sessions/ModeToggle.tsx` | Update tooltip text |

---

### 5. Project Language Detection & Icons

#### 5.1 Current State
Projects always display a folder icon. There is no project-level language detection.

#### 5.2 Language Detection Strategy

Detect the primary language of a project by checking for characteristic files in the project root:

| File(s) | Language |
|---------|----------|
| `package.json`, `tsconfig.json` | TypeScript/JavaScript |
| `go.mod`, `go.sum` | Go |
| `Cargo.toml` | Rust |
| `pom.xml`, `build.gradle` | Java |
| `requirements.txt`, `pyproject.toml`, `setup.py` | Python |
| `Gemfile` | Ruby |
| `Package.swift` | Swift |
| `*.csproj`, `*.sln` | C# |
| `composer.json` | PHP |
| `mix.exs` | Elixir |
| `pubspec.yaml` | Dart/Flutter |
| `CMakeLists.txt` | C/C++ |

If `tsconfig.json` exists alongside `package.json`, prefer **TypeScript**. If only `package.json`, use **JavaScript**.

#### 5.3 Detection Service

Create a main-process service that checks the project path for these files:

```typescript
// src/main/services/language-detector.ts
export async function detectProjectLanguage(projectPath: string): Promise<string | null> {
  // Check for files in priority order, return language id
}
```

#### 5.4 When Detection Runs

- **On project add**: Automatically detect language when a project is added
- **On refresh**: 3-dot menu per project includes a "Refresh Language" option
- Store the detected language in the project record (new column `language TEXT` in projects table)

#### 5.5 Language Icons

Replace the folder icon with a language-specific icon/image for each project in the sidebar.

Use simple SVG icons or colored circles with language abbreviations. Source language logos from a bundled set of SVG files (e.g., devicon or similar):

| Language | Icon | Color |
|----------|------|-------|
| TypeScript | TS logo | `#3178C6` |
| JavaScript | JS logo | `#F7DF1E` |
| Python | Python logo | `#3776AB` |
| Go | Go gopher | `#00ADD8` |
| Rust | Rust gear | `#DEA584` |
| Java | Java logo | `#ED8B00` |
| Ruby | Ruby gem | `#CC342D` |
| Swift | Swift bird | `#FA7343` |
| C# | C# logo | `#239120` |
| PHP | PHP logo | `#777BB4` |
| Elixir | Elixir drop | `#6E4A7E` |
| Dart | Dart logo | `#0175C2` |
| C/C++ | C++ logo | `#00599C` |
| Unknown | Folder icon | muted gray |

#### 5.6 Files to Modify/Create

| File | Change |
|------|--------|
| `src/main/services/language-detector.ts` | **NEW** — Language detection logic |
| `src/main/ipc/project-handlers.ts` | Add `project:detectLanguage` IPC handler, add to project add flow |
| `src/preload/index.ts` | Expose `detectLanguage()` on project ops |
| `src/main/db/schema.ts` | Add `language` column to projects table (migration v3) |
| `src/renderer/src/assets/lang-icons/` | **NEW** — Bundled language SVG icons |
| `src/renderer/src/components/projects/LanguageIcon.tsx` | **NEW** — Language icon component |
| `src/renderer/src/components/projects/ProjectItem.tsx` | Replace folder icon with LanguageIcon |
| `src/renderer/src/stores/useProjectStore.ts` | Add language field, refresh action |

---

### 6. Right Sidebar Split — File Picker + 3-Tab Panel

#### 6.1 Current State
The right sidebar has GitStatusPanel at the top and FileTree filling the remaining space.

#### 6.2 New Layout

Split the right sidebar into two equal-height halves:

```
┌──────────────────────┐
│   Git Status Panel   │  <- (small, existing)
├──────────────────────┤
│                      │
│   File Tree          │  <- top half (50%)
│   (scrollable)       │
│                      │
├──────────────────────┤
│ [Setup] [Run] [Term] │  <- tab bar
├──────────────────────┤
│                      │
│   Tab Content        │  <- bottom half (50%)
│   (TODO placeholder) │
│                      │
└──────────────────────┘
```

#### 6.3 Three-Tab Panel

A tab bar with 3 tabs: **Setup**, **Run**, **Terminal**

Each tab renders a placeholder `TODO` component for now:

```typescript
function TodoPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      <span>TODO: {label}</span>
    </div>
  )
}
```

The tab bar should be styled to match the app's theme — compact, with an underline indicator on the active tab.

#### 6.4 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/layout/RightSidebar.tsx` | Split into two halves, add bottom panel |
| `src/renderer/src/components/layout/BottomPanel.tsx` | **NEW** — 3-tab panel with Setup/Run/Terminal tabs |

---

### 7. Session Auto-Naming via Claude Haiku

#### 7.1 Current State
Sessions are named `"Session HH:MM"` on creation via `generateSessionName()`.

#### 7.2 New Behavior

On the **first user message** in a session:
1. Send the user's message to Claude Haiku with a short system prompt asking for a 3-5 word descriptive session name
2. When the name comes back, update the session name in the store and database
3. The session tab updates reactively to show the new name

#### 7.3 Naming Prompt

```
System: Generate a short (3-5 word) descriptive name for a coding session based on the user's first message. Return ONLY the name, no quotes or explanation.
User: {first_message_content}
```

Use the OpenCode SDK to send this via a lightweight prompt, or call the Anthropic API directly with Claude Haiku for speed and cost efficiency.

#### 7.4 Implementation

```typescript
// In SessionView.tsx, after sending the first message:
if (messages.length === 0) {
  // This is the first message
  const sessionName = await window.opencodeOps.generateSessionName(inputValue)
  if (sessionName) {
    updateSessionName(sessionId, sessionName.trim())
  }
}
```

The actual API call happens in the main process:

```typescript
// In opencode-service.ts or a new naming service
async generateSessionName(userMessage: string): Promise<string> {
  // Use Anthropic SDK directly with claude-haiku for fast, cheap naming
  // Or use OpenCode SDK with haiku model override
}
```

#### 7.5 Fallback

If the naming call fails or times out (2s timeout), keep the default "Session HH:MM" name. This should never block the main conversation flow.

#### 7.6 Files to Modify/Create

| File | Change |
|------|--------|
| `src/main/services/opencode-service.ts` | Add `generateSessionName(message)` method using Haiku |
| `src/main/ipc/opencode-handlers.ts` | Add `opencode:generateSessionName` IPC handler |
| `src/preload/index.ts` | Expose `generateSessionName()` on `opencodeOps` |
| `src/renderer/src/components/sessions/SessionView.tsx` | Call naming on first message send |
| `src/renderer/src/stores/useSessionStore.ts` | Ensure `updateSessionName` triggers tab re-render |

---

### 8. File Viewer

#### 8.1 Current State
Clicking a file in the file tree opens it in an external editor. There is no in-app file preview.

#### 8.2 New Behavior

Clicking a file in the file tree opens a **read-only preview tab** in the main pane (alongside session tabs). The preview shows:

- File content with syntax highlighting
- Line numbers
- `Cmd+F` search overlay (like an IDE)
- File name in the tab title
- No editing capability

```
Tab bar:
[Session 1] [Session 2] [utils.ts] [README.md]

Content area:
┌──────────────────────────────────────────────────────┐
│  1 | import { useState } from 'react'                │
│  2 |                                                  │
│  3 | export function useAuth() {                      │
│  4 |   const [user, setUser] = useState(null)         │
│  5 |   ...                                            │
│                                                       │
│  ┌─── Cmd+F Search Bar ───────────────────────────┐  │
│  | Search...                  [up] [dn] 3/12  [X] |  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

#### 8.3 File Content Loading

Read file content via an IPC call:

```typescript
// New IPC handler
ipcMain.handle('file:read', async (_, filePath: string) => {
  return fs.readFileSync(filePath, 'utf-8')
})
```

#### 8.4 Search (Cmd+F)

- `Cmd+F` opens a search bar overlay at the top of the file viewer
- Type to search: highlights all matches in the file, scrolls to first match
- Up/Down arrows navigate between matches
- Show match count (e.g., "3/12")
- `Escape` closes the search bar

#### 8.5 Tab Integration

File viewer tabs coexist with session tabs in `SessionTabs.tsx`. Differentiate file tabs with:
- A file icon prefix instead of a chat icon
- File name as tab title (not "Session HH:MM")
- Closing the tab just closes the preview (no session cleanup needed)

Store open file tabs in the session store or a new store alongside session tabs.

#### 8.6 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/file-viewer/FileViewer.tsx` | **NEW** — Read-only file preview with syntax highlighting |
| `src/renderer/src/components/file-viewer/FileSearch.tsx` | **NEW** — Cmd+F search overlay |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Support mixed tab types (sessions + file viewers) |
| `src/renderer/src/components/layout/MainPane.tsx` | Route to FileViewer when a file tab is active |
| `src/renderer/src/stores/useFileViewerStore.ts` | **NEW** — Track open file tabs |
| `src/main/ipc/file-handlers.ts` | Add `file:read` IPC handler |
| `src/preload/index.ts` | Expose `readFile()` |
| `src/renderer/src/components/file-tree/FileTree.tsx` | Change click handler to open file viewer instead of external editor |

---

### 9. Header Quick Actions — Last Operation + Open Dropdown

#### 9.1 Current State
The header has: "Hive" title, session history button, theme dropdown, sidebar toggle.

#### 9.2 New Design

Replace the theme dropdown with a 2-button group on the right side of the header:

```
┌──────────────────────────────────────────────────────────────┐
│  (traffic lights)    Hive          [Cursor] [v Open]   [...] │
└──────────────────────────────────────────────────────────────┘
```

**Button 1 — Last Operation** (left):
- Shows the icon + name of the last used "Open in" action (e.g., "Cursor")
- Clicking it re-executes that same action (opens the current worktree folder in that app)
- Default (before any action): shows "Open" with a generic open icon

**Button 2 — Open Dropdown** (right):
- Small dropdown chevron button
- Opens a menu with options:
  - **Cursor** — Opens the worktree folder in Cursor editor
  - **Ghostty** — Opens the worktree folder in Ghostty terminal
  - **Copy Path** — Copies the worktree folder path to clipboard
- Selecting an option:
  1. Executes the action immediately
  2. Updates the "Last Operation" button to reflect this selection

#### 9.3 Action Execution

```typescript
// Open in Cursor
spawn('cursor', [worktreePath])
// or: spawn('open', ['-a', 'Cursor', worktreePath])

// Open in Ghostty
spawn('open', ['-a', 'Ghostty', worktreePath])

// Copy Path
clipboard.writeText(worktreePath)
```

#### 9.4 Persistence

- Store the last operation in settings database (key: `'last_open_action'`)
- On app restart, the "Last Operation" button shows the previously used action

#### 9.5 Files to Modify/Create

| File | Change |
|------|--------|
| `src/renderer/src/components/layout/Header.tsx` | Replace theme dropdown with quick action buttons |
| `src/renderer/src/components/layout/QuickActions.tsx` | **NEW** — Last operation + Open dropdown component |
| `src/main/ipc/system-handlers.ts` | Add `system:openIn` IPC handler for launching external apps |
| `src/preload/index.ts` | Expose `openInApp()` on `systemOps` |
| `src/renderer/src/stores/useSettingsStore.ts` | Add `lastOpenAction` to persisted settings |

---

## Files to Modify — Full Summary

### New Files

| File | Purpose |
|------|---------|
| `src/renderer/src/lib/themes.ts` | Theme preset definitions (~10 themes) |
| `src/renderer/src/components/settings/SettingsAppearance.tsx` | Appearance/theme settings UI |
| `src/renderer/src/components/sessions/ModelSelector.tsx` | Model selection pill + popover |
| `src/main/services/language-detector.ts` | Project language detection service |
| `src/renderer/src/components/projects/LanguageIcon.tsx` | Language icon component |
| `src/renderer/src/assets/lang-icons/` | Bundled language SVG icons |
| `src/renderer/src/components/layout/BottomPanel.tsx` | 3-tab panel (Setup/Run/Terminal) |
| `src/renderer/src/components/file-viewer/FileViewer.tsx` | Read-only file preview |
| `src/renderer/src/components/file-viewer/FileSearch.tsx` | Cmd+F search overlay |
| `src/renderer/src/stores/useFileViewerStore.ts` | Open file tab state |
| `src/renderer/src/components/layout/QuickActions.tsx` | Header quick action buttons |

### Modified Files

| File | Change |
|------|--------|
| `src/renderer/src/stores/useThemeStore.ts` | Theme preset system |
| `src/renderer/src/stores/useSettingsStore.ts` | Add selectedModel, lastOpenAction |
| `src/renderer/src/stores/useProjectStore.ts` | Add language field, refresh |
| `src/renderer/src/stores/useSessionStore.ts` | Ensure name updates re-render tabs |
| `src/renderer/src/components/settings/SettingsModal.tsx` | Add Appearance section |
| `src/renderer/src/components/layout/Header.tsx` | Quick actions, remove theme dropdown |
| `src/renderer/src/components/layout/RightSidebar.tsx` | Split into two halves |
| `src/renderer/src/components/sessions/SessionView.tsx` | Model selector, throttled streaming, Tab key, auto-naming |
| `src/renderer/src/components/sessions/AssistantCanvas.tsx` | Throttled partial markdown |
| `src/renderer/src/components/sessions/ModeToggle.tsx` | Update tooltip (Tab) |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | Support file viewer tabs |
| `src/renderer/src/components/layout/MainPane.tsx` | Route to FileViewer |
| `src/renderer/src/components/projects/ProjectItem.tsx` | Language icon + refresh menu |
| `src/renderer/src/components/file-tree/FileTree.tsx` | Open file viewer on click |
| `src/renderer/src/index.css` | CSS custom property theme system |
| `src/main/services/opencode-service.ts` | Model listing, model from settings, session naming |
| `src/main/ipc/opencode-handlers.ts` | Model list + session name handlers |
| `src/main/ipc/project-handlers.ts` | Language detection handler |
| `src/main/db/schema.ts` | Migration v3: add language column |
| `src/preload/index.ts` | Expose new IPC methods |

---

## Dependencies to Add

```bash
pnpm add @anthropic-ai/sdk    # For direct Haiku calls (session naming)
```

Note: `react-syntax-highlighter` is already installed (Phase 3). No other new dependencies needed.

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Theme switch | < 50ms, no flicker |
| Model list load | < 1s from OpenCode SDK |
| Streaming render throttle | ~100ms interval, smooth feel |
| Tab mode toggle | < 50ms response |
| Language detection | < 500ms per project |
| Session naming (Haiku) | < 2s, non-blocking |
| File viewer open | < 200ms for files < 1MB |
| File search | < 100ms per keystroke for files < 10K lines |
| Quick action execution | < 500ms to launch external app |

---

## Out of Scope (Phase 4)

- Setup/Run/Terminal tab content (placeholder only — future phase)
- File editing in the file viewer (read-only only)
- Custom theme creation by users (presets only)
- Model cost display or token counting
- Multi-language detection per project (primary language only)
- Auto-update or version checking
- Plugin system

---

## Implementation Priority

### Sprint 1: Theme System & Settings
1. Create theme preset definitions in `themes.ts`
2. Refactor `useThemeStore` for preset system
3. Update CSS custom properties in `index.css`
4. Build `SettingsAppearance` component
5. Add Appearance section to SettingsModal
6. Update Header (replace theme dropdown with settings gear)

### Sprint 2: Model Selection & Streaming
1. Add `getAvailableModels()` to opencode-service
2. Wire IPC handler + preload for model listing
3. Build ModelSelector component (pill + popover)
4. Integrate ModelSelector in SessionView input area
5. Add streaming throttle logic to SessionView
6. Verify partial markdown renders correctly

### Sprint 3: Mode Toggle & Session Naming
1. Change Shift+Tab to Tab for mode toggle
2. Add global keydown listener with preventDefault
3. Add `generateSessionName()` service (Haiku)
4. Wire IPC + preload for session naming
5. Trigger naming on first message in SessionView
6. Verify session tab updates reactively

### Sprint 4: Language Detection & Icons
1. Create language-detector service
2. Bundle language SVG icons
3. Build LanguageIcon component
4. Wire detection into project add flow
5. Add "Refresh Language" to project 3-dot menu
6. Add DB migration for language column

### Sprint 5: Right Sidebar Split & File Viewer
1. Split RightSidebar into two halves
2. Build BottomPanel with 3 tabs (placeholder content)
3. Build FileViewer component with syntax highlighting
4. Build FileSearch component (Cmd+F)
5. Create useFileViewerStore
6. Integrate file tabs into SessionTabs + MainPane routing
7. Change file tree click to open file viewer

### Sprint 6: Header Quick Actions
1. Build QuickActions component
2. Implement open-in-app IPC handlers (Cursor, Ghostty)
3. Implement Copy Path action
4. Wire last operation persistence
5. Integrate into Header, remove old theme dropdown

---

## Success Metrics

- App feels modern and professional with the default Amethyst dark theme
- Users can switch between 10 theme presets from Settings > Appearance
- Model can be changed from the input area and persists across sessions
- Streamed responses render progressively without jank or delay
- Tab key toggles mode instantly without inserting tab characters
- Projects show language-appropriate icons in the sidebar
- Right sidebar has a clear top/bottom split with tab placeholders
- Sessions get descriptive auto-generated names after the first message
- Files can be previewed in-app with syntax highlighting and search
- One-click actions in the header open worktree in Cursor/Ghostty or copy path
