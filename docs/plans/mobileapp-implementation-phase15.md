# Phase 15 — Mobile Polish (Sessions 140–144)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 15 adds production-readiness features to the mobile app: push notifications (FCM/APNs), deep linking from notifications, actionable notifications (approve/deny from notification tray), robust offline/reconnection handling, and performance optimization.

At the end of this phase, the mobile app is feature-complete and production-quality — ready for testing and app store submission.

## Prerequisites

- Phases 11-14 completed: all screens and stores working, GraphQL transport functional.
- Apollo Client with WebSocket subscriptions working.
- `useConnectionManagerStore` with reconnection logic.
- `useStreamSubscription` hook processing events.

## Key Source Files (Read-Only Reference — Desktop Repo)

| File | Purpose |
|------|---------|
| `src/renderer/src/hooks/useOpenCodeGlobalListener.ts` | Stream event handling (reference for notification triggers) |
| `src/renderer/src/stores/useWorktreeStatusStore.ts` | Status tracking — drives notification triggers |
| `docs/plans/mobileapp.md` Section 4.9 | PRD offline/reconnection design |
| `docs/plans/mobileapp.md` Section 4.10 | PRD push notification design |
| `docs/plans/mobileapp.md` Section 4.11 | PRD performance optimization design |

## Architecture Notes

### Push Notification Flow

```
Server Event → GraphQL Subscription → Mobile App
                                         ↓
                                    App in foreground? → Update UI directly
                                    App in background? → Show push notification
                                         ↓
                                    Notification tapped → Deep link to screen
                                    Action button pressed → Send GraphQL mutation
```

The server does NOT send push notifications directly. The mobile app handles all notification logic client-side:
1. When a subscription event arrives while the app is backgrounded, the app creates a local notification
2. FCM/APNs are used for wake-up pushes when the WebSocket disconnects (future enhancement)

### Connection State Machine

```
             ┌────────────┐
    ┌───────►│Disconnected│◄──────────────────────┐
    │        └─────┬──────┘                        │
    │              │ connect()                     │
    │              ▼                               │
    │        ┌────────────┐                        │
    │        │ Connecting  │────────► Failed ───────┘
    │        └─────┬──────┘          (max retries)
    │              │ success
    │              ▼
    │        ┌────────────┐
    │        │ Connected   │
    │        └─────┬──────┘
    │              │ connection lost
    │              ▼
    │        ┌──────────────┐
    └────────│ Reconnecting │
             │ (exp backoff)│
             └──────────────┘
```

### Performance Strategy

| Area | Strategy |
|------|----------|
| Message list | FlashList with recycling, 30fps streaming throttle |
| Tool cards | Collapsed by default, lazy expansion |
| Long sessions | Keep only 100 recent messages in memory, paginate older ones |
| Git status | 500ms debounce (vs 150ms desktop) |
| File tree | Lazy child loading, scan-on-expand |
| Apollo cache | Normalized cache, `fetchPolicy: 'cache-and-network'` for key queries |

---

## Session 140: Push Notifications

**Goal:** Integrate push notification infrastructure (FCM/APNs) and register device token with server.

**Definition of Done:** App can show local notifications, device token registered with server.

**Tasks:**

1. `[app]` Install notification library:
   ```bash
   pnpm add @notifee/react-native
   # For FCM (optional, for remote wake-up):
   pnpm add @react-native-firebase/messaging
   ```

2. `[app]` Create `src/lib/notifications.ts`:
   ```typescript
   import notifee, { AndroidImportance, EventType } from '@notifee/react-native'

   // Create notification channels (Android)
   export async function setupNotificationChannels() {
     await notifee.createChannel({
       id: 'session-events',
       name: 'Session Events',
       importance: AndroidImportance.HIGH,
     })

     await notifee.createChannel({
       id: 'permissions',
       name: 'Permission Requests',
       importance: AndroidImportance.HIGH,
     })
   }

   // Show a local notification
   export async function showNotification(options: {
     title: string
     body: string
     channelId: string
     data?: Record<string, string>
     actions?: Array<{ title: string; pressAction: { id: string } }>
   }) {
     await notifee.displayNotification({
       title: options.title,
       body: options.body,
       android: {
         channelId: options.channelId,
         smallIcon: 'ic_notification',
         pressAction: { id: 'default' },
         actions: options.actions,
       },
       ios: {
         categoryId: options.actions ? 'permission-request' : undefined,
       },
       data: options.data,
     })
   }
   ```

3. `[app]` Create `src/stores/useNotificationStore.ts`:
   ```typescript
   import { create } from 'zustand'

   interface NotificationState {
     pushToken: string | null
     notificationsEnabled: boolean
     registerPushToken(): Promise<void>
     enableNotifications(): Promise<void>
   }

   export const useNotificationStore = create<NotificationState>((set, get) => ({
     pushToken: null,
     notificationsEnabled: false,

     async registerPushToken() {
       // Get FCM/APNs token
       const token = await getDeviceToken()
       if (token) {
         set({ pushToken: token })
         // Register with Hive server
         await transport.systemOps.registerPushToken(token, Platform.OS)
       }
     },

     async enableNotifications() {
       const permission = await notifee.requestPermission()
       set({ notificationsEnabled: permission.authorizationStatus >= 1 })
       if (permission.authorizationStatus >= 1) {
         await get().registerPushToken()
       }
     }
   }))
   ```

4. `[app]` Trigger notifications from stream event handler when app is backgrounded:
   ```typescript
   import { AppState } from 'react-native'

   // In handleStreamEvent():
   if (AppState.currentState !== 'active') {
     switch (type) {
       case 'session.completed':
         showNotification({
           title: 'Session Completed',
           body: `AI session finished in ${getWorktreeName(sessionId)}`,
           channelId: 'session-events',
           data: { sessionId, worktreeId }
         })
         break
       case 'permission.requested':
         showNotification({
           title: 'Permission Required',
           body: `${data.permission} — ${data.tool || 'unknown tool'}`,
           channelId: 'permissions',
           data: { sessionId, requestId: data.id },
           actions: [
             { title: 'Allow', pressAction: { id: 'allow' } },
             { title: 'Deny', pressAction: { id: 'deny' } }
           ]
         })
         break
       case 'question.asked':
         showNotification({
           title: 'AI Question',
           body: data.prompt || 'The AI has a question for you',
           channelId: 'session-events',
           data: { sessionId }
         })
         break
       case 'plan.ready':
         showNotification({
           title: 'Plan Ready',
           body: 'A plan is ready for your review',
           channelId: 'session-events',
           data: { sessionId }
         })
         break
       case 'session.error':
         showNotification({
           title: 'Session Error',
           body: data.message || 'An error occurred',
           channelId: 'session-events',
           data: { sessionId }
         })
         break
     }
   }
   ```

5. `[app]` Set up notification channels on app start.

**Verification:**
```bash
npx expo start --ios
# Background the app → trigger AI event → notification appears
```

---

## Session 141: Deep Linking

**Goal:** Implement deep linking from notification taps to relevant screens.

**Definition of Done:** Tapping a notification navigates to the correct screen (session view, permission modal, etc.).

**Tasks:**

1. `[app]` Handle notification press events:
   ```typescript
   // In App.tsx or a startup hook
   import notifee, { EventType } from '@notifee/react-native'

   useEffect(() => {
     // Handle notification tap when app is in background/killed
     notifee.getInitialNotification().then(notification => {
       if (notification) handleNotificationNavigation(notification.notification.data)
     })

     // Handle notification tap when app is in foreground
     const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
       if (type === EventType.PRESS) {
         handleNotificationNavigation(detail.notification?.data)
       }
     })

     return unsubscribe
   }, [])
   ```

2. `[app]` Create `src/lib/deep-linking.ts`:
   ```typescript
   import { NavigationContainerRef } from '@react-navigation/native'

   let navigationRef: NavigationContainerRef<any> | null = null

   export function setNavigationRef(ref: NavigationContainerRef<any>) {
     navigationRef = ref
   }

   export function handleNotificationNavigation(data?: Record<string, string>) {
     if (!data || !navigationRef) return

     const { sessionId, worktreeId, requestId } = data

     if (sessionId && worktreeId) {
       // Navigate to session view
       navigationRef.navigate('ProjectsTab', {
         screen: 'SessionView',
         params: { sessionId, worktreeId }
       })
     } else if (requestId) {
       // Navigate to permission/question handler
       // The session view will show the pending permission/question
       navigationRef.navigate('SessionTab')
     }
   }
   ```

3. `[app]` Pass navigation ref from `NavigationContainer`:
   ```tsx
   <NavigationContainer ref={ref => setNavigationRef(ref)}>
     ...
   </NavigationContainer>
   ```

4. `[app]` Handle background notification events:
   ```typescript
   // Register background handler (runs even when app is killed)
   notifee.onBackgroundEvent(async ({ type, detail }) => {
     if (type === EventType.PRESS) {
       // Store the deep link target, handle on next app open
       await AsyncStorage.setItem('pending_deep_link', JSON.stringify(detail.notification?.data))
     }
   })
   ```

**Verification:**
```bash
npx expo start --ios
# Receive notification → tap → app opens to correct session
# Kill app → receive notification → tap → app opens to correct screen
```

---

## Session 142: Actionable Notifications

**Goal:** Allow users to approve/deny permissions directly from the notification tray.

**Definition of Done:** Permission notification shows Allow/Deny buttons. Tapping a button sends the reply without opening the app.

**Tasks:**

1. `[app]` Set up iOS notification categories:
   ```typescript
   import notifee from '@notifee/react-native'

   await notifee.setNotificationCategories([
     {
       id: 'permission-request',
       actions: [
         { id: 'allow', title: 'Allow', foreground: false },
         { id: 'deny', title: 'Deny', foreground: false, destructive: true },
       ]
     }
   ])
   ```

2. `[app]` Handle action button presses:
   ```typescript
   notifee.onBackgroundEvent(async ({ type, detail }) => {
     if (type === EventType.ACTION_PRESS) {
       const { pressAction, notification } = detail
       const data = notification?.data

       if (pressAction?.id === 'allow' && data?.requestId) {
         // Send permission reply via GraphQL (need to set up background-capable client)
         await sendPermissionReply(data.requestId, 'once', data.worktreePath)
       } else if (pressAction?.id === 'deny' && data?.requestId) {
         await sendPermissionReply(data.requestId, 'reject', data.worktreePath)
       }
     }
   })
   ```

3. `[app]` Create a lightweight GraphQL client for background operations:
   ```typescript
   // src/lib/background-client.ts
   async function sendPermissionReply(requestId: string, reply: string, worktreePath?: string) {
     const { serverUrl, apiKey } = await loadCredentials()
     if (!serverUrl || !apiKey) return

     await fetch(`https://${serverUrl}/graphql`, {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Authorization': `Bearer ${apiKey}`
       },
       body: JSON.stringify({
         query: `mutation PermissionReply($input: PermissionReplyInput!) {
           opencodePermissionReply(input: $input) { success }
         }`,
         variables: {
           input: { requestId, reply, worktreePath }
         }
       })
     })
   }
   ```

4. `[app]` Dismiss the notification after action is taken.

**Verification:**
```bash
npx expo start --ios
# Background app → permission notification appears → tap "Allow" from notification tray
# AI continues without opening app
```

---

## Session 143: Offline & Reconnection

**Goal:** Implement robust offline handling and automatic reconnection with state recovery.

**Definition of Done:** Losing connection shows offline banner, automatic reconnection with state recovery, cached data viewable offline.

**Tasks:**

1. `[app]` Create `src/hooks/useConnectionMonitor.ts`:
   ```typescript
   import NetInfo from '@react-native-community/netinfo'

   export function useConnectionMonitor() {
     const { state, _startReconnection, connect } = useConnectionManagerStore()

     // Monitor network connectivity
     useEffect(() => {
       const unsubscribe = NetInfo.addEventListener(netState => {
         if (netState.isConnected && state === 'disconnected') {
           connect()
         } else if (!netState.isConnected && state === 'connected') {
           _startReconnection()
         }
       })
       return unsubscribe
     }, [state])

     // Monitor WebSocket health
     useEffect(() => {
       if (state !== 'connected') return

       const healthCheck = setInterval(async () => {
         try {
           const result = await transport.systemOps.serverStatus()
           if (!result.success) throw new Error('Health check failed')
         } catch {
           _startReconnection()
         }
       }, 30_000) // Every 30 seconds

       return () => clearInterval(healthCheck)
     }, [state])
   }
   ```

2. `[app]` Create `src/components/OfflineBanner.tsx`:
   ```tsx
   export function OfflineBanner() {
     const { state, reconnectAttempts } = useConnectionManagerStore()

     if (state === 'connected') return null

     const message = {
       disconnected: 'Disconnected from server',
       connecting: 'Connecting...',
       reconnecting: `Reconnecting... (attempt ${reconnectAttempts})`,
       failed: 'Connection failed'
     }[state]

     return (
       <View className={`px-4 py-2 ${state === 'reconnecting' ? 'bg-yellow-700' : 'bg-red-700'}`}>
         <Text className="text-white text-center text-sm">{message}</Text>
       </View>
     )
   }
   ```

3. `[app]` State recovery on reconnect:
   ```typescript
   async function handleReconnected() {
     // Re-establish subscriptions (Apollo Client handles WS reconnection)

     // Re-fetch critical data for currently visible screens
     const activeSessionId = useSessionStore.getState().activeSessionId
     if (activeSessionId) {
       // Reconnect AI session
       await useSessionStore.getState().reconnectSession(activeSessionId)
       // Re-fetch messages (may have missed events during disconnect)
       await useSessionStore.getState().loadMessages(worktreePath, activeSessionId)
     }

     // Re-fetch git status for visible worktree
     const activeWorktreeId = useWorktreeStore.getState().selectedWorktreeId
     if (activeWorktreeId) {
       const worktree = useWorktreeStore.getState().getWorktree(activeWorktreeId)
       if (worktree?.path) {
         await useGitStore.getState().loadStatuses(worktree.path)
       }
     }
   }
   ```

4. `[app]` Offline mode behavior:
   - Cached data (projects, worktrees, sessions) remains viewable via Apollo cache
   - Actions that require server show error toast: "Cannot perform action while offline"
   - Persistent "Offline" banner at top of screen

5. `[app]` Add `OfflineBanner` to app root, above navigation.

**Verification:**
```bash
npx expo start --ios
# Disconnect WiFi → offline banner appears → reconnect WiFi → auto-reconnects
# Kill headless server → reconnection attempts → restart server → reconnects and recovers state
```

---

## Session 144: Performance Optimization

**Goal:** Optimize app performance for smooth 60fps across all screens.

**Definition of Done:** No dropped frames during AI streaming, smooth scrolling on long lists, memory usage stable.

**Tasks:**

1. `[app]` Optimize streaming rendering:
   ```typescript
   // 30fps throttle for message.updated events
   const FRAME_MS = 33 // ~30fps
   let lastFrameTime = 0
   let pendingUpdate: string | null = null
   let rafId: number | null = null

   function throttledMessageUpdate(sessionId: string, content: string) {
     pendingUpdate = content

     if (rafId !== null) return

     rafId = requestAnimationFrame(() => {
       rafId = null
       const now = Date.now()
       if (now - lastFrameTime >= FRAME_MS && pendingUpdate !== null) {
         lastFrameTime = now
         // Actual state update
         updateMessageInStore(sessionId, pendingUpdate)
         pendingUpdate = null
       }
     })
   }
   ```

2. `[app]` Message list windowing for long sessions:
   ```typescript
   // In MessageList.tsx
   const VISIBLE_MESSAGES = 100

   const visibleMessages = useMemo(() => {
     if (messages.length <= VISIBLE_MESSAGES) return messages
     // Keep most recent messages + "Load more" button
     return messages.slice(-VISIBLE_MESSAGES)
   }, [messages])
   ```

3. `[app]` FlashList configuration:
   ```tsx
   <FlashList
     data={messages}
     renderItem={renderMessage}
     estimatedItemSize={100} // Tune based on average message height
     drawDistance={250} // Pre-render 250px ahead of viewport
     overrideItemLayout={(layout, item) => {
       // Provide accurate height estimates per message type
       layout.size = item.role === 'user' ? 60 : Math.max(100, item.content.length / 2)
     }}
   />
   ```

4. `[app]` Apollo cache optimization:
   ```typescript
   const cache = new InMemoryCache({
     typePolicies: {
       Query: {
         fields: {
           // Merge paginated results
           projects: { merge: true },
           // Cache git statuses with worktreePath key
           gitFileStatuses: {
             keyArgs: ['worktreePath'],
             merge: true
           }
         }
       }
     }
   })
   ```

5. `[app]` Git status debounce (500ms on mobile vs 150ms desktop):
   ```typescript
   // In useGitStatusSubscription hook
   const debouncedRefresh = useDebouncedCallback(
     (worktreePath: string) => {
       useGitStore.getState().loadStatuses(worktreePath)
     },
     500 // 500ms debounce on mobile
   )
   ```

6. `[app]` Tool card lazy rendering:
   ```tsx
   function ToolCard({ tool }) {
     const [expanded, setExpanded] = useState(false)

     return (
       <Pressable onPress={() => setExpanded(!expanded)}>
         <ToolCardHeader tool={tool} />
         {expanded && (
           // Only render detail content when expanded
           <Suspense fallback={<ActivityIndicator />}>
             <ToolCardDetail tool={tool} />
           </Suspense>
         )}
       </Pressable>
     )
   }
   ```

7. `[app]` Profile and optimize with React Native performance tools:
   - Use `react-native-flipper` for performance profiling
   - Check for unnecessary re-renders with `React.memo` and `useMemo`
   - Verify FlashList recycling works correctly (no blank items)

**Verification:**
```bash
npx expo start --ios
# Profile with Xcode Instruments:
# - GPU frame rate during streaming: 60fps
# - Memory during long session: stable, no leaks
# - Scroll performance on 200+ message list: smooth
```

---

## Summary of Files Created

```
src/lib/
  notifications.ts                  — Notification setup and display helpers
  deep-linking.ts                   — Navigation from notifications
  background-client.ts              — Lightweight GraphQL client for background ops

src/stores/
  useNotificationStore.ts           — Push token and notification preferences

src/hooks/
  useConnectionMonitor.ts           — Network + WebSocket health monitoring

src/components/
  OfflineBanner.tsx                 — Connection status banner
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `src/App.tsx` | Add OfflineBanner, notification setup, deep linking ref |
| `src/lib/stream-event-handler.ts` | Add notification triggers for backgrounded events |
| `src/stores/useConnectionManagerStore.ts` | Enhanced reconnection, state recovery |
| `src/components/sessions/MessageList.tsx` | 30fps throttle, message windowing |
| `src/lib/apollo.ts` | Cache optimization, fetchPolicy tuning |

## What Comes Next

Phase 16 (Mobile Testing, Sessions 145-148) adds unit tests for shared stores, component tests with React Native Testing Library, E2E tests with Detox, and app store preparation.
