# Hive Phase 4 Implementation Plan

This document outlines the implementation plan for Hive Phase 4, focusing on a modern UI redesign, model selection, streaming improvements, file viewer, project language detection, session auto-naming, and header quick actions.

---

## Overview

The implementation is divided into **10 focused sessions**, each with:
- Clear objectives
- Definition of done
- Testing criteria for verification

**Phase 4 builds upon Phase 3** — all Phase 3 infrastructure (input area redesign, markdown rendering with react-markdown, tool card polish, response logging) is assumed to be in place.

---

## Testing Infrastructure

### Test File Structure (Phase 4)
```
test/
├── phase-4/
│   ├── session-1/
│   │   └── theme-system.test.ts
│   ├── session-2/
│   │   └── settings-appearance.test.ts
│   ├── session-3/
│   │   └── model-selection.test.ts
│   ├── session-4/
│   │   └── streaming-throttle-mode-toggle.test.ts
│   ├── session-5/
│   │   └── session-auto-naming.test.ts
│   ├── session-6/
│   │   └── language-detection.test.ts
│   ├── session-7/
│   │   └── right-sidebar-split.test.ts
│   ├── session-8/
│   │   └── file-viewer.test.ts
│   ├── session-9/
│   │   └── header-quick-actions.test.ts
│   └── session-10/
│       └── integration-polish.test.ts
```

### New Dependencies
```json
{
  "@anthropic-ai/sdk": "latest"
}
```

Note: `react-syntax-highlighter`, `react-markdown`, `remark-gfm` already installed from Phase 3.

---

## Session 1: Theme System Foundation

### Objectives
- Define ~10 theme presets as CSS custom property sets
- Refactor `useThemeStore` from dark/light/system to a preset-based system
- Update `index.css` to use CSS custom properties for all color tokens
- Apply the default "Amethyst" dark theme with purple primary

### Tasks
1. Create `src/renderer/src/lib/themes.ts`:
   - Define `ThemePreset` interface: `{ id: string, name: string, type: 'dark' | 'light', colors: Record<string, string> }`
   - Define 10 theme presets (Amethyst, Obsidian, Midnight Blue, Emerald Night, Crimson, Sunset, Daylight, Cloud, Mint, Rose)
   - Each preset defines HSL values for: `primary`, `primary-foreground`, `accent`, `accent-foreground`, `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `muted`, `muted-foreground`, `border`, `input`, `ring`, `secondary`, `secondary-foreground`, `destructive`, `destructive-foreground`, `sidebar-background`, `sidebar-foreground`, `sidebar-border`, `sidebar-accent`, `sidebar-accent-foreground`
   - Export `THEME_PRESETS` array, `DEFAULT_THEME_ID = 'amethyst'`, `getThemeById(id)` helper
2. Update `src/renderer/src/index.css`:
   - Replace hardcoded HSL values in `:root` and `.dark` with the Amethyst theme defaults
   - Ensure all existing `--` custom properties are preserved (just change values)
   - The purple primary for Amethyst: `--primary: 270 60% 55%`
3. Refactor `src/renderer/src/stores/useThemeStore.ts`:
   - Replace `theme: 'dark' | 'light' | 'system'` with `themeId: string`
   - Add `setTheme(id: string)` that looks up preset, applies to DOM, persists
   - Add `applyTheme(preset: ThemePreset)` that sets `dark`/`light` class and applies CSS custom properties via `root.style.setProperty`
   - Add `getCurrentTheme(): ThemePreset` getter
   - On startup: load theme ID from database → apply preset → fallback to 'amethyst'
   - Persist to settings database: key `'selected_theme'`, value is theme ID string
   - Remove `cycleTheme()`, `getEffectiveTheme()`, system theme listener (no longer needed — themes are explicit dark/light)
4. Update `loadFromDatabase()` to load theme ID instead of dark/light/system string
5. Ensure `applyTheme` runs before first render (in store initialization or App.tsx mount)

### Key Files
- `src/renderer/src/lib/themes.ts` — **NEW** theme preset definitions
- `src/renderer/src/stores/useThemeStore.ts` — refactor to preset system
- `src/renderer/src/index.css` — update CSS custom properties

### Definition of Done
- [ ] `themes.ts` defines 10 theme presets (6 dark, 4 light)
- [ ] Each preset has complete color definitions for all CSS custom properties
- [ ] `useThemeStore` uses `themeId` instead of `'dark' | 'light' | 'system'`
- [ ] `setTheme('amethyst')` applies purple-primary dark theme
- [ ] `setTheme('daylight')` applies purple-primary light theme
- [ ] Theme persists to SQLite database across app restarts
- [ ] Default Amethyst theme applies on fresh install
- [ ] All existing Tailwind utility classes (`bg-primary`, `text-primary`, etc.) still work
- [ ] No visual regression — app looks correct with new theme applied

### Testing Criteria
```typescript
// test/phase-4/session-1/theme-system.test.ts
describe('Session 1: Theme System Foundation', () => {
  test('THEME_PRESETS contains 10 presets', () => {
    // Import THEME_PRESETS
    // Verify length is 10
    // Verify 6 dark, 4 light
  });

  test('Each preset has all required color properties', () => {
    // For each preset, verify colors object has: primary, background, foreground, etc.
  });

  test('getThemeById returns correct preset', () => {
    // Verify getThemeById('amethyst') returns amethyst preset
    // Verify getThemeById('unknown') returns null/undefined
  });

  test('setTheme applies CSS custom properties to root', () => {
    // Call setTheme('midnight-blue')
    // Verify document.documentElement has --primary set to blue value
  });

  test('setTheme toggles dark/light class', () => {
    // setTheme('amethyst') — verify .dark class
    // setTheme('daylight') — verify no .dark class, has .light
  });

  test('Theme persists to database', () => {
    // setTheme('emerald-night')
    // Reload store from database
    // Verify themeId is 'emerald-night'
  });

  test('Default theme is amethyst on fresh install', () => {
    // Clear database
    // Load store
    // Verify themeId is 'amethyst'
  });

  test('Existing Tailwind classes pick up theme colors', () => {
    // setTheme('crimson')
    // Render a bg-primary element
    // Verify computed background color matches crimson primary
  });
});
```

---

## Session 2: Settings Appearance & Header Update

### Objectives
- Create an Appearance section in the Settings modal with theme grid
- Add Appearance as the first nav item in SettingsModal
- Remove the theme dropdown from the Header
- Add a settings gear icon to the Header

### Tasks
1. Create `src/renderer/src/components/settings/SettingsAppearance.tsx`:
   - Import `THEME_PRESETS` from `themes.ts` and `useThemeStore`
   - Render a grid of theme cards (3 columns, responsive)
   - Each card: small preview rectangle (bg color + primary color swatch), theme name below, checkmark border on active theme
   - Click handler: `setTheme(preset.id)` — applies immediately
   - Group themes by type: "Dark Themes" section header, "Light Themes" section header
2. Update `src/renderer/src/components/settings/SettingsModal.tsx`:
   - Add "Appearance" section to the nav (first item, above General)
   - Use `Palette` icon from lucide-react
   - Import and render `SettingsAppearance` when `activeSection === 'appearance'`
   - Set default `activeSection` to `'appearance'`
3. Update `src/renderer/src/components/layout/Header.tsx`:
   - Remove the theme dropdown menu (the DropdownMenu with Light/Dark/System options)
   - Add a Settings gear button that opens the settings modal: `useSettingsStore.getState().openSettings()`
   - Keep session history button and right sidebar toggle
   - Clean layout: session history | settings gear | sidebar toggle

### Key Files
- `src/renderer/src/components/settings/SettingsAppearance.tsx` — **NEW**
- `src/renderer/src/components/settings/SettingsModal.tsx` — add Appearance section
- `src/renderer/src/components/layout/Header.tsx` — remove theme dropdown, add settings gear

### Definition of Done
- [ ] SettingsAppearance component renders a grid of 10 theme cards
- [ ] Theme cards show mini preview with background + primary accent color
- [ ] Active theme has highlighted border or checkmark
- [ ] Clicking a theme card applies it immediately (no save button needed)
- [ ] Themes grouped under "Dark Themes" and "Light Themes" headers
- [ ] Appearance is the first section in Settings nav
- [ ] Theme dropdown removed from Header
- [ ] Settings gear icon in Header opens SettingsModal
- [ ] Pressing Cmd+, still opens Settings (existing shortcut)

### Testing Criteria
```typescript
// test/phase-4/session-2/settings-appearance.test.ts
describe('Session 2: Settings Appearance & Header Update', () => {
  test('Settings modal shows Appearance as first section', () => {
    // Open settings
    // Verify first nav item is "Appearance"
  });

  test('Appearance section renders 10 theme cards', () => {
    // Open settings > Appearance
    // Verify 10 theme card elements
  });

  test('Active theme card has visual indicator', () => {
    // Current theme is amethyst
    // Verify amethyst card has active indicator (border/checkmark)
  });

  test('Clicking theme card applies theme immediately', () => {
    // Click "Midnight Blue" card
    // Verify document.documentElement has midnight-blue CSS properties
    // Verify card becomes active
  });

  test('Dark and Light themes are grouped', () => {
    // Verify "Dark Themes" header followed by 6 cards
    // Verify "Light Themes" header followed by 4 cards
  });

  test('Theme dropdown removed from Header', () => {
    // Query for theme dropdown trigger
    // Verify it does NOT exist
  });

  test('Settings gear in Header opens settings', () => {
    // Click settings gear icon in Header
    // Verify SettingsModal opens
  });

  test('Cmd+, still opens settings', () => {
    // Press Cmd+,
    // Verify SettingsModal opens
  });
});
```

---

## Session 3: Model Selection

### Objectives
- Add model listing API to opencode-service using `client.config.providers()`
- Wire IPC handler and preload for model list + model persistence
- Create ModelSelector UI component (pill + popover dropdown)
- Integrate ModelSelector into the SessionView input area
- Use persisted model in `prompt()` instead of hardcoded default

### Tasks
1. In `src/main/services/opencode-service.ts`:
   - Add `async getAvailableModels()` method that calls `instance.client.config.providers()` and returns the data
   - Modify `prompt()` method (around line 270) to read selected model from settings database instead of `DEFAULT_MODEL`
   - Add helper to load selected model: read `'selected_model'` key from settings DB, parse JSON `{ providerID, modelID }`, fallback to `DEFAULT_MODEL`
2. In `src/main/ipc/opencode-handlers.ts`:
   - Add `ipcMain.handle('opencode:models', async () => openCodeService.getAvailableModels())`
   - Add `ipcMain.handle('opencode:setModel', async (_, model) => { /* save to settings DB */ })`
3. In `src/preload/index.ts`:
   - Add `listModels: () => ipcRenderer.invoke('opencode:models')` to `opencodeOps`
   - Add `setModel: (model) => ipcRenderer.invoke('opencode:setModel', model)` to `opencodeOps`
4. Create `src/renderer/src/components/sessions/ModelSelector.tsx`:
   - Compact pill button showing shortened model name (strip date suffix: `claude-opus-4-5-20251101` → `claude-opus-4-5`)
   - Use `model.name` from SDK if available, otherwise strip with regex `/(-\d{8,})$/`
   - On click: open Popover with scrollable list of all models grouped by provider
   - Each model item: name, provider label, checkmark if active
   - On select: call `window.opencodeOps.setModel({ providerID, modelID })`, update local state
   - On mount: load current model from settings, load model list from `window.opencodeOps.listModels()`
   - Use shadcn Popover + Command components for the dropdown
5. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - Import and render `<ModelSelector />` in the input area bottom row, to the left of the hint text
   - Layout: `[model pill] ... [hint text] ... [send button]`
6. Add `selectedModel` to `useSettingsStore` for reactive UI updates

### Key Files
- `src/main/services/opencode-service.ts` — add `getAvailableModels()`, read model from settings
- `src/main/ipc/opencode-handlers.ts` — add model IPC handlers
- `src/preload/index.ts` — expose model IPC to renderer
- `src/renderer/src/components/sessions/ModelSelector.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionView.tsx` — integrate ModelSelector
- `src/renderer/src/stores/useSettingsStore.ts` — add selectedModel

### Definition of Done
- [ ] `getAvailableModels()` returns providers with models from OpenCode SDK
- [ ] `opencode:models` IPC handler works from renderer
- [ ] `opencode:setModel` persists model selection to settings DB
- [ ] Model pill visible in input area showing shortened model name
- [ ] Clicking pill opens popover with all available models
- [ ] Models grouped by provider in dropdown
- [ ] Selecting a model updates the pill and persists
- [ ] `prompt()` uses persisted model instead of hardcoded default
- [ ] Fallback to `claude-opus-4-5-20251101` if no model set
- [ ] Model change applies to ALL sessions (global setting)

### Testing Criteria
```typescript
// test/phase-4/session-3/model-selection.test.ts
describe('Session 3: Model Selection', () => {
  test('getAvailableModels returns provider data', () => {
    // Call getAvailableModels
    // Verify response has providers array
    // Verify each provider has models dictionary
  });

  test('opencode:models IPC handler returns data', () => {
    // Invoke via IPC
    // Verify non-empty response
  });

  test('Model pill renders in input area', () => {
    // Render SessionView
    // Verify model pill element exists in input container
  });

  test('Model pill shows shortened name', () => {
    // Default model: claude-opus-4-5-20251101
    // Verify pill text is "claude-opus-4-5" (no date)
  });

  test('Clicking pill opens model popover', () => {
    // Click model pill
    // Verify popover/dropdown is visible
    // Verify model items listed
  });

  test('Models grouped by provider', () => {
    // Open popover
    // Verify provider group headers (e.g., "Anthropic", "OpenAI")
  });

  test('Active model has checkmark', () => {
    // Open popover
    // Verify current model item has checkmark indicator
  });

  test('Selecting model updates pill text', () => {
    // Click different model
    // Verify pill text changes
  });

  test('Model selection persists across app restarts', () => {
    // Select model, reload store
    // Verify same model loaded
  });

  test('prompt() uses selected model', () => {
    // Set model to claude-sonnet-4-5
    // Send prompt
    // Verify prompt sent with correct providerID/modelID
  });

  test('Falls back to default when no model set', () => {
    // Clear settings
    // Call prompt
    // Verify uses claude-opus-4-5-20251101
  });
});
```

---

## Session 4: Streaming Markdown Throttle & Tab Mode Toggle

### Objectives
- Add a throttle mechanism (~100ms) to batch streaming text updates for MarkdownRenderer
- Change the mode toggle shortcut from Shift+Tab to plain Tab
- Ensure Tab key is intercepted globally and does not insert tab characters

### Tasks
1. In `src/renderer/src/components/sessions/SessionView.tsx`, modify the streaming text handler:
   - Add `rawContentRef = useRef('')` to accumulate raw streaming text without triggering re-renders
   - Add `throttleRef = useRef<NodeJS.Timeout | null>(null)` for the throttle timer
   - On each text delta event: append to `rawContentRef.current`, start 100ms throttle if not already running
   - On throttle fire: copy `rawContentRef.current` to the state that drives `MarkdownRenderer`
   - On stream end (`session.idle`): clear any pending throttle, do one final state update with complete text
   - Clean up throttle timer on unmount
2. In `src/renderer/src/components/sessions/AssistantCanvas.tsx`:
   - Ensure the `content` prop passed to `MarkdownRenderer` comes from the throttled state, not raw accumulator
   - Verify partial markdown (unclosed fences, partial lists) renders gracefully
3. In `src/renderer/src/components/sessions/SessionView.tsx`, modify the global keydown listener:
   - Find the existing `Shift+Tab` handler
   - Change condition from `e.key === 'Tab' && e.shiftKey` to `e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey`
   - Add `e.preventDefault()` and `e.stopPropagation()` to block tab character insertion
   - Ensure the listener is registered in capture phase: `window.addEventListener('keydown', handler, true)`
4. In `src/renderer/src/components/sessions/ModeToggle.tsx`:
   - Update tooltip from `"Shift+Tab to toggle"` to `"Tab to toggle"`
   - Update any `title` or `aria-label` referencing Shift+Tab

### Key Files
- `src/renderer/src/components/sessions/SessionView.tsx` — throttle logic + Tab key handler
- `src/renderer/src/components/sessions/AssistantCanvas.tsx` — ensure partial content passes through
- `src/renderer/src/components/sessions/ModeToggle.tsx` — update tooltip

### Definition of Done
- [ ] Streaming text updates are batched at ~100ms intervals (not per-token)
- [ ] `MarkdownRenderer` re-renders at most ~10 times/second during streaming
- [ ] Partial markdown (unclosed code fences, partial lists) renders without errors
- [ ] Final render after stream end shows complete content
- [ ] No data loss — all streamed text appears in final render
- [ ] `Tab` key (unmodified) toggles between Build and Plan modes
- [ ] `Tab` does not insert tab character in textarea
- [ ] `Tab` is intercepted globally (works even when textarea not focused)
- [ ] `Shift+Tab` no longer toggles mode
- [ ] ModeToggle tooltip says "Tab to toggle"

### Testing Criteria
```typescript
// test/phase-4/session-4/streaming-throttle-mode-toggle.test.ts
describe('Session 4: Streaming Throttle & Mode Toggle', () => {
  test('Streaming text batched at ~100ms intervals', () => {
    // Emit 50 text deltas in rapid succession
    // Verify MarkdownRenderer re-renders far fewer than 50 times
  });

  test('Partial markdown renders without errors', () => {
    // Set content to "```typescript\nconst x" (unclosed fence)
    // Verify no render error
  });

  test('Final render shows complete content', () => {
    // Stream full message, wait for idle
    // Verify all text present in rendered output
  });

  test('No data loss during throttled streaming', () => {
    // Stream 100 deltas rapidly
    // Compare final rendered text to accumulated deltas
    // Verify they match
  });

  test('Tab key toggles mode', () => {
    // Press Tab
    // Verify mode changes from Build to Plan
    // Press Tab again
    // Verify mode changes back to Build
  });

  test('Tab does not insert tab character', () => {
    // Focus textarea, type some text, press Tab
    // Verify textarea does not contain tab character
  });

  test('Tab works globally (not just in textarea)', () => {
    // Focus outside textarea (e.g., on body)
    // Press Tab
    // Verify mode toggles
  });

  test('Shift+Tab no longer toggles mode', () => {
    // Press Shift+Tab
    // Verify mode does NOT change
  });

  test('ModeToggle tooltip updated', () => {
    // Query ModeToggle tooltip/title
    // Verify contains "Tab to toggle"
    // Verify does NOT contain "Shift+Tab"
  });
});
```

---

## Session 5: Session Auto-Naming via Claude Haiku

### Objectives
- Add a session naming service that calls Claude Haiku to generate a descriptive name
- Wire IPC handler and preload for the naming call
- Trigger naming on the first message in a session
- Update session tab reactively when the name arrives

### Tasks
1. In `src/main/services/opencode-service.ts` (or a new `src/main/services/session-namer.ts`):
   - Add `async generateSessionName(userMessage: string): Promise<string>`
   - Use `@anthropic-ai/sdk` directly with Claude Haiku (`claude-haiku-3-5-20241022` or latest)
   - System prompt: `"Generate a short (3-5 word) descriptive name for a coding session based on the user's first message. Return ONLY the name, no quotes or explanation."`
   - User message: the first message content
   - Set `max_tokens: 20` for minimal response
   - Wrap in a 2-second timeout using `AbortController` + `setTimeout`
   - On failure/timeout: return empty string (caller keeps default name)
2. Install `@anthropic-ai/sdk`: `pnpm add @anthropic-ai/sdk`
3. In `src/main/ipc/opencode-handlers.ts`:
   - Add `ipcMain.handle('opencode:generateSessionName', async (_, message) => openCodeService.generateSessionName(message))`
4. In `src/preload/index.ts`:
   - Add `generateSessionName: (message: string) => ipcRenderer.invoke('opencode:generateSessionName', message)` to `opencodeOps`
5. In `src/renderer/src/components/sessions/SessionView.tsx`:
   - In the `handleSend` function, detect if this is the first message (check `messages.length === 0`)
   - If first message: fire-and-forget call to `window.opencodeOps.generateSessionName(inputValue)`
   - On success: call `updateSessionName(sessionId, name.trim())` from `useSessionStore`
   - Wrap in try/catch — naming failure must never block the conversation
   - Do NOT await the naming call before sending the actual prompt to OpenCode
6. In `src/renderer/src/stores/useSessionStore.ts`:
   - Verify `updateSessionName(sessionId, name)` updates both the store and the database
   - Verify SessionTabs re-renders when the session name changes (should be automatic if sessions are in Zustand state)

### Key Files
- `src/main/services/opencode-service.ts` — add `generateSessionName()` (or new service file)
- `src/main/ipc/opencode-handlers.ts` — add IPC handler
- `src/preload/index.ts` — expose to renderer
- `src/renderer/src/components/sessions/SessionView.tsx` — trigger on first message
- `src/renderer/src/stores/useSessionStore.ts` — verify name update flow
- `package.json` — add `@anthropic-ai/sdk`

### Definition of Done
- [ ] `@anthropic-ai/sdk` installed
- [ ] `generateSessionName()` calls Claude Haiku with the first message
- [ ] Returns a 3-5 word descriptive session name
- [ ] 2-second timeout — returns empty string on timeout
- [ ] IPC handler wired and accessible from renderer
- [ ] First message in a session triggers naming (fire-and-forget)
- [ ] Session tab updates reactively when name arrives
- [ ] Naming failure does not block the conversation
- [ ] Naming failure keeps the default "Session HH:MM" name
- [ ] Second message does not trigger re-naming

### Testing Criteria
```typescript
// test/phase-4/session-5/session-auto-naming.test.ts
describe('Session 5: Session Auto-Naming', () => {
  test('generateSessionName returns descriptive name', () => {
    // Call with "Help me fix the login bug in auth.ts"
    // Verify response is a short string (3-5 words)
  });

  test('generateSessionName respects 2s timeout', () => {
    // Mock slow API response (>2s)
    // Verify returns empty string
  });

  test('generateSessionName handles API failure gracefully', () => {
    // Mock API error
    // Verify returns empty string (no throw)
  });

  test('First message triggers session naming', () => {
    // Send first message in new session
    // Verify generateSessionName called with message content
  });

  test('Session tab updates when name arrives', () => {
    // Mock generateSessionName to return "Fix Login Auth Bug"
    // Send first message
    // Wait for name update
    // Verify session tab text changed from "Session HH:MM" to "Fix Login Auth Bug"
  });

  test('Second message does not trigger re-naming', () => {
    // Send first message (triggers naming)
    // Send second message
    // Verify generateSessionName called only once
  });

  test('Naming failure keeps default name', () => {
    // Mock generateSessionName to fail
    // Send first message
    // Verify tab still shows "Session HH:MM"
  });

  test('Naming does not block conversation', () => {
    // Mock slow generateSessionName (1.5s)
    // Send message
    // Verify message sent to OpenCode immediately (not waiting for name)
  });
});
```

---

## Session 6: Language Detection & Icons

### Objectives
- Create a language detection service that checks project root for characteristic files
- Add a `language` column to the projects table (DB migration v3)
- Detect language on project add and on manual refresh
- Show language-specific icons in the project sidebar instead of folder icons

### Tasks
1. Create `src/main/services/language-detector.ts`:
   - Export `async detectProjectLanguage(projectPath: string): Promise<string | null>`
   - Check files in priority order using `fs.existsSync`:
     1. `tsconfig.json` → `'typescript'`
     2. `package.json` (without tsconfig) → `'javascript'`
     3. `go.mod` or `go.sum` → `'go'`
     4. `Cargo.toml` → `'rust'`
     5. `requirements.txt` or `pyproject.toml` or `setup.py` → `'python'`
     6. `Gemfile` → `'ruby'`
     7. `Package.swift` → `'swift'`
     8. `pom.xml` or `build.gradle` → `'java'`
     9. `composer.json` → `'php'`
     10. `mix.exs` → `'elixir'`
     11. `pubspec.yaml` → `'dart'`
     12. `CMakeLists.txt` → `'cpp'`
     13. Glob for `*.csproj` or `*.sln` → `'csharp'`
   - Return `null` if no match
2. In `src/main/db/schema.ts`:
   - Add migration v3: `ALTER TABLE projects ADD COLUMN language TEXT`
   - Update schema version check
3. In `src/main/ipc/project-handlers.ts`:
   - Add `ipcMain.handle('project:detectLanguage', async (_, projectPath) => detectProjectLanguage(projectPath))`
   - Modify the project add handler to auto-detect language and store it
4. In `src/preload/index.ts`:
   - Add `detectLanguage: (path: string) => ipcRenderer.invoke('project:detectLanguage', path)` to project ops
5. Create `src/renderer/src/components/projects/LanguageIcon.tsx`:
   - Accept `language: string | null` prop
   - Render inline SVG or styled div for each language:
     - TypeScript: blue square with "TS"
     - JavaScript: yellow square with "JS"
     - Python: blue/yellow diamond
     - Go: cyan gopher silhouette
     - Rust: orange gear
     - etc. (use simple colored shapes with text abbreviations — no external icon library needed)
   - Fallback: `FolderGit2` icon from lucide-react for unknown/null
   - Size: 16x16px to match existing folder icon size
6. Update `src/renderer/src/components/projects/ProjectItem.tsx`:
   - Replace `FolderOpen` / `FolderClosed` icons with `<LanguageIcon language={project.language} />`
   - Keep expand/collapse chevron as-is
7. Update `src/renderer/src/stores/useProjectStore.ts`:
   - Add `language` field to the Project type
   - Add `refreshLanguage(projectId: string)` action that re-detects and updates
8. Update `src/renderer/src/components/projects/ProjectItem.tsx` context menu:
   - Add "Refresh Language" option to the 3-dot menu
   - On click: call `refreshLanguage(project.id)`

### Key Files
- `src/main/services/language-detector.ts` — **NEW**
- `src/main/db/schema.ts` — migration v3
- `src/main/ipc/project-handlers.ts` — add detection handler, auto-detect on add
- `src/preload/index.ts` — expose detection
- `src/renderer/src/components/projects/LanguageIcon.tsx` — **NEW**
- `src/renderer/src/components/projects/ProjectItem.tsx` — use LanguageIcon, add menu item
- `src/renderer/src/stores/useProjectStore.ts` — add language field + refresh action

### Definition of Done
- [ ] `detectProjectLanguage` correctly identifies TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, Swift, PHP, Elixir, Dart, C++, C#
- [ ] Returns `null` for unrecognized projects
- [ ] `tsconfig.json` + `package.json` → TypeScript (not JavaScript)
- [ ] DB migration adds `language` column
- [ ] Language auto-detected when adding a project
- [ ] "Refresh Language" appears in project context menu
- [ ] Refresh re-detects and updates the icon
- [ ] LanguageIcon shows correct icon/color for each language
- [ ] Unknown language falls back to folder icon
- [ ] Project items show language icon instead of folder icon

### Testing Criteria
```typescript
// test/phase-4/session-6/language-detection.test.ts
describe('Session 6: Language Detection & Icons', () => {
  test('Detects TypeScript project', () => {
    // Project with tsconfig.json + package.json
    // Verify returns 'typescript'
  });

  test('Detects JavaScript project (no tsconfig)', () => {
    // Project with package.json only
    // Verify returns 'javascript'
  });

  test('Detects Python project', () => {
    // Project with requirements.txt
    // Verify returns 'python'
  });

  test('Detects Go project', () => {
    // Project with go.mod
    // Verify returns 'go'
  });

  test('Detects Rust project', () => {
    // Project with Cargo.toml
    // Verify returns 'rust'
  });

  test('Returns null for unknown project', () => {
    // Empty directory
    // Verify returns null
  });

  test('Language detected on project add', () => {
    // Add project with tsconfig.json
    // Verify project.language is 'typescript'
  });

  test('Refresh Language re-detects', () => {
    // Add project, create go.mod after add
    // Click Refresh Language
    // Verify language updates to 'go'
  });

  test('LanguageIcon renders correct icon for TypeScript', () => {
    // Render LanguageIcon with language='typescript'
    // Verify blue TS icon visible
  });

  test('LanguageIcon falls back to folder for null', () => {
    // Render LanguageIcon with language=null
    // Verify folder icon visible
  });

  test('ProjectItem shows language icon instead of folder', () => {
    // Render ProjectItem with language='python'
    // Verify Python icon visible
    // Verify no FolderOpen/FolderClosed icon
  });

  test('Refresh Language in context menu', () => {
    // Open project context menu
    // Verify "Refresh Language" option exists
  });

  test('DB migration adds language column', () => {
    // Run migration
    // Verify projects table has language column
  });
});
```

---

## Session 7: Right Sidebar Split & Bottom Panel

### Objectives
- Split the right sidebar into two halves: file tree (top) and a 3-tab panel (bottom)
- Create a BottomPanel component with Setup, Run, Terminal tabs
- Each tab renders a TODO placeholder for now

### Tasks
1. Update `src/renderer/src/components/layout/RightSidebar.tsx`:
   - Change the current layout from `GitStatusPanel` + `FileTree (flex-1)` to:
     - Top half: `GitStatusPanel` + `FileTree` constrained to `h-1/2` (or `flex-1` with max)
     - Bottom half: `BottomPanel` taking the other `h-1/2`
   - Use `flex flex-col` with two children each getting `flex-1` and `min-h-0` for scrollability
   - Add a subtle `border-t border-border` divider between the halves
2. Create `src/renderer/src/components/layout/BottomPanel.tsx`:
   - Local state: `activeTab: 'setup' | 'run' | 'terminal'` (default: `'setup'`)
   - Tab bar at top: 3 buttons ("Setup", "Run", "Terminal")
   - Active tab has bottom border indicator (e.g., `border-b-2 border-primary`)
   - Tab buttons: compact, `text-xs`, `px-3 py-1.5`
   - Content area: renders the active tab's content (flex-1, overflow-auto)
   - Each tab content: `TodoPlaceholder` component showing "TODO: {tab name}" centered
3. Style the tab bar to feel integrated with the sidebar's existing aesthetic
4. Ensure the file tree in the top half remains scrollable with `overflow-auto`

### Key Files
- `src/renderer/src/components/layout/RightSidebar.tsx` — split into halves
- `src/renderer/src/components/layout/BottomPanel.tsx` — **NEW**

### Definition of Done
- [ ] Right sidebar splits into two equal-height halves
- [ ] Top half: GitStatusPanel + scrollable FileTree
- [ ] Bottom half: BottomPanel with tab bar + content
- [ ] Tab bar shows Setup, Run, Terminal tabs
- [ ] Active tab has underline indicator
- [ ] Clicking a tab switches the content area
- [ ] Each tab content shows "TODO: {name}" placeholder
- [ ] File tree remains scrollable in its half
- [ ] Divider line between top and bottom halves
- [ ] Bottom panel content area is scrollable

### Testing Criteria
```typescript
// test/phase-4/session-7/right-sidebar-split.test.ts
describe('Session 7: Right Sidebar Split', () => {
  test('Right sidebar has two halves', () => {
    // Verify two main sections in sidebar
    // Verify each takes ~50% height
  });

  test('Top half contains git status and file tree', () => {
    // Verify GitStatusPanel in top half
    // Verify FileTree in top half
  });

  test('Bottom half contains tab panel', () => {
    // Verify BottomPanel in bottom half
  });

  test('Tab bar shows three tabs', () => {
    // Verify "Setup", "Run", "Terminal" tabs visible
  });

  test('Default active tab is Setup', () => {
    // Verify Setup tab has active indicator
    // Verify Setup content visible
  });

  test('Clicking Run tab switches content', () => {
    // Click "Run" tab
    // Verify Run tab active
    // Verify "TODO: Run" content visible
  });

  test('Clicking Terminal tab switches content', () => {
    // Click "Terminal" tab
    // Verify Terminal tab active
    // Verify "TODO: Terminal" content visible
  });

  test('File tree scrollable in top half', () => {
    // Render many files
    // Verify top half has overflow-auto and scrolls
  });

  test('Divider between halves', () => {
    // Verify border-t element between top and bottom
  });
});
```

---

## Session 8: File Viewer

### Objectives
- Create a read-only file viewer with syntax highlighting and line numbers
- Add Cmd+F search overlay with match navigation
- Integrate file viewer tabs into SessionTabs alongside session tabs
- Change file tree click behavior to open the file viewer instead of an external editor

### Tasks
1. Add file read IPC in `src/main/ipc/file-handlers.ts` (or existing handler file):
   - `ipcMain.handle('file:read', async (_, filePath: string) => fs.readFileSync(filePath, 'utf-8'))`
   - Add basic validation: check file exists, check not binary (reject >1MB or non-utf8)
2. In `src/preload/index.ts`:
   - Add `readFile: (path: string) => ipcRenderer.invoke('file:read', path)` to appropriate ops
3. Create `src/renderer/src/stores/useFileViewerStore.ts`:
   - State: `openFiles: Map<string, { path: string, name: string, worktreeId: string }>` — keyed by file path
   - State: `activeFilePath: string | null`
   - Actions: `openFile(path, name, worktreeId)`, `closeFile(path)`, `setActiveFile(path)`
4. Create `src/renderer/src/components/file-viewer/FileViewer.tsx`:
   - Props: `filePath: string`
   - On mount: load file content via `window.fileOps.readFile(filePath)`
   - Render with `react-syntax-highlighter` (Prism with `oneDark` theme)
   - Detect language from file extension (reuse logic from `FileIcon.tsx`)
   - Show line numbers (built into react-syntax-highlighter)
   - Scrollable content area
   - Cmd+F keyboard shortcut to toggle search overlay
5. Create `src/renderer/src/components/file-viewer/FileSearch.tsx`:
   - Sticky search bar at top of file viewer
   - Input field with search query
   - Match count display: "3 of 12"
   - Up/Down arrows to navigate between matches
   - Escape to close
   - Highlight all matches in the content (use `mark` element or custom background)
   - Auto-scroll to current match
6. Update `src/renderer/src/components/sessions/SessionTabs.tsx`:
   - Support mixed tab types: sessions (existing) + file viewers (new)
   - Define a union type: `TabItem = { type: 'session', id: string, name: string } | { type: 'file', path: string, name: string }`
   - Render file tabs with a file icon prefix (use `FileCode` from lucide)
   - Close button on file tabs removes from `useFileViewerStore`
   - Clicking a session tab sets active session, clicking a file tab sets active file
7. Update `src/renderer/src/components/layout/MainPane.tsx`:
   - Check `useFileViewerStore.activeFilePath` — if set and is the currently active tab, render `<FileViewer>` instead of `<SessionView>`
   - Route: active session tab → SessionView, active file tab → FileViewer
8. Update `src/renderer/src/components/file-tree/FileTree.tsx`:
   - Change file click handler from opening in external editor to `useFileViewerStore.openFile(path, name, worktreeId)`

### Key Files
- `src/main/ipc/file-handlers.ts` — file read IPC
- `src/preload/index.ts` — expose readFile
- `src/renderer/src/stores/useFileViewerStore.ts` — **NEW**
- `src/renderer/src/components/file-viewer/FileViewer.tsx` — **NEW**
- `src/renderer/src/components/file-viewer/FileSearch.tsx` — **NEW**
- `src/renderer/src/components/sessions/SessionTabs.tsx` — mixed tab types
- `src/renderer/src/components/layout/MainPane.tsx` — route to FileViewer
- `src/renderer/src/components/file-tree/FileTree.tsx` — change click handler

### Definition of Done
- [ ] `file:read` IPC reads file content and returns it
- [ ] File viewer renders file content with syntax highlighting
- [ ] Line numbers displayed
- [ ] Language auto-detected from file extension
- [ ] Cmd+F opens search overlay
- [ ] Search highlights all matches in file
- [ ] Up/Down arrows navigate between matches
- [ ] Match count displayed (e.g., "3 of 12")
- [ ] Escape closes search
- [ ] File tabs appear in SessionTabs alongside session tabs
- [ ] File tabs have file icon prefix
- [ ] Closing a file tab removes it
- [ ] Clicking file in tree opens file viewer tab (not external editor)
- [ ] File viewer tab is read-only (no editing)
- [ ] MainPane routes to FileViewer when file tab is active

### Testing Criteria
```typescript
// test/phase-4/session-8/file-viewer.test.ts
describe('Session 8: File Viewer', () => {
  test('file:read IPC returns file content', () => {
    // Read a known file
    // Verify content matches
  });

  test('FileViewer renders with syntax highlighting', () => {
    // Open a .ts file
    // Verify syntax highlighting applied
  });

  test('Line numbers displayed', () => {
    // Open file with 50 lines
    // Verify line numbers 1-50 visible
  });

  test('Language detected from extension', () => {
    // Open .py file
    // Verify Python syntax highlighting
  });

  test('Cmd+F opens search overlay', () => {
    // Focus file viewer
    // Press Cmd+F
    // Verify search bar visible
  });

  test('Search highlights matches', () => {
    // Open file, search for "const"
    // Verify highlight elements in content
  });

  test('Match count displayed', () => {
    // Search for term with 5 matches
    // Verify "1 of 5" displayed
  });

  test('Up/Down arrows navigate matches', () => {
    // Search, press Down
    // Verify "2 of 5" displayed
    // Press Up
    // Verify "1 of 5" displayed
  });

  test('Escape closes search', () => {
    // Open search, press Escape
    // Verify search bar hidden
  });

  test('File tab appears in SessionTabs', () => {
    // Open a file
    // Verify file tab in tab bar with file icon
  });

  test('Closing file tab removes it', () => {
    // Open file, click close on tab
    // Verify tab removed
  });

  test('Clicking file in tree opens viewer', () => {
    // Click file in file tree
    // Verify file viewer opens (not external editor)
  });

  test('MainPane shows FileViewer for active file tab', () => {
    // Activate file tab
    // Verify FileViewer component rendered (not SessionView)
  });
});
```

---

## Session 9: Header Quick Actions

### Objectives
- Add a 2-button group to the header: "Last Operation" button + "Open" dropdown
- Support opening worktree in Cursor, Ghostty, or copying path
- Persist last operation for repeat use

### Tasks
1. Create `src/renderer/src/components/layout/QuickActions.tsx`:
   - State: `lastAction: 'cursor' | 'ghostty' | 'copy-path' | null` (loaded from settings)
   - Button 1 (last operation): shows icon + label of last action, clicks to re-execute
   - Button 2 (dropdown chevron): opens menu with Cursor, Ghostty, Copy Path options
   - Use shadcn `DropdownMenu` for the dropdown
   - Each action executes via IPC then updates `lastAction`
   - If no last action yet, Button 1 shows "Open" with generic icon
   - Both buttons styled as a connected button group (first has rounded-l, second has rounded-r, shared border)
2. Add IPC handlers in `src/main/ipc/system-handlers.ts` (or existing):
   - `ipcMain.handle('system:openInApp', async (_, app: string, path: string) => { ... })`
   - For `'cursor'`: `spawn('cursor', [path])` or `spawn('open', ['-a', 'Cursor', path])`
   - For `'ghostty'`: `spawn('open', ['-a', 'Ghostty', path])`
   - For `'copy-path'`: `clipboard.writeText(path)` (use Electron's clipboard)
3. In `src/preload/index.ts`:
   - Add `openInApp: (app: string, path: string) => ipcRenderer.invoke('system:openInApp', app, path)` to `systemOps`
4. Update `src/renderer/src/components/layout/Header.tsx`:
   - Import and render `<QuickActions />` in the right side button area
   - Position: between session history and settings gear
   - QuickActions needs to know the current worktree path — get from `useWorktreeStore`
   - Disable/hide when no worktree is selected
5. Add `lastOpenAction` to `useSettingsStore`:
   - Persist to settings database: key `'last_open_action'`
   - Load on startup

### Key Files
- `src/renderer/src/components/layout/QuickActions.tsx` — **NEW**
- `src/main/ipc/system-handlers.ts` — add openInApp handler
- `src/preload/index.ts` — expose openInApp
- `src/renderer/src/components/layout/Header.tsx` — integrate QuickActions
- `src/renderer/src/stores/useSettingsStore.ts` — add lastOpenAction

### Definition of Done
- [ ] QuickActions renders as a connected 2-button group in the header
- [ ] Last operation button shows icon + label of last used action
- [ ] Clicking last operation button re-executes the action
- [ ] Dropdown shows Cursor, Ghostty, Copy Path options
- [ ] Cursor opens worktree folder in Cursor
- [ ] Ghostty opens worktree folder in Ghostty terminal
- [ ] Copy Path copies worktree path to clipboard
- [ ] Selecting an action updates the last operation button
- [ ] Last operation persists across app restarts
- [ ] Quick actions disabled when no worktree selected
- [ ] Default state (no prior action) shows "Open" with generic icon

### Testing Criteria
```typescript
// test/phase-4/session-9/header-quick-actions.test.ts
describe('Session 9: Header Quick Actions', () => {
  test('QuickActions renders in header', () => {
    // Select worktree
    // Verify QuickActions component visible in header
  });

  test('Default state shows Open button', () => {
    // Clear last action
    // Verify button shows "Open"
  });

  test('Dropdown shows three options', () => {
    // Click dropdown chevron
    // Verify Cursor, Ghostty, Copy Path options
  });

  test('Cursor option opens worktree in Cursor', () => {
    // Mock system:openInApp
    // Select Cursor from dropdown
    // Verify IPC called with ('cursor', worktreePath)
  });

  test('Ghostty option opens worktree in Ghostty', () => {
    // Mock system:openInApp
    // Select Ghostty from dropdown
    // Verify IPC called with ('ghostty', worktreePath)
  });

  test('Copy Path copies to clipboard', () => {
    // Select Copy Path
    // Verify clipboard contains worktree path
  });

  test('Last operation updates after selection', () => {
    // Select Cursor
    // Verify button shows "Cursor" with Cursor icon
  });

  test('Last operation button re-executes action', () => {
    // Select Cursor, then click last operation button
    // Verify openInApp called again with same args
  });

  test('Last operation persists across restarts', () => {
    // Select Ghostty
    // Reload settings store
    // Verify lastOpenAction is 'ghostty'
  });

  test('Quick actions disabled without worktree', () => {
    // Deselect all worktrees
    // Verify buttons disabled
  });
});
```

---

## Session 10: Integration Polish & Verification

### Objectives
- End-to-end verification of all Phase 4 features working together
- Fix visual inconsistencies across all 10 themes
- Ensure performance targets are met
- Verify accessibility attributes
- Run lint and typecheck

### Tasks
1. Verify all 10 themes render correctly:
   - Apply each theme, take mental snapshot of key areas (input area, sidebar, header, settings)
   - Verify primary colors, backgrounds, borders, text colors all pick up the theme
   - Verify no hardcoded colors that break theming
2. Verify model selection end-to-end:
   - Change model in pill, send a message, verify model used in OpenCode prompt
   - Switch theme, verify model pill still readable
3. Verify streaming markdown throttle:
   - Send a long message that triggers a large response
   - Observe streaming: text should appear smoothly at ~100ms intervals
   - No jank, no missing content at end
4. Verify Tab mode toggle works across all contexts:
   - Tab in textarea (no tab char inserted, mode toggles)
   - Tab outside textarea (mode toggles)
   - Tab in file viewer (mode toggles, not inserted in search)
5. Verify session auto-naming:
   - Create new session, send first message
   - Wait for tab name to update from "Session HH:MM" to descriptive name
6. Verify language icons:
   - Add a TypeScript project, Go project, Python project
   - Verify each shows correct icon
   - Refresh language on one, verify icon updates
7. Verify right sidebar split:
   - File tree scrollable in top half
   - Tab panel functional in bottom half
   - Both halves maintain correct proportions
8. Verify file viewer:
   - Click file in tree → viewer opens as tab
   - Cmd+F search works
   - Close file tab → returns to session
9. Verify header quick actions:
   - Open dropdown, select Cursor → verify opens
   - Click last operation button → verify re-executes
10. Run `pnpm lint` — fix any errors
11. Run `pnpm typecheck` — fix any type errors
12. Profile key operations against performance targets

### Key Files
- All files modified in sessions 1-9
- Focus on cross-cutting concerns and integration points

### Definition of Done
- [ ] All 10 themes render correctly with no hardcoded color leaks
- [ ] Model selection works end-to-end (select → prompt uses model)
- [ ] Streaming markdown renders smoothly at ~100ms intervals
- [ ] Tab toggles mode globally, no tab characters inserted
- [ ] First message triggers session name update
- [ ] Language icons show for detected projects
- [ ] Right sidebar split is visually balanced
- [ ] File viewer opens from tree, has search, displays correctly
- [ ] Header quick actions open apps and persist last action
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] No console errors during normal operation
- [ ] Theme switch < 50ms
- [ ] Model list load < 1s
- [ ] Streaming throttle ~100ms interval
- [ ] Session naming < 2s
- [ ] File viewer open < 200ms

### Testing Criteria
```typescript
// test/phase-4/session-10/integration-polish.test.ts
describe('Session 10: Integration Polish', () => {
  test('All 10 themes apply without visual errors', () => {
    // Loop through all THEME_PRESETS
    // Apply each, verify key CSS properties set on :root
  });

  test('Model pill readable in all themes', () => {
    // Apply dark theme, verify model pill text visible
    // Apply light theme, verify model pill text visible
  });

  test('Streaming + throttle produces smooth output', () => {
    // Simulate 200 text deltas over 2 seconds
    // Count MarkdownRenderer renders
    // Verify ~20 renders (not 200)
  });

  test('Tab toggles mode, does not insert tabs', () => {
    // Focus textarea, type text, press Tab
    // Verify mode changed, no tab in text
  });

  test('Session naming end-to-end', () => {
    // Create session, send "Fix the login page CSS"
    // Wait up to 3s
    // Verify tab name is no longer "Session HH:MM"
  });

  test('Language icon displayed for TypeScript project', () => {
    // Verify project with tsconfig shows TS icon
  });

  test('Right sidebar halves are balanced', () => {
    // Verify top and bottom halves each ~50% of sidebar height
  });

  test('File viewer opens from tree click', () => {
    // Click a .ts file in tree
    // Verify FileViewer component rendered
    // Verify file tab in tab bar
  });

  test('Quick actions open Cursor', () => {
    // Click Cursor in dropdown
    // Verify IPC called
    // Verify last operation button shows "Cursor"
  });

  test('Lint passes', () => {
    // Run pnpm lint
    // Verify exit code 0
  });

  test('Typecheck passes', () => {
    // Run pnpm typecheck
    // Verify exit code 0
  });

  test('No console errors during normal operation', () => {
    // Capture console.error
    // Navigate through all features
    // Verify zero errors
  });
});
```

---

## Dependencies & Order

```
Session 1 (Theme Foundation)
    |
    v
Session 2 (Settings Appearance & Header)
    |
    +--------------------------------------------------+
    |                    |               |              |
    v                    v               v              v
Session 3            Session 4       Session 5     Session 6
(Model Selection)    (Streaming +    (Auto-Naming) (Language Icons)
    |                Tab Toggle)         |              |
    |                    |               |              |
    +--------------------------------------------------+
    |                    |
    v                    v
Session 7            Session 8
(Sidebar Split)      (File Viewer)
    |                    |
    +--------------------+
    |
    v
Session 9 (Header Quick Actions)
    |
    v
Session 10 (Integration Polish)
```

### Parallel Tracks
- **Track A** (Theme & Settings): Sessions 1 → 2 (foundation — must complete first)
- **Track B** (Model & Streaming): Sessions 3 → 4 (can run in parallel after Track A)
- **Track C** (Auto-Naming): Session 5 (independent after Track A)
- **Track D** (Language & Sidebar): Sessions 6 → 7 (independent after Track A)
- **Track E** (File Viewer): Session 8 (independent after Track A)
- **Track F** (Quick Actions): Session 9 (independent, but last before polish)

Sessions 1-2 must complete first (theme is the foundation).
Sessions 3, 4, 5, 6 can run in parallel after Session 2.
Sessions 7 and 8 can run in parallel after Session 2.
Session 9 can run anytime after Session 2.
Session 10 requires all other sessions to be complete.

---

## Notes

### Assumed Phase 3 Infrastructure
- Input area with mode toggle inside bordered container (blue build / violet plan)
- MarkdownRenderer component using react-markdown + remark-gfm
- Tool cards with left border status indicators
- Response logging with `--log` flag
- CodeBlock component with syntax highlighting and copy button
- Streaming text accumulation in SessionView
- Preload with typed IPC invoke/on pattern
- Settings modal with General, Editor, Terminal, Git, Shortcuts sections
- Session store with `modeBySession` map and `updateSessionName`

### Out of Scope (Phase 4)
Per PRD Phase 4, these are NOT included:
- Setup/Run/Terminal tab content (placeholder only — future phase)
- File editing in the file viewer (read-only only)
- Custom theme creation by users (presets only)
- Model cost display or token counting
- Multi-language detection per project (primary language only)
- Auto-update or version checking
- Plugin system

### Performance Targets
| Operation | Target |
|-----------|--------|
| Theme Switch | < 50ms, no flicker |
| Model List Load | < 1s from OpenCode SDK |
| Streaming Render Throttle | ~100ms interval, smooth feel |
| Tab Mode Toggle | < 50ms response |
| Language Detection | < 500ms per project |
| Session Naming (Haiku) | < 2s, non-blocking |
| File Viewer Open | < 200ms for files < 1MB |
| File Search | < 100ms per keystroke for files < 10K lines |
| Quick Action Execution | < 500ms to launch external app |
