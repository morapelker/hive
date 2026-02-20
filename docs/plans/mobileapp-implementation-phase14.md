# Phase 14 — Mobile Feature Screens (Sessions 131–139)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 14 builds all remaining screens for full feature parity with the desktop app: file tree browser, file viewer and editor, git changes panel with staging, diff viewer, simplified terminal, settings, and session history search.

At the end of this phase, the mobile app has all features needed for remote control of the Hive development environment.

## Prerequisites

- Phase 13 completed: core screens (projects, worktrees, sessions, modals) working.
- All stores from Phase 12 ported and functional.
- GraphQL subscriptions for file tree changes, git status changes, and terminal data working.

## Key Source Files (Read-Only Reference — Desktop Repo)

| File | Purpose |
|------|---------|
| `src/renderer/src/components/file-tree/FileTree.tsx` | Desktop file tree component |
| `src/renderer/src/components/file-viewer/FileViewer.tsx` | Desktop file viewer (Monaco) |
| `src/renderer/src/components/git/GitChanges.tsx` | Desktop git changes panel |
| `src/renderer/src/components/diff/DiffViewer.tsx` | Desktop diff viewer |
| `src/renderer/src/stores/useGitStore.ts` | Git state management |
| `src/renderer/src/stores/useFileTreeStore.ts` | File tree state management |
| `src/renderer/src/stores/useFileViewerStore.ts` | File viewer state management |

## Architecture Notes

### File Tree Rendering

The desktop app uses a recursive tree component. On mobile, we flatten the tree and use `FlashList` with indentation levels. This provides better performance and scroll behavior on mobile.

### File Viewer vs Editor

The desktop app uses Monaco Editor for both viewing and editing. On mobile:
- **Viewer**: Read-only syntax-highlighted text (using `react-native-code-editor` or custom component)
- **Editor**: Monospace `TextInput` with save button (simple editing, not a full IDE)

### Git Staging UX

On desktop, staging uses checkboxes and context menus. On mobile, we use swipe actions on file rows for stage/unstage/discard, which is more natural for touch interfaces.

### Simplified Terminal

The desktop app embeds a full terminal emulator (xterm.js / Ghostty). On mobile, we provide a simplified command runner: a TextInput for commands and a ScrollView for output. This is NOT a full terminal emulator — it's closer to running single commands via SSH.

---

## Session 131: File Tree Browser

**Goal:** Build the file tree browser screen with lazy child loading and search.

**Definition of Done:** File tree loads from server, directories expandable, files tappable to view, search works.

**Tasks:**

1. `[app]` Create `src/screens/FileTreeScreen.tsx`:
   ```tsx
   export function FileTreeScreen({ route, navigation }) {
     const { worktreePath } = route.params
     const { tree, loadTree, loadChildren, isLoading } = useFileTreeStore()
     const [searchQuery, setSearchQuery] = useState('')
     const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

     useEffect(() => {
       loadTree(worktreePath)
     }, [worktreePath])

     // Flatten tree for FlashList with indentation
     const flatItems = useMemo(() => {
       return flattenTree(tree, expandedDirs, searchQuery)
     }, [tree, expandedDirs, searchQuery])

     const handleToggleDir = async (dirPath: string) => {
       const newExpanded = new Set(expandedDirs)
       if (newExpanded.has(dirPath)) {
         newExpanded.delete(dirPath)
       } else {
         newExpanded.add(dirPath)
         await loadChildren(dirPath, worktreePath)
       }
       setExpandedDirs(newExpanded)
     }

     return (
       <View className="flex-1 bg-zinc-900">
         {/* Search bar */}
         <View className="p-3 bg-zinc-800 border-b border-zinc-700">
           <TextInput
             className="bg-zinc-700 text-white p-2 rounded-lg"
             placeholder="Search files..."
             placeholderTextColor="#71717a"
             value={searchQuery}
             onChangeText={setSearchQuery}
           />
         </View>

         <FlashList
           data={flatItems}
           renderItem={({ item }) => (
             <FileTreeRow
               item={item}
               onToggle={() => handleToggleDir(item.path)}
               onOpen={() => navigation.navigate('FileViewer', { filePath: item.path })}
             />
           )}
           estimatedItemSize={40}
           keyExtractor={item => item.path}
         />
       </View>
     )
   }
   ```

2. `[app]` Create `src/components/file-tree/FileTreeRow.tsx`:
   ```tsx
   export function FileTreeRow({ item, onToggle, onOpen }) {
     const indent = item.depth * 16

     return (
       <Pressable
         className="flex-row items-center py-2 px-3"
         style={{ paddingLeft: indent + 12 }}
         onPress={item.isDirectory ? onToggle : onOpen}
       >
         {item.isDirectory ? (
           <ChevronRight
             size={14}
             color="#71717a"
             style={{ transform: [{ rotate: item.expanded ? '90deg' : '0deg' }] }}
           />
         ) : (
           <FileIcon extension={item.extension} size={14} />
         )}
         <Text className={`ml-2 ${item.isDirectory ? 'text-zinc-300 font-medium' : 'text-zinc-400'}`}>
           {item.name}
         </Text>
         {item.gitStatus && <GitStatusDot status={item.gitStatus} />}
       </Pressable>
     )
   }
   ```

3. `[app]` Create helper `flattenTree()` that converts the nested tree to a flat array with depth info.

4. `[app]` Subscribe to `fileTreeChange` for real-time updates.

**Verification:**
```bash
npx expo start --ios
# Navigate to file tree → browse directories → tap file to open viewer
```

---

## Session 132: File Viewer

**Goal:** Build the read-only file viewer with syntax highlighting and line numbers.

**Definition of Done:** Files load from server, display with syntax highlighting and line numbers, horizontal scroll.

**Tasks:**

1. `[app]` Create `src/screens/FileViewerScreen.tsx`:
   ```tsx
   export function FileViewerScreen({ route }) {
     const { filePath } = route.params
     const { content, loadFile, isLoading } = useFileViewerStore()

     useEffect(() => {
       loadFile(filePath)
     }, [filePath])

     if (isLoading) return <LoadingSpinner />

     return (
       <View className="flex-1 bg-zinc-900">
         <View className="p-3 bg-zinc-800 border-b border-zinc-700">
           <Text className="text-zinc-400 text-sm font-mono" numberOfLines={1}>
             {filePath.split('/').pop()}
           </Text>
         </View>

         <ScrollView horizontal>
           <ScrollView>
             <SyntaxHighlightedCode
               content={content}
               language={getLanguageFromPath(filePath)}
               showLineNumbers
             />
           </ScrollView>
         </ScrollView>
       </View>
     )
   }
   ```

2. `[app]` Create `src/components/SyntaxHighlightedCode.tsx`:
   - Use a lightweight syntax highlighting library for React Native
   - Line numbers in a fixed-width left column
   - Monospace font throughout
   - Horizontal scrolling for long lines

3. `[app]` Create helper `getLanguageFromPath(filePath)` — maps file extension to language name.

**Verification:**
```bash
npx expo start --ios
# Open a .ts or .tsx file → syntax highlighted with line numbers
```

---

## Session 133: File Editor

**Goal:** Build a simple file editor for making quick edits on mobile.

**Definition of Done:** Can edit file content and save back to server.

**Tasks:**

1. `[app]` Create `src/screens/FileEditorScreen.tsx`:
   ```tsx
   export function FileEditorScreen({ route, navigation }) {
     const { filePath } = route.params
     const [content, setContent] = useState('')
     const [originalContent, setOriginalContent] = useState('')
     const [saving, setSaving] = useState(false)
     const hasChanges = content !== originalContent

     useEffect(() => {
       loadFileContent()
     }, [filePath])

     const loadFileContent = async () => {
       const result = await transport.fileOps.read(filePath)
       if (result.success) {
         setContent(result.content)
         setOriginalContent(result.content)
       }
     }

     const handleSave = async () => {
       setSaving(true)
       const result = await transport.fileOps.write(filePath, content)
       setSaving(false)
       if (result.success) {
         setOriginalContent(content)
         Toast.show({ type: 'success', text1: 'File saved' })
       } else {
         Toast.show({ type: 'error', text1: 'Save failed', text2: result.error })
       }
     }

     return (
       <View className="flex-1 bg-zinc-900">
         <View className="flex-row items-center justify-between p-3 bg-zinc-800 border-b border-zinc-700">
           <Text className="text-zinc-400 text-sm font-mono flex-1" numberOfLines={1}>
             {filePath.split('/').pop()}
           </Text>
           <Pressable
             className={`px-4 py-2 rounded-lg ${hasChanges ? 'bg-blue-600' : 'bg-zinc-700'}`}
             onPress={handleSave}
             disabled={!hasChanges || saving}
           >
             <Text className="text-white font-semibold">
               {saving ? 'Saving...' : 'Save'}
             </Text>
           </Pressable>
         </View>

         <TextInput
           className="flex-1 text-white font-mono text-sm p-3"
           style={{ textAlignVertical: 'top' }}
           value={content}
           onChangeText={setContent}
           multiline
           autoCapitalize="none"
           autoCorrect={false}
           spellCheck={false}
         />
       </View>
     )
   }
   ```

2. `[app]` Warn before leaving if there are unsaved changes.

3. `[app]` Add undo/redo support using a simple history stack.

**Verification:**
```bash
npx expo start --ios
# Open file in editor → make changes → save → verify changes persisted
```

---

## Session 134: Git Changes Panel

**Goal:** Build the git changes panel showing staged/unstaged files with swipe actions.

**Definition of Done:** Files grouped by staged/unstaged, swipe to stage/unstage/discard, pull-to-refresh.

**Tasks:**

1. `[app]` Create `src/screens/GitChangesScreen.tsx`:
   ```tsx
   export function GitChangesScreen({ route }) {
     const { worktreePath } = route.params
     const { fileStatuses, loadStatuses } = useGitStore()
     const [refreshing, setRefreshing] = useState(false)

     useEffect(() => {
       loadStatuses(worktreePath)
     }, [worktreePath])

     // Subscribe to git status changes for real-time updates
     useGitStatusSubscription(worktreePath)

     const stagedFiles = fileStatuses.filter(f => f.staged)
     const unstagedFiles = fileStatuses.filter(f => !f.staged)

     return (
       <SectionList
         sections={[
           { title: `Staged (${stagedFiles.length})`, data: stagedFiles },
           { title: `Changes (${unstagedFiles.length})`, data: unstagedFiles }
         ]}
         renderSectionHeader={({ section }) => (
           <View className="px-4 py-2 bg-zinc-800">
             <Text className="text-zinc-400 font-medium text-sm">{section.title}</Text>
           </View>
         )}
         renderItem={({ item }) => (
           <GitFileRow
             file={item}
             worktreePath={worktreePath}
             onPress={() => navigateToDiff(item)}
           />
         )}
         refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
         ListHeaderComponent={<BranchInfoHeader worktreePath={worktreePath} />}
       />
     )
   }
   ```

2. `[app]` Create `src/components/git/GitFileRow.tsx` with swipe actions:
   ```tsx
   import { Swipeable } from 'react-native-gesture-handler'

   export function GitFileRow({ file, worktreePath, onPress }) {
     const renderRightActions = () => (
       <View className="flex-row">
         {file.staged ? (
           <SwipeAction label="Unstage" color="#f59e0b"
             onPress={() => useGitStore.getState().unstageFile(worktreePath, file.path)} />
         ) : (
           <>
             <SwipeAction label="Stage" color="#22c55e"
               onPress={() => useGitStore.getState().stageFile(worktreePath, file.path)} />
             <SwipeAction label="Discard" color="#ef4444"
               onPress={() => confirmDiscard(worktreePath, file.path)} />
           </>
         )}
       </View>
     )

     return (
       <Swipeable renderRightActions={renderRightActions}>
         <Pressable className="flex-row items-center px-4 py-3 bg-zinc-900" onPress={onPress}>
           <GitStatusIcon status={file.status} />
           <Text className="text-zinc-300 ml-2 flex-1" numberOfLines={1}>
             {file.relativePath}
           </Text>
         </Pressable>
       </Swipeable>
     )
   }
   ```

3. `[app]` Create `src/components/git/BranchInfoHeader.tsx`:
   - Shows current branch, tracking, ahead/behind counts
   - Stage All / Unstage All buttons

**Verification:**
```bash
npx expo start --ios
# View git changes → swipe file to stage → swipe staged file to unstage
```

---

## Session 135: Git Commit & Push

**Goal:** Build the commit form and push/pull functionality.

**Definition of Done:** Can write commit message, commit, push, pull. Ahead/behind counts visible.

**Tasks:**

1. `[app]` Create `src/components/git/CommitForm.tsx`:
   ```tsx
   export function CommitForm({ worktreePath }) {
     const [message, setMessage] = useState('')
     const [committing, setCommitting] = useState(false)
     const stagedCount = useGitStore(s => s.fileStatuses.filter(f => f.staged).length)

     const handleCommit = async () => {
       if (!message.trim() || stagedCount === 0) return
       setCommitting(true)
       const result = await useGitStore.getState().commit(worktreePath, message)
       setCommitting(false)
       if (result.success) {
         setMessage('')
         Toast.show({ type: 'success', text1: `Committed: ${result.commitHash?.slice(0, 7)}` })
       } else {
         Toast.show({ type: 'error', text1: 'Commit failed', text2: result.error })
       }
     }

     return (
       <View className="p-4 bg-zinc-800 border-t border-zinc-700">
         <TextInput
           className="bg-zinc-700 text-white p-3 rounded-lg mb-3"
           placeholder="Commit message..."
           placeholderTextColor="#71717a"
           value={message}
           onChangeText={setMessage}
           multiline
         />
         <View className="flex-row">
           <Pressable
             className={`flex-1 rounded-lg p-3 mr-2 ${stagedCount > 0 && message.trim() ? 'bg-green-600' : 'bg-zinc-700'}`}
             onPress={handleCommit}
             disabled={!message.trim() || stagedCount === 0 || committing}
           >
             <Text className="text-white text-center font-semibold">
               {committing ? 'Committing...' : `Commit (${stagedCount})`}
             </Text>
           </Pressable>
         </View>
       </View>
     )
   }
   ```

2. `[app]` Create push/pull buttons in `BranchInfoHeader`:
   ```tsx
   <View className="flex-row mt-2">
     <Pressable className="bg-blue-600 rounded-lg px-4 py-2 mr-2" onPress={handlePush}>
       <Text className="text-white">Push {ahead > 0 ? `(${ahead})` : ''}</Text>
     </Pressable>
     <Pressable className="bg-zinc-700 rounded-lg px-4 py-2" onPress={handlePull}>
       <Text className="text-white">Pull {behind > 0 ? `(${behind})` : ''}</Text>
     </Pressable>
   </View>
   ```

3. `[app]` Handle push/pull errors with toast notifications.

**Verification:**
```bash
npx expo start --ios
# Stage files → write commit message → commit → push
```

---

## Session 136: Diff Viewer

**Goal:** Build the diff viewer with unified diff display and hunk staging.

**Definition of Done:** Diffs render with green/red line coloring, hunk staging buttons.

**Tasks:**

1. `[app]` Create `src/screens/DiffViewerScreen.tsx`:
   ```tsx
   export function DiffViewerScreen({ route }) {
     const { filePath, worktreePath, staged } = route.params
     const [diff, setDiff] = useState('')
     const [loading, setLoading] = useState(true)

     useEffect(() => {
       loadDiff()
     }, [filePath])

     const loadDiff = async () => {
       setLoading(true)
       const result = await transport.gitOps.getDiff({
         worktreePath, filePath, staged: staged || false, isUntracked: false
       })
       if (result.success) setDiff(result.diff)
       setLoading(false)
     }

     const hunks = parseDiff(diff)

     return (
       <ScrollView className="flex-1 bg-zinc-900">
         {hunks.map((hunk, i) => (
           <View key={i}>
             <View className="flex-row items-center justify-between px-3 py-1 bg-zinc-800">
               <Text className="text-zinc-500 text-xs font-mono">{hunk.header}</Text>
               {!staged && (
                 <Pressable className="bg-green-700 px-2 py-1 rounded"
                   onPress={() => stageHunk(worktreePath, hunk.patch)}>
                   <Text className="text-white text-xs">Stage Hunk</Text>
                 </Pressable>
               )}
             </View>
             {hunk.lines.map((line, j) => (
               <DiffLine key={j} line={line} />
             ))}
           </View>
         ))}
       </ScrollView>
     )
   }

   function DiffLine({ line }) {
     const bgColor = line.type === 'add' ? 'bg-green-900/30'
       : line.type === 'remove' ? 'bg-red-900/30' : ''

     return (
       <View className={`flex-row px-3 py-0.5 ${bgColor}`}>
         <Text className="text-zinc-600 text-xs font-mono w-10 text-right mr-2">
           {line.lineNumber || ''}
         </Text>
         <Text className={`text-xs font-mono flex-1 ${
           line.type === 'add' ? 'text-green-400'
           : line.type === 'remove' ? 'text-red-400'
           : 'text-zinc-400'
         }`}>
           {line.content}
         </Text>
       </View>
     )
   }
   ```

2. `[app]` Create `parseDiff(diffString)` helper:
   - Parse unified diff format into hunks
   - Each hunk has header, lines, and raw patch string (for hunk staging)

3. `[app]` Hunk staging calls `gitStageHunk` mutation with the hunk's patch string.

**Verification:**
```bash
npx expo start --ios
# View diff → green/red lines visible → stage hunk button works
```

---

## Session 137: Simplified Terminal

**Goal:** Build a simple command runner (not a full terminal emulator).

**Definition of Done:** Can type commands, run them, see output in a scrollable view.

**Tasks:**

1. `[app]` Create `src/screens/TerminalScreen.tsx`:
   ```tsx
   export function TerminalScreen({ route }) {
     const { worktreeId } = route.params
     const [command, setCommand] = useState('')
     const [output, setOutput] = useState('')
     const [running, setRunning] = useState(false)
     const scrollRef = useRef<ScrollView>(null)
     const worktree = useWorktreeStore(s => s.getWorktree(worktreeId))

     // Subscribe to terminal data
     const { data } = useSubscription(TERMINAL_DATA_SUBSCRIPTION, {
       variables: { worktreeId },
       onData: ({ data }) => {
         if (data.data?.terminalData) {
           setOutput(prev => prev + data.data.terminalData.data)
           scrollRef.current?.scrollToEnd({ animated: true })
         }
       }
     })

     const handleRun = async () => {
       if (!command.trim()) return
       setOutput(prev => prev + `\n$ ${command}\n`)
       setRunning(true)

       // Create terminal if not exists, then write command
       await transport.terminalOps.create(worktreeId, worktree.path)
       await transport.terminalOps.write(worktreeId, command + '\n')
       setCommand('')
     }

     return (
       <View className="flex-1 bg-black">
         <ScrollView ref={scrollRef} className="flex-1 p-3">
           <Text className="text-green-400 font-mono text-sm">{output}</Text>
         </ScrollView>

         <View className="flex-row items-center p-3 border-t border-zinc-800">
           <Text className="text-green-400 font-mono mr-2">$</Text>
           <TextInput
             className="flex-1 text-white font-mono p-2 bg-zinc-900 rounded"
             value={command}
             onChangeText={setCommand}
             placeholder="Enter command..."
             placeholderTextColor="#4a5568"
             autoCapitalize="none"
             autoCorrect={false}
             returnKeyType="send"
             onSubmitEditing={handleRun}
           />
           <Pressable className="ml-2 bg-green-700 rounded px-3 py-2" onPress={handleRun}>
             <Text className="text-white font-mono">Run</Text>
           </Pressable>
         </View>
       </View>
     )
   }
   ```

2. `[app]` Keep command history in state (up/down arrows on hardware keyboard).

3. `[app]` Clean up terminal on unmount:
   ```typescript
   useEffect(() => {
     return () => {
       transport.terminalOps.destroy(worktreeId)
     }
   }, [])
   ```

**Verification:**
```bash
npx expo start --ios
# Navigate to terminal → type "ls" → see output
```

---

## Session 138: Settings Screen

**Goal:** Build the settings screen with connection, AI model, and appearance settings.

**Definition of Done:** Settings load from server, editable, persist on save.

**Tasks:**

1. `[app]` Create `src/screens/SettingsScreen.tsx`:
   ```tsx
   export function SettingsScreen() {
     return (
       <ScrollView className="flex-1 bg-zinc-900">
         <SettingsSection title="Connection">
           <SettingsRow label="Server" value={serverUrl} onPress={editConnection} />
           <SettingsRow label="Status" value={connectionState} />
           <SettingsRow label="Disconnect" destructive onPress={disconnect} />
         </SettingsSection>

         <SettingsSection title="AI">
           <SettingsRow label="Default Model" value={defaultModel} onPress={selectModel} />
           <SettingsRow label="Agent SDK" value={agentSdk} onPress={selectSdk} />
         </SettingsSection>

         <SettingsSection title="Appearance">
           <SettingsRow label="Theme" value="Dark" />
         </SettingsSection>

         <SettingsSection title="About">
           <SettingsRow label="Server Version" value={serverVersion} />
           <SettingsRow label="App Version" value={appVersion} />
         </SettingsSection>
       </ScrollView>
     )
   }
   ```

2. `[app]` Create `src/components/settings/SettingsSection.tsx` and `SettingsRow.tsx`.

3. `[app]` Load settings from `useSettingsStore`.

4. `[app]` "Disconnect" action calls `useConnectionManagerStore.getState().clearCredentials()` and navigates to pairing screen.

**Verification:**
```bash
npx expo start --ios
# Navigate to More → Settings → view and modify settings
```

---

## Session 139: Session History Search

**Goal:** Build a search screen for finding sessions across all projects and worktrees.

**Definition of Done:** Can search sessions by keyword, filter by project/date, navigate to session view.

**Tasks:**

1. `[app]` Create `src/screens/SessionHistoryScreen.tsx`:
   ```tsx
   export function SessionHistoryScreen({ navigation }) {
     const [keyword, setKeyword] = useState('')
     const [results, setResults] = useState([])
     const [loading, setLoading] = useState(false)

     const handleSearch = async () => {
       if (!keyword.trim()) return
       setLoading(true)
       const sessions = await transport.db.session.search({ keyword })
       setResults(sessions)
       setLoading(false)
     }

     return (
       <View className="flex-1 bg-zinc-900">
         <View className="p-3 bg-zinc-800 border-b border-zinc-700 flex-row">
           <TextInput
             className="flex-1 bg-zinc-700 text-white p-2 rounded-lg mr-2"
             placeholder="Search sessions..."
             placeholderTextColor="#71717a"
             value={keyword}
             onChangeText={setKeyword}
             returnKeyType="search"
             onSubmitEditing={handleSearch}
           />
           <Pressable className="bg-blue-600 rounded-lg px-4 justify-center" onPress={handleSearch}>
             <Search size={18} color="white" />
           </Pressable>
         </View>

         <FlashList
           data={results}
           renderItem={({ item }) => (
             <SessionHistoryRow
               session={item}
               onPress={() => navigation.navigate('SessionView', {
                 sessionId: item.id,
                 worktreeId: item.worktree_id
               })}
             />
           )}
           estimatedItemSize={60}
           ListEmptyComponent={
             keyword ? <Text className="text-zinc-500 text-center p-4">No results</Text> : null
           }
         />
       </View>
     )
   }
   ```

2. `[app]` `SessionHistoryRow` shows: session name, project name, worktree branch, date, model used.

3. `[app]` Support filtering by project, date range (future enhancement).

**Verification:**
```bash
npx expo start --ios
# Search for a keyword → see matching sessions → tap to navigate
```

---

## Summary of Files Created

```
src/screens/
  FileTreeScreen.tsx                — File tree browser with lazy loading
  FileViewerScreen.tsx              — Read-only syntax-highlighted viewer
  FileEditorScreen.tsx              — Simple text editor with save
  GitChangesScreen.tsx              — Staged/unstaged file list with swipe actions
  DiffViewerScreen.tsx              — Unified diff viewer with hunk staging
  TerminalScreen.tsx                — Simplified command runner
  SettingsScreen.tsx                — App settings
  SessionHistoryScreen.tsx          — Session search across projects

src/components/
  SyntaxHighlightedCode.tsx         — Syntax highlighting component
  file-tree/
    FileTreeRow.tsx                 — File/directory row with indent
    FileIcon.tsx                    — Extension → icon mapping
    GitStatusDot.tsx                — Colored dot for git status
  git/
    GitFileRow.tsx                  — Swipeable file row
    GitStatusIcon.tsx               — Status code → icon
    BranchInfoHeader.tsx            — Branch name, ahead/behind, push/pull
    CommitForm.tsx                  — Commit message + submit
  settings/
    SettingsSection.tsx             — Settings group header
    SettingsRow.tsx                 — Settings row with label/value
  SessionHistoryRow.tsx             — Session search result row
```

## What Comes Next

Phase 15 (Mobile Polish, Sessions 140-144) adds push notifications, deep linking, actionable notifications, offline/reconnection handling, and performance optimization.
