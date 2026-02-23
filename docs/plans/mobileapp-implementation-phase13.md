# Phase 13 — Mobile Core Screens (Sessions 121–130)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 13 builds the essential mobile screens needed for the core user experience: browsing projects/worktrees, viewing and interacting with AI sessions (the most complex screen), and handling AI interaction modals (permissions, questions, plans). These are the minimum viable screens for remote AI session control.

At the end of this phase, users can browse their projects, start AI sessions, see streaming responses, approve permissions, answer questions, and approve/reject plans — all from their phone.

## Prerequisites

- Phase 11 completed: React Native app with navigation, Apollo Client, transport.
- Phase 12 completed: All Zustand stores ported and working with GraphQL transport.
- `useStreamSubscription` hook wired up for real-time events.
- All GraphQL operations defined and codegen run.

## Key Source Files (Read-Only Reference — Desktop Repo)

| File | Purpose |
|------|---------|
| `src/renderer/src/components/projects/ProjectListItem.tsx` | Project row rendering |
| `src/renderer/src/components/worktrees/WorktreeListItem.tsx` | Worktree row rendering |
| `src/renderer/src/components/sessions/SessionView.tsx` | The main session view (~500 lines) |
| `src/renderer/src/components/sessions/MessageList.tsx` | Message list rendering |
| `src/renderer/src/components/sessions/InputArea.tsx` | User input area |
| `src/renderer/src/components/sessions/ToolCard.tsx` | Tool invocation card |
| `src/renderer/src/components/sessions/PermissionBanner.tsx` | Permission request UI |
| `src/renderer/src/components/sessions/QuestionBanner.tsx` | Question prompt UI |
| `src/renderer/src/components/sessions/PlanApproval.tsx` | Plan approval UI |
| `src/renderer/src/stores/useSessionStore.ts` | Session state management |
| `src/renderer/src/stores/useWorktreeStatusStore.ts` | Status badge logic |

## Architecture Notes

### FlashList for Performance

Message lists use `@shopify/flash-list` instead of `FlatList` for significantly better performance with large message lists. FlashList recycles views and provides consistent 60fps scrolling.

### Streaming Rendering Strategy

During AI streaming, messages update 10-50 times per second. To maintain 60fps:
1. Store the latest message content in a mutable ref (not state)
2. Use `requestAnimationFrame` or a 30fps throttle to batch renders
3. Only the last message in the list re-renders during streaming
4. Markdown rendering is deferred to after streaming completes (show raw text while streaming)

### Bottom Sheet Pattern

Permission requests, questions, and model selection use `@gorhom/bottom-sheet` for modal presentations. This provides a native iOS/Android feel with swipe-to-dismiss.

---

## Session 121: Project Browser Screen

**Goal:** Build the main project/worktree browsing screen.

**Definition of Done:** Projects load from server, worktrees shown under each project, tapping navigates to worktree detail.

**Tasks:**

1. `[app]` Install dependencies:
   ```bash
   pnpm add @shopify/flash-list lucide-react-native
   ```

2. `[app]` Create `src/screens/ProjectBrowserScreen.tsx`:
   ```tsx
   import { SectionList, View, Text, Pressable, RefreshControl } from 'react-native'
   import { useProjectStore } from '../stores/useProjectStore'
   import { useWorktreeStore } from '../stores/useWorktreeStore'
   import { useWorktreeStatusStore } from '../stores/useWorktreeStatusStore'

   export function ProjectBrowserScreen({ navigation }) {
     const { projects, loadProjects } = useProjectStore()
     const { worktreesByProject, loadWorktreesForProject } = useWorktreeStore()
     const [refreshing, setRefreshing] = useState(false)

     useEffect(() => {
       loadProjects()
     }, [])

     const sections = projects.map(project => ({
       title: project.name,
       data: worktreesByProject[project.id] || [],
       project
     }))

     const renderWorktreeItem = ({ item: worktree }) => {
       const status = useWorktreeStatusStore.getState().getStatus(worktree.id)
       return (
         <Pressable
           className="flex-row items-center px-4 py-3 bg-zinc-800 border-b border-zinc-700"
           onPress={() => navigation.navigate('WorktreeDetail', { worktreeId: worktree.id })}
         >
           <View className="flex-1">
             <Text className="text-white font-medium">{worktree.name}</Text>
             <Text className="text-zinc-400 text-sm">{worktree.branch_name}</Text>
           </View>
           {status && <StatusBadge status={status} />}
         </Pressable>
       )
     }

     return (
       <SectionList
         sections={sections}
         renderItem={renderWorktreeItem}
         renderSectionHeader={({ section }) => (
           <View className="px-4 py-2 bg-zinc-900 flex-row items-center">
             <ProjectIcon project={section.project} />
             <Text className="text-zinc-300 font-semibold ml-2">{section.title}</Text>
           </View>
         )}
         refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
         keyExtractor={item => item.id}
       />
     )
   }
   ```

3. `[app]` Create `src/components/StatusBadge.tsx`:
   - Maps status to colored badge: `working` (blue), `completed` (green), `error` (red), `permission` (orange), `plan_ready` (purple), `question` (yellow)

4. `[app]` Create `src/components/ProjectIcon.tsx`:
   - Shows language icon or custom icon for each project

5. `[app]` Wire into `ProjectsStack` navigator.

**Verification:**
```bash
npx expo start --ios
# Projects and worktrees load from server
# Tapping a worktree navigates to detail
```

---

## Session 122: Worktree Detail Screen

**Goal:** Build the worktree detail screen showing branch info, status, and session list.

**Definition of Done:** Shows worktree metadata, branch info, list of sessions, can navigate to session view.

**Tasks:**

1. `[app]` Create `src/screens/WorktreeDetailScreen.tsx`:
   ```tsx
   export function WorktreeDetailScreen({ route, navigation }) {
     const { worktreeId } = route.params
     const worktree = useWorktreeStore(s => s.getWorktree(worktreeId))
     const sessions = useSessionStore(s => s.getSessionsByWorktree(worktreeId))
     const branchInfo = useGitStore(s => s.branchInfo[worktree?.path])

     useEffect(() => {
       if (worktree?.path) {
         useGitStore.getState().loadBranchInfo(worktree.path)
       }
     }, [worktree?.path])

     return (
       <View className="flex-1 bg-zinc-900">
         {/* Header with branch info */}
         <View className="p-4 bg-zinc-800 border-b border-zinc-700">
           <Text className="text-white text-xl font-bold">{worktree?.name}</Text>
           <Text className="text-zinc-400 mt-1">{worktree?.branch_name}</Text>
           {branchInfo && (
             <View className="flex-row mt-2">
               {branchInfo.ahead > 0 && (
                 <Text className="text-green-400 text-sm mr-3">↑{branchInfo.ahead}</Text>
               )}
               {branchInfo.behind > 0 && (
                 <Text className="text-red-400 text-sm">↓{branchInfo.behind}</Text>
               )}
             </View>
           )}
         </View>

         {/* Session list */}
         <FlashList
           data={sessions}
           renderItem={({ item }) => (
             <SessionListItem
               session={item}
               onPress={() => navigation.navigate('SessionView', {
                 sessionId: item.id,
                 worktreeId
               })}
             />
           )}
           estimatedItemSize={60}
           ListEmptyComponent={<EmptySessionsMessage />}
         />

         {/* New session button */}
         <Pressable
           className="mx-4 mb-4 p-4 bg-blue-600 rounded-xl"
           onPress={handleNewSession}
         >
           <Text className="text-white text-center font-semibold">New Session</Text>
         </Pressable>
       </View>
     )
   }
   ```

2. `[app]` Create `src/components/SessionListItem.tsx`:
   - Shows session name, status, model, last message preview
   - Status color indicator

3. `[app]` Implement `handleNewSession` — creates session via store, navigates to session view.

**Verification:**
```bash
npx expo start --ios
# Navigate to worktree → see sessions → tap to open
```

---

## Session 123: Session View — Message List

**Goal:** Build the message list component that renders user and assistant messages.

**Definition of Done:** Messages render with proper styling, markdown renders for assistant messages, scrolls to bottom on new messages.

**Tasks:**

1. `[app]` Install dependencies:
   ```bash
   pnpm add react-native-markdown-display @gorhom/bottom-sheet
   ```

2. `[app]` Create `src/components/sessions/MessageList.tsx`:
   ```tsx
   import { FlashList } from '@shopify/flash-list'
   import Markdown from 'react-native-markdown-display'

   export function MessageList({ messages, isStreaming }) {
     const listRef = useRef<FlashList>(null)

     // Auto-scroll to bottom on new messages
     useEffect(() => {
       if (messages.length > 0) {
         listRef.current?.scrollToEnd({ animated: true })
       }
     }, [messages.length])

     return (
       <FlashList
         ref={listRef}
         data={messages}
         renderItem={({ item }) => <MessageBubble message={item} />}
         estimatedItemSize={100}
         inverted={false}
         keyExtractor={item => item.id}
       />
     )
   }

   function MessageBubble({ message }) {
     const isUser = message.role === 'user'

     return (
       <View className={`px-4 py-3 ${isUser ? 'bg-zinc-800' : 'bg-zinc-900'}`}>
         <Text className={`text-xs font-medium mb-1 ${isUser ? 'text-blue-400' : 'text-green-400'}`}>
           {isUser ? 'You' : 'Assistant'}
         </Text>
         {isUser ? (
           <Text className="text-white">{message.content}</Text>
         ) : (
           <Markdown style={markdownStyles}>{message.content}</Markdown>
         )}
         {message.toolCalls?.map(tool => (
           <ToolCard key={tool.id} tool={tool} />
         ))}
       </View>
     )
   }
   ```

3. `[app]` Create markdown styles that match Hive's dark theme:
   ```typescript
   const markdownStyles = {
     body: { color: '#e4e4e7' },
     heading1: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
     code_inline: { backgroundColor: '#27272a', color: '#a1a1aa', padding: 2 },
     code_block: { backgroundColor: '#18181b', padding: 12, borderRadius: 8 },
     link: { color: '#60a5fa' },
   }
   ```

4. `[app]` Handle message types: text, tool calls, subtask references, reasoning blocks.

**Verification:**
```bash
npx expo start --ios
# Open a session with existing messages → messages render with markdown
```

---

## Session 124: Session View — Input Area

**Goal:** Build the input area for sending prompts.

**Definition of Done:** Can type messages, send prompts, abort running sessions, switch modes.

**Tasks:**

1. `[app]` Create `src/components/sessions/InputArea.tsx`:
   ```tsx
   export function InputArea({ sessionId, worktreePath, isStreaming }) {
     const [text, setText] = useState('')
     const { prompt, abort } = useSessionStore()

     const handleSend = async () => {
       if (!text.trim()) return
       const message = text
       setText('')
       await prompt(worktreePath, sessionId, message)
     }

     const handleAbort = async () => {
       await abort(worktreePath, sessionId)
     }

     return (
       <View className="border-t border-zinc-700 bg-zinc-800 p-3">
         {/* Mode chip */}
         <View className="flex-row mb-2">
           <ModeChip sessionId={sessionId} />
         </View>

         {/* Input row */}
         <View className="flex-row items-end">
           <TextInput
             className="flex-1 bg-zinc-700 text-white p-3 rounded-xl max-h-32"
             placeholder="Send a message..."
             placeholderTextColor="#71717a"
             value={text}
             onChangeText={setText}
             multiline
             textAlignVertical="top"
             editable={!isStreaming}
           />
           {isStreaming ? (
             <Pressable className="ml-2 p-3 bg-red-600 rounded-xl" onPress={handleAbort}>
               <Square size={20} color="white" />
             </Pressable>
           ) : (
             <Pressable
               className={`ml-2 p-3 rounded-xl ${text.trim() ? 'bg-blue-600' : 'bg-zinc-700'}`}
               onPress={handleSend}
               disabled={!text.trim()}
             >
               <Send size={20} color="white" />
             </Pressable>
           )}
         </View>
       </View>
     )
   }
   ```

2. `[app]` Create `src/components/sessions/ModeChip.tsx`:
   - Toggle between `build` and `plan` mode
   - Shows current mode as a colored chip

3. `[app]` Handle keyboard avoidance (KeyboardAvoidingView or keyboard-aware scroll).

**Verification:**
```bash
npx expo start --ios
# Type message → send → see it appear in message list
# During streaming → abort button works
```

---

## Session 125: Session View — Streaming

**Goal:** Integrate `opencodeStream` subscription for real-time streaming in the session view.

**Definition of Done:** Sending a prompt shows streaming response in real-time at 30fps.

**Tasks:**

1. `[app]` Create `src/screens/SessionViewScreen.tsx` — the main session screen:
   ```tsx
   export function SessionViewScreen({ route }) {
     const { sessionId, worktreeId } = route.params
     const session = useSessionStore(s => s.getSession(sessionId))
     const messages = useSessionStore(s => s.getMessages(sessionId))
     const isStreaming = useSessionStore(s => s.isStreaming(sessionId))
     const worktree = useWorktreeStore(s => s.getWorktree(worktreeId))

     // Subscribe to stream events for this session
     useStreamSubscription([session?.opencodeSessionId].filter(Boolean))

     // Load existing messages on mount
     useEffect(() => {
       if (worktree?.path && session?.opencodeSessionId) {
         useSessionStore.getState().loadMessages(worktree.path, session.opencodeSessionId)
       }
     }, [])

     return (
       <View className="flex-1 bg-zinc-900">
         <SessionHeader session={session} worktree={worktree} />
         <MessageList messages={messages} isStreaming={isStreaming} />
         <PermissionBanner sessionId={sessionId} />
         <QuestionBanner sessionId={sessionId} />
         <InputArea
           sessionId={sessionId}
           worktreePath={worktree?.path}
           isStreaming={isStreaming}
         />
       </View>
     )
   }
   ```

2. `[app]` Implement 30fps render throttling for streaming:
   ```typescript
   // In stream event handler, throttle message.updated events
   const lastRender = useRef(0)
   const pendingContent = useRef('')

   function handleMessageUpdated(sessionId, data) {
     pendingContent.current = data.content
     const now = Date.now()
     if (now - lastRender.current > 33) { // ~30fps
       lastRender.current = now
       // Update state (triggers render)
       updateMessageContent(sessionId, pendingContent.current)
     }
   }
   ```

3. `[app]` Create `src/components/sessions/SessionHeader.tsx`:
   - Session name (editable), model name, context usage bar, mode indicator

4. `[app]` Connect and load messages when entering the screen.

**Verification:**
```bash
npx expo start --ios
# Send a prompt → see streaming response appear in real-time
# Smooth scrolling during streaming
```

---

## Session 126: Session View — Tool Cards

**Goal:** Build tool invocation cards that show within assistant messages.

**Definition of Done:** Tool calls display as collapsed cards, expandable to show details.

**Tasks:**

1. `[app]` Create `src/components/sessions/ToolCard.tsx`:
   ```tsx
   export function ToolCard({ tool }) {
     const [expanded, setExpanded] = useState(false)

     return (
       <Pressable
         className="my-1 bg-zinc-800 rounded-lg border border-zinc-700"
         onPress={() => setExpanded(!expanded)}
       >
         <View className="flex-row items-center p-3">
           <ToolIcon name={tool.name} />
           <View className="flex-1 ml-2">
             <Text className="text-zinc-300 font-medium text-sm">{tool.name}</Text>
             {tool.status === 'running' && <ActivityIndicator size="small" />}
             {tool.status === 'completed' && <Check size={14} color="#22c55e" />}
             {tool.status === 'error' && <X size={14} color="#ef4444" />}
           </View>
           <ChevronDown size={16} color="#71717a"
             style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}
           />
         </View>

         {expanded && (
           <View className="px-3 pb-3 border-t border-zinc-700">
             {tool.input && (
               <View className="mt-2">
                 <Text className="text-zinc-500 text-xs mb-1">Input</Text>
                 <Text className="text-zinc-400 text-xs font-mono">{formatToolInput(tool.input)}</Text>
               </View>
             )}
             {tool.output && (
               <View className="mt-2">
                 <Text className="text-zinc-500 text-xs mb-1">Output</Text>
                 <Text className="text-zinc-300 text-xs font-mono" numberOfLines={expanded ? undefined : 3}>
                   {tool.output}
                 </Text>
               </View>
             )}
           </View>
         )}
       </Pressable>
     )
   }
   ```

2. `[app]` Create `src/components/sessions/ToolIcon.tsx`:
   - Map tool names to icons: `file_read` → FileText, `file_write` → FilePen, `bash` → Terminal, `grep` → Search, etc.

3. `[app]` Tool cards are collapsed by default. Only expand on tap. This keeps the message list compact during active sessions.

**Verification:**
```bash
npx expo start --ios
# Session with tool calls → collapsed cards visible
# Tap card → expands to show input/output
```

---

## Session 127: Permission Modal

**Goal:** Build the permission request modal that appears when AI needs tool approval.

**Definition of Done:** Permission requests show as a sticky banner above input, with Allow/Deny buttons.

**Tasks:**

1. `[app]` Create `src/components/sessions/PermissionBanner.tsx`:
   ```tsx
   export function PermissionBanner({ sessionId }) {
     const permission = usePermissionStore(s => s.getForSession(sessionId))
     const { reply } = useSessionStore()

     if (!permission) return null

     return (
       <View className="bg-orange-900/50 border-t border-orange-700 p-4">
         <Text className="text-orange-200 font-medium mb-1">Permission Required</Text>
         <Text className="text-orange-100 text-sm mb-1">{permission.permission}</Text>
         {permission.tool && (
           <Text className="text-orange-300 text-xs mb-2">Tool: {permission.tool}</Text>
         )}
         {permission.patterns?.length > 0 && (
           <Text className="text-orange-300 text-xs mb-2 font-mono">
             {permission.patterns.join(', ')}
           </Text>
         )}

         <View className="flex-row mt-2">
           <Pressable
             className="flex-1 bg-green-600 rounded-lg p-3 mr-2"
             onPress={() => reply(permission.id, 'once')}
           >
             <Text className="text-white text-center font-semibold">Allow Once</Text>
           </Pressable>
           <Pressable
             className="flex-1 bg-green-700 rounded-lg p-3 mr-2"
             onPress={() => reply(permission.id, 'always')}
           >
             <Text className="text-white text-center font-semibold">Always</Text>
           </Pressable>
           <Pressable
             className="flex-1 bg-red-600 rounded-lg p-3"
             onPress={() => reply(permission.id, 'reject')}
           >
             <Text className="text-white text-center font-semibold">Deny</Text>
           </Pressable>
         </View>
       </View>
     )
   }
   ```

2. `[app]` Position the banner between the message list and input area (sticky).

3. `[app]` After replying, the banner dismisses (permission removed from store by stream event handler).

**Verification:**
```bash
npx expo start --ios
# AI requests permission → banner appears → tap Allow → banner dismisses → AI continues
```

---

## Session 128: Question Modal

**Goal:** Build the question prompt modal for when AI asks the user a question.

**Definition of Done:** Questions show as a bottom sheet with answer options.

**Tasks:**

1. `[app]` Create `src/components/sessions/QuestionBanner.tsx`:
   ```tsx
   export function QuestionBanner({ sessionId }) {
     const question = useQuestionStore(s => s.getForSession(sessionId))

     if (!question) return null

     return (
       <View className="bg-yellow-900/50 border-t border-yellow-700 p-4">
         <Text className="text-yellow-200 font-medium mb-2">{question.prompt}</Text>

         {question.options?.map((option, i) => (
           <Pressable
             key={i}
             className="bg-yellow-700/50 rounded-lg p-3 mb-2"
             onPress={() => handleAnswer(question.id, [option])}
           >
             <Text className="text-yellow-100">{option}</Text>
           </Pressable>
         ))}

         <Pressable
           className="bg-zinc-700 rounded-lg p-3 mt-1"
           onPress={() => handleReject(question.id)}
         >
           <Text className="text-zinc-300 text-center">Skip</Text>
         </Pressable>
       </View>
     )
   }
   ```

2. `[app]` For questions with free-text answers, show a TextInput + Submit button instead of option chips.

3. `[app]` Handle multi-select questions (where applicable).

**Verification:**
```bash
npx expo start --ios
# AI asks a question → options appear → tap answer → AI continues
```

---

## Session 129: Plan Approval Modal

**Goal:** Build the plan approval modal as a full-screen overlay.

**Definition of Done:** Plan content renders as scrollable markdown with Approve/Reject buttons.

**Tasks:**

1. `[app]` Create `src/components/sessions/PlanApprovalModal.tsx`:
   ```tsx
   import { Modal, ScrollView, View, Text, Pressable } from 'react-native'
   import Markdown from 'react-native-markdown-display'

   export function PlanApprovalModal({ visible, plan, onApprove, onReject }) {
     const [feedback, setFeedback] = useState('')
     const [showFeedback, setShowFeedback] = useState(false)

     return (
       <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
         <View className="flex-1 bg-zinc-900">
           <View className="p-4 bg-zinc-800 border-b border-zinc-700">
             <Text className="text-white text-xl font-bold">Plan Ready for Review</Text>
           </View>

           <ScrollView className="flex-1 p-4">
             <Markdown style={markdownStyles}>{plan?.content || ''}</Markdown>
           </ScrollView>

           {showFeedback ? (
             <View className="p-4 border-t border-zinc-700">
               <TextInput
                 className="bg-zinc-800 text-white p-3 rounded-lg mb-3"
                 placeholder="Feedback for rejection..."
                 placeholderTextColor="#71717a"
                 value={feedback}
                 onChangeText={setFeedback}
                 multiline
               />
               <View className="flex-row">
                 <Pressable
                   className="flex-1 bg-zinc-700 rounded-lg p-3 mr-2"
                   onPress={() => setShowFeedback(false)}
                 >
                   <Text className="text-white text-center">Cancel</Text>
                 </Pressable>
                 <Pressable
                   className="flex-1 bg-red-600 rounded-lg p-3"
                   onPress={() => onReject(feedback)}
                 >
                   <Text className="text-white text-center font-semibold">Reject</Text>
                 </Pressable>
               </View>
             </View>
           ) : (
             <View className="flex-row p-4 border-t border-zinc-700">
               <Pressable
                 className="flex-1 bg-red-600 rounded-lg p-4 mr-2"
                 onPress={() => setShowFeedback(true)}
               >
                 <Text className="text-white text-center font-semibold">Reject</Text>
               </Pressable>
               <Pressable
                 className="flex-1 bg-green-600 rounded-lg p-4"
                 onPress={onApprove}
               >
                 <Text className="text-white text-center font-semibold">Approve</Text>
               </Pressable>
             </View>
           )}
         </View>
       </Modal>
     )
   }
   ```

2. `[app]` Trigger the modal from the session view when `plan.ready` event is received.

3. `[app]` On approve: call `opencodePlanApprove` via store.

4. `[app]` On reject: call `opencodePlanReject` with feedback via store.

**Verification:**
```bash
npx expo start --ios
# AI creates a plan → modal slides up → scroll through plan → approve or reject
```

---

## Session 130: Model Selector

**Goal:** Build the model selector as a bottom sheet.

**Definition of Done:** Bottom sheet shows available models, current selection highlighted, changing model updates the session.

**Tasks:**

1. `[app]` Create `src/components/sessions/ModelSelector.tsx`:
   ```tsx
   import BottomSheet, { BottomSheetFlatList } from '@gorhom/bottom-sheet'

   export function ModelSelector({ visible, onDismiss, sessionId }) {
     const { models, currentModel, setModel } = useSessionStore()
     const snapPoints = useMemo(() => ['50%', '80%'], [])

     if (!visible) return null

     return (
       <BottomSheet
         snapPoints={snapPoints}
         onClose={onDismiss}
         backgroundStyle={{ backgroundColor: '#18181b' }}
         handleIndicatorStyle={{ backgroundColor: '#71717a' }}
       >
         <Text className="text-white text-lg font-bold px-4 py-2">Select Model</Text>

         <BottomSheetFlatList
           data={models}
           renderItem={({ item }) => (
             <Pressable
               className={`px-4 py-3 flex-row items-center ${
                 item.id === currentModel?.id ? 'bg-blue-900/30' : ''
               }`}
               onPress={() => {
                 setModel(sessionId, item)
                 onDismiss()
               }}
             >
               <View className="flex-1">
                 <Text className="text-white font-medium">{item.name}</Text>
                 <Text className="text-zinc-400 text-sm">{item.provider}</Text>
               </View>
               {item.id === currentModel?.id && <Check size={18} color="#60a5fa" />}
             </Pressable>
           )}
           keyExtractor={item => item.id}
         />
       </BottomSheet>
     )
   }
   ```

2. `[app]` Trigger from session header (tap on model name).

3. `[app]` Load available models via `opencodeModels` query on open.

4. `[app]` Call `opencodeSetModel` mutation on selection.

**Verification:**
```bash
npx expo start --ios
# Tap model name in session → bottom sheet appears → select model → sheet dismisses
```

---

## Summary of Files Created

```
src/screens/
  ProjectBrowserScreen.tsx          — Project/worktree browsing
  WorktreeDetailScreen.tsx          — Worktree info + session list
  SessionViewScreen.tsx             — Main AI session view

src/components/
  StatusBadge.tsx                   — Status color indicator
  ProjectIcon.tsx                   — Project language/custom icon
  SessionListItem.tsx               — Session row in worktree detail

src/components/sessions/
  MessageList.tsx                   — FlashList message rendering
  MessageBubble.tsx                 — User/assistant message styling
  InputArea.tsx                     — Text input + send/abort
  ModeChip.tsx                      — Build/plan mode toggle
  SessionHeader.tsx                 — Session name, model, context
  ToolCard.tsx                      — Collapsed/expandable tool invocation
  ToolIcon.tsx                      — Tool name → icon mapping
  PermissionBanner.tsx              — Permission request Allow/Deny
  QuestionBanner.tsx                — Question answer options
  PlanApprovalModal.tsx             — Full-screen plan review
  ModelSelector.tsx                 — Bottom sheet model picker
```

## What Comes Next

Phase 14 (Mobile Feature Screens, Sessions 131-139) builds the remaining screens for full feature parity: file tree browser, file viewer/editor, git changes/diff, simplified terminal, settings, and session history search.
