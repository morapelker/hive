# Phase 11 — React Native Foundation (Sessions 106–113)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 11 begins the React Native mobile app in a **separate repository**. It scaffolds the project, sets up the core infrastructure (NativeWind, React Navigation, Apollo Client, graphql-codegen), creates the transport abstraction layer, implements the connection manager store, and builds the pairing screen.

At the end of this phase, the mobile app can connect to a running Hive headless server, authenticate, and is ready for store porting and screen implementation.

## Prerequisites

- Phases 1-10 completed: Hive headless server fully functional and tested.
- A running headless server instance for testing: `hive --headless --port 8443`
- The GraphQL SDL schema files from `src/server/schema/` available for codegen.

## Repository Setup

This phase creates a **new repository** (e.g., `hive-mobile`). All tasks are prefixed with `[app]`.

**Target folder structure:**
```
hive-mobile/
  src/
    screens/                  — Screen components
    components/               — Reusable UI components
      ui/                     — Base UI primitives
    stores/                   — Zustand stores
    hooks/                    — Custom hooks
    lib/                      — Utilities
      apollo.ts               — Apollo Client setup
      transport.ts            — HiveTransport interface
      graphql-transport.ts    — GraphQL implementation of transport
    graphql/                  — Generated types and hooks
      schema/                 — Copied SDL schema files
      __generated__/          — Codegen output
    navigation/               — React Navigation setup
  app.json                    — Expo / RN config
  tailwind.config.js          — NativeWind config
  codegen.ts                  — graphql-codegen config
  package.json
  tsconfig.json
```

## Architecture Notes

### Transport Abstraction

The key architectural insight: Zustand stores in the desktop app call `window.db.project.getAll()`, `window.opencodeOps.connect(...)`, etc. The mobile app needs the exact same store logic, but calling GraphQL instead of IPC.

The `HiveTransport` interface mirrors the `window.*` API namespaces. Stores call transport methods instead of `window.*` directly:

```typescript
// src/lib/transport.ts
interface HiveTransport {
  db: {
    project: {
      getAll(): Promise<Project[]>
      get(id: string): Promise<Project | null>
      create(data: CreateProjectInput): Promise<Project>
      update(id: string, data: UpdateProjectInput): Promise<Project | null>
      delete(id: string): Promise<boolean>
      // ... all DB methods
    }
    worktree: { /* ... */ }
    session: { /* ... */ }
    setting: { /* ... */ }
    space: { /* ... */ }
  }
  opencodeOps: {
    connect(worktreePath: string, hiveSessionId: string): Promise<ConnectResult>
    prompt(input: PromptInput): Promise<SuccessResult>
    abort(worktreePath: string, sessionId: string): Promise<SuccessResult>
    // ... all opencode operations
  }
  gitOps: {
    getFileStatuses(worktreePath: string): Promise<FileStatusesResult>
    // ... all git operations
  }
  fileTreeOps: { /* ... */ }
  fileOps: { /* ... */ }
  scriptOps: { /* ... */ }
  terminalOps: { /* ... */ }
  settingsOps: { /* ... */ }
  systemOps: { /* ... */ }
}
```

### Apollo Client Split Link

```
Query/Mutation → HttpLink → HTTPS → GraphQL Server
Subscription   → GraphQLWsLink → WSS → GraphQL Server
```

The split link routes subscriptions over WebSocket and everything else over HTTPS.

### Connection Manager

Manages server connection state, credentials, and reconnection:

```
Disconnected → Connecting → Connected → Reconnecting → Connected
                    ↓                         ↓
                 Failed                    Failed (max retries)
                    ↓                         ↓
              Disconnected              Disconnected
```

---

## Session 106: App Scaffolding

**Goal:** Initialize the React Native project with TypeScript.

**Definition of Done:** Project builds and runs on iOS simulator with a blank screen.

**Tasks:**

1. `[app]` Initialize project:
   ```bash
   npx create-expo-app hive-mobile --template blank-typescript
   # OR for bare workflow:
   npx react-native init HiveMobile --template react-native-template-typescript
   ```

2. `[app]` Set up TypeScript configuration (`tsconfig.json`):
   - `strict: true`
   - Path aliases: `@/` → `src/`
   - `noEmit: true`

3. `[app]` Set up ESLint + Prettier matching Hive conventions:
   - No semicolons, single quotes, no trailing commas
   - 100 char print width, 2-space indent
   - Add `.eslintrc.js` and `.prettierrc`

4. `[app]` Create folder structure:
   ```bash
   mkdir -p src/{screens,components/ui,stores,hooks,lib,graphql/schema,graphql/__generated__,navigation}
   ```

5. `[app]` Create `src/App.tsx` with a basic `<View><Text>Hive Mobile</Text></View>`.

6. `[app]` Verify:
   ```bash
   npx expo start # or npx react-native run-ios
   ```

**Verification:**
```bash
npx expo start --ios
# App should render "Hive Mobile" text on screen
```

---

## Session 107: NativeWind Setup

**Goal:** Configure Tailwind CSS for React Native via NativeWind.

**Definition of Done:** Can use Tailwind classes on RN components and styles render correctly.

**Tasks:**

1. `[app]` Install NativeWind:
   ```bash
   pnpm add nativewind
   pnpm add -D tailwindcss
   ```

2. `[app]` Create `tailwind.config.js`:
   ```javascript
   module.exports = {
     content: ['./src/**/*.{js,jsx,ts,tsx}'],
     presets: [require('nativewind/preset')],
     theme: {
       extend: {
         colors: {
           // Match Hive desktop theme colors
           background: 'var(--background)',
           foreground: 'var(--foreground)',
           primary: 'var(--primary)',
           muted: 'var(--muted)',
           accent: 'var(--accent)',
           destructive: 'var(--destructive)',
         }
       },
     },
     plugins: [],
   }
   ```

3. `[app]` Configure babel plugin:
   ```javascript
   // babel.config.js
   module.exports = function (api) {
     api.cache(true)
     return {
       presets: ['babel-preset-expo'],
       plugins: ['nativewind/babel'],
     }
   }
   ```

4. `[app]` Create a test component to verify styling:
   ```tsx
   // src/components/TestStyles.tsx
   import { View, Text } from 'react-native'

   export function TestStyles() {
     return (
       <View className="flex-1 items-center justify-center bg-zinc-900">
         <Text className="text-white text-2xl font-bold">Hive Mobile</Text>
         <Text className="text-zinc-400 text-sm mt-2">NativeWind working</Text>
       </View>
     )
   }
   ```

5. `[app]` Verify styles render correctly on iOS simulator.

**Verification:**
```bash
npx expo start --ios
# Verify dark background, white title, gray subtitle
```

---

## Session 108: React Navigation Setup

**Goal:** Set up the navigation structure with bottom tabs and native stacks.

**Definition of Done:** Bottom tab navigator with 4 tabs, each containing a stack navigator. Navigation works between screens.

**Tasks:**

1. `[app]` Install dependencies:
   ```bash
   pnpm add @react-navigation/native @react-navigation/bottom-tabs @react-navigation/native-stack
   pnpm add react-native-screens react-native-safe-area-context
   ```

2. `[app]` Create `src/navigation/types.ts` — navigation type definitions:
   ```typescript
   export type RootTabParamList = {
     ProjectsTab: undefined
     SessionTab: undefined
     FilesTab: undefined
     MoreTab: undefined
   }

   export type ProjectsStackParamList = {
     ProjectList: undefined
     WorktreeDetail: { worktreeId: string }
     SessionView: { sessionId: string; worktreeId: string }
   }

   export type SessionStackParamList = {
     ActiveSession: undefined
     FileViewer: { filePath: string }
   }

   export type FilesStackParamList = {
     FileTree: { worktreePath: string }
     FileViewer: { filePath: string }
     GitChanges: { worktreePath: string }
     DiffViewer: { filePath: string; worktreePath: string }
   }

   export type MoreStackParamList = {
     SettingsHome: undefined
     ConnectionSetup: undefined
     TerminalRunner: { worktreeId: string }
     SessionHistory: undefined
   }
   ```

3. `[app]` Create `src/navigation/TabNavigator.tsx`:
   ```tsx
   import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
   import { Layers, MessageSquare, FolderTree, MoreHorizontal } from 'lucide-react-native'

   const Tab = createBottomTabNavigator<RootTabParamList>()

   export function TabNavigator() {
     return (
       <Tab.Navigator screenOptions={{
         tabBarStyle: { backgroundColor: '#18181b' },
         tabBarActiveTintColor: '#fff',
         tabBarInactiveTintColor: '#71717a',
         headerShown: false
       }}>
         <Tab.Screen name="ProjectsTab" component={ProjectsStack}
           options={{ tabBarLabel: 'Projects', tabBarIcon: ({ color }) => <Layers color={color} size={20} /> }} />
         <Tab.Screen name="SessionTab" component={SessionStack}
           options={{ tabBarLabel: 'Session', tabBarIcon: ({ color }) => <MessageSquare color={color} size={20} /> }} />
         <Tab.Screen name="FilesTab" component={FilesStack}
           options={{ tabBarLabel: 'Files', tabBarIcon: ({ color }) => <FolderTree color={color} size={20} /> }} />
         <Tab.Screen name="MoreTab" component={MoreStack}
           options={{ tabBarLabel: 'More', tabBarIcon: ({ color }) => <MoreHorizontal color={color} size={20} /> }} />
       </Tab.Navigator>
     )
   }
   ```

4. `[app]` Create placeholder stack navigators for each tab.

5. `[app]` Create placeholder screens for each route (empty views with screen name text).

6. `[app]` Wire into `App.tsx`:
   ```tsx
   import { NavigationContainer } from '@react-navigation/native'
   import { TabNavigator } from './navigation/TabNavigator'

   export default function App() {
     return (
       <NavigationContainer>
         <TabNavigator />
       </NavigationContainer>
     )
   }
   ```

7. `[app]` Verify tab navigation works.

**Verification:**
```bash
npx expo start --ios
# Tap each tab, verify screen changes
```

---

## Session 109: Apollo Client Setup

**Goal:** Set up Apollo Client with HTTP + WebSocket split link and authentication.

**Definition of Done:** Apollo Client connected to the headless server, can execute a simple query.

**Tasks:**

1. `[app]` Install dependencies:
   ```bash
   pnpm add @apollo/client graphql graphql-ws
   ```

2. `[app]` Create `src/lib/apollo.ts`:
   ```typescript
   import { ApolloClient, InMemoryCache, split, HttpLink } from '@apollo/client'
   import { GraphQLWsLink } from '@apollo/client/link/subscriptions'
   import { createClient } from 'graphql-ws'
   import { getMainDefinition } from '@apollo/client/utilities'

   export function createApolloClient(serverUrl: string, apiKey: string) {
     const httpLink = new HttpLink({
       uri: `https://${serverUrl}/graphql`,
       headers: { authorization: `Bearer ${apiKey}` },
       // For self-signed certs: may need custom fetch with SSL pinning
     })

     const wsLink = new GraphQLWsLink(createClient({
       url: `wss://${serverUrl}/graphql`,
       connectionParams: { apiKey },
     }))

     const splitLink = split(
       ({ query }) => {
         const def = getMainDefinition(query)
         return def.kind === 'OperationDefinition' && def.operation === 'subscription'
       },
       wsLink,
       httpLink,
     )

     return new ApolloClient({
       link: splitLink,
       cache: new InMemoryCache({
         typePolicies: {
           Project: { keyFields: ['id'] },
           Worktree: { keyFields: ['id'] },
           Session: { keyFields: ['id'] },
         }
       }),
     })
   }
   ```

3. `[app]` Create `src/lib/ApolloProvider.tsx`:
   ```tsx
   import { ApolloProvider as BaseProvider } from '@apollo/client'
   import { useConnectionManagerStore } from '../stores/useConnectionManagerStore'
   import { createApolloClient } from './apollo'

   export function ApolloProvider({ children }: { children: React.ReactNode }) {
     const { serverUrl, apiKey, isConnected } = useConnectionManagerStore()

     if (!isConnected || !serverUrl || !apiKey) {
       return <>{children}</>
     }

     const client = createApolloClient(serverUrl, apiKey)
     return <BaseProvider client={client}>{children}</BaseProvider>
   }
   ```

4. `[app]` Wrap app in `ApolloProvider`:
   ```tsx
   export default function App() {
     return (
       <ApolloProvider>
         <NavigationContainer>
           <TabNavigator />
         </NavigationContainer>
       </ApolloProvider>
     )
   }
   ```

5. `[app]` Test with a simple query once connected.

**Verification:**
```bash
# Start headless server: hive --headless --port 8443
# Run app, connect, verify query works
```

---

## Session 110: Codegen Setup

**Goal:** Configure graphql-codegen to generate typed hooks from the SDL schema.

**Definition of Done:** `pnpm codegen` generates typed Apollo hooks, hooks are importable.

**Tasks:**

1. `[app]` Install codegen:
   ```bash
   pnpm add -D @graphql-codegen/cli @graphql-codegen/typescript @graphql-codegen/typescript-operations @graphql-codegen/typescript-react-apollo
   ```

2. `[app]` Copy SDL schema files from the server repo to `src/graphql/schema/`.

3. `[app]` Create `codegen.ts`:
   ```typescript
   import type { CodegenConfig } from '@graphql-codegen/cli'

   const config: CodegenConfig = {
     schema: 'src/graphql/schema/**/*.graphql',
     documents: 'src/**/*.{ts,tsx}',
     generates: {
       'src/graphql/__generated__/': {
         preset: 'client',
         plugins: [],
         presetConfig: {
           gqlTagName: 'gql',
         }
       },
       'src/graphql/__generated__/hooks.ts': {
         plugins: [
           'typescript',
           'typescript-operations',
           'typescript-react-apollo',
         ],
         config: {
           withHooks: true,
           withComponent: false,
           withHOC: false,
         }
       }
     }
   }

   export default config
   ```

4. `[app]` Add script to `package.json`:
   ```json
   "codegen": "graphql-codegen --config codegen.ts"
   ```

5. `[app]` Create a few sample GraphQL operations to test codegen:
   ```typescript
   // src/graphql/operations/projects.ts
   import { gql } from '@apollo/client'

   export const PROJECTS_QUERY = gql`
     query Projects {
       projects { id name path language lastAccessedAt }
     }
   `

   export const CREATE_PROJECT = gql`
     mutation CreateProject($input: CreateProjectInput!) {
       createProject(input: $input) { id name path }
     }
   `
   ```

6. `[app]` Run codegen:
   ```bash
   pnpm codegen
   ```

7. `[app]` Verify generated hooks are importable:
   ```typescript
   import { useProjectsQuery, useCreateProjectMutation } from '../graphql/__generated__/hooks'
   ```

**Verification:**
```bash
pnpm codegen && pnpm tsc --noEmit
```

---

## Session 111: Transport Abstraction

**Goal:** Create the `HiveTransport` interface and GraphQL transport implementation.

**Definition of Done:** Transport interface defined, GraphQL transport wraps Apollo Client calls, injectable into stores.

**Tasks:**

1. `[app]` Create `src/lib/transport.ts` — the `HiveTransport` interface:
   ```typescript
   import type { Project, Worktree, Session, Space, Setting } from '../types'

   export interface HiveTransport {
     db: {
       project: {
         getAll(): Promise<Project[]>
         get(id: string): Promise<Project | null>
         create(data: any): Promise<Project>
         update(id: string, data: any): Promise<Project | null>
         delete(id: string): Promise<boolean>
         touch(id: string): Promise<boolean>
         reorder(orderedIds: string[]): Promise<boolean>
         getByPath(path: string): Promise<Project | null>
       }
       worktree: {
         get(id: string): Promise<Worktree | null>
         getByProject(projectId: string): Promise<Worktree[]>
         getActiveByProject(projectId: string): Promise<Worktree[]>
         update(id: string, data: any): Promise<Worktree | null>
         archive(id: string): Promise<Worktree | null>
         touch(id: string): Promise<boolean>
       }
       session: {
         get(id: string): Promise<Session | null>
         getByWorktree(worktreeId: string): Promise<Session[]>
         getActiveByWorktree(worktreeId: string): Promise<Session[]>
         getByProject(projectId: string): Promise<Session[]>
         create(data: any): Promise<Session>
         update(id: string, data: any): Promise<Session | null>
         delete(id: string): Promise<boolean>
         search(input: any): Promise<any[]>
       }
       setting: {
         get(key: string): Promise<string | null>
         set(key: string, value: string): Promise<boolean>
         getAll(): Promise<{ key: string; value: string }[]>
         delete(key: string): Promise<boolean>
       }
       space: {
         getAll(): Promise<Space[]>
         create(data: any): Promise<Space>
         update(id: string, data: any): Promise<Space | null>
         delete(id: string): Promise<boolean>
       }
     }
     opencodeOps: { /* ... all opencode methods */ }
     gitOps: { /* ... all git methods */ }
     fileTreeOps: { /* ... all file tree methods */ }
     fileOps: { /* ... file read/write */ }
     scriptOps: { /* ... script methods */ }
     systemOps: { /* ... system methods */ }
   }
   ```

2. `[app]` Create `src/lib/graphql-transport.ts` — implementation wrapping Apollo Client:
   ```typescript
   import { ApolloClient } from '@apollo/client'
   import type { HiveTransport } from './transport'
   import { PROJECTS_QUERY, CREATE_PROJECT, ... } from '../graphql/operations'

   export function createGraphQLTransport(client: ApolloClient<any>): HiveTransport {
     return {
       db: {
         project: {
           async getAll() {
             const { data } = await client.query({ query: PROJECTS_QUERY })
             return data.projects
           },
           async get(id: string) {
             const { data } = await client.query({
               query: PROJECT_QUERY,
               variables: { id }
             })
             return data.project
           },
           async create(input) {
             const { data } = await client.mutate({
               mutation: CREATE_PROJECT,
               variables: { input }
             })
             return data.createProject
           },
           // ... remaining methods
         },
         // ... remaining namespaces
       },
       // ... remaining top-level namespaces
     }
   }
   ```

3. `[app]` Create transport context/provider:
   ```tsx
   // src/lib/TransportProvider.tsx
   import { createContext, useContext } from 'react'
   import type { HiveTransport } from './transport'

   const TransportContext = createContext<HiveTransport | null>(null)

   export function TransportProvider({ transport, children }) {
     return (
       <TransportContext.Provider value={transport}>
         {children}
       </TransportContext.Provider>
     )
   }

   export function useTransport(): HiveTransport {
     const transport = useContext(TransportContext)
     if (!transport) throw new Error('TransportProvider not found')
     return transport
   }
   ```

4. `[app]` Alternative: inject transport into Zustand stores at creation time (avoids React context for stores).

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 112: Connection Manager Store

**Goal:** Create the store that manages server connection state, credentials, and reconnection.

**Definition of Done:** Store manages connection lifecycle, stores credentials in Keychain, handles reconnection.

**Tasks:**

1. `[app]` Install secure storage:
   ```bash
   pnpm add react-native-keychain
   ```

2. `[app]` Create `src/stores/useConnectionManagerStore.ts`:
   ```typescript
   import { create } from 'zustand'
   import * as Keychain from 'react-native-keychain'

   type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

   interface ConnectionManagerState {
     // Connection state
     state: ConnectionState
     serverUrl: string | null
     apiKey: string | null
     certFingerprint: string | null

     // Reconnection
     reconnectAttempts: number
     maxReconnectAttempts: number

     // Actions
     setCredentials(url: string, key: string, fingerprint?: string): Promise<void>
     connect(): Promise<boolean>
     disconnect(): void
     testConnection(): Promise<{ success: boolean; error?: string }>
     clearCredentials(): Promise<void>

     // Internal
     _loadFromKeychain(): Promise<void>
     _saveToKeychain(): Promise<void>
     _startReconnection(): void
   }

   export const useConnectionManagerStore = create<ConnectionManagerState>((set, get) => ({
     state: 'disconnected',
     serverUrl: null,
     apiKey: null,
     certFingerprint: null,
     reconnectAttempts: 0,
     maxReconnectAttempts: 10,

     async setCredentials(url, key, fingerprint) {
       set({ serverUrl: url, apiKey: key, certFingerprint: fingerprint || null })
       await get()._saveToKeychain()
     },

     async connect() {
       set({ state: 'connecting' })
       try {
         const result = await get().testConnection()
         if (result.success) {
           set({ state: 'connected', reconnectAttempts: 0 })
           return true
         }
         set({ state: 'failed' })
         return false
       } catch {
         set({ state: 'failed' })
         return false
       }
     },

     disconnect() {
       set({ state: 'disconnected', reconnectAttempts: 0 })
     },

     async testConnection() {
       const { serverUrl, apiKey } = get()
       if (!serverUrl || !apiKey) return { success: false, error: 'No credentials' }

       try {
         const res = await fetch(`https://${serverUrl}/graphql`, {
           method: 'POST',
           headers: {
             'Content-Type': 'application/json',
             'Authorization': `Bearer ${apiKey}`
           },
           body: JSON.stringify({ query: '{ systemAppVersion }' })
         })
         const data = await res.json()
         if (data.data?.systemAppVersion) return { success: true }
         return { success: false, error: data.errors?.[0]?.message || 'Unknown error' }
       } catch (error) {
         return { success: false, error: error instanceof Error ? error.message : 'Connection failed' }
       }
     },

     async clearCredentials() {
       set({ serverUrl: null, apiKey: null, certFingerprint: null, state: 'disconnected' })
       await Keychain.resetGenericPassword({ service: 'hive-mobile' })
     },

     async _loadFromKeychain() {
       try {
         const creds = await Keychain.getGenericPassword({ service: 'hive-mobile' })
         if (creds) {
           const { serverUrl, apiKey, certFingerprint } = JSON.parse(creds.password)
           set({ serverUrl, apiKey, certFingerprint })
         }
       } catch {}
     },

     async _saveToKeychain() {
       const { serverUrl, apiKey, certFingerprint } = get()
       await Keychain.setGenericPassword(
         'hive-credentials',
         JSON.stringify({ serverUrl, apiKey, certFingerprint }),
         { service: 'hive-mobile' }
       )
     },

     _startReconnection() {
       const { reconnectAttempts, maxReconnectAttempts } = get()
       if (reconnectAttempts >= maxReconnectAttempts) {
         set({ state: 'disconnected' })
         return
       }

       set({ state: 'reconnecting' })
       // Exponential backoff with jitter: 1s → 30s cap
       const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
       const jitter = Math.random() * 1000

       setTimeout(async () => {
         set(s => ({ reconnectAttempts: s.reconnectAttempts + 1 }))
         const success = await get().connect()
         if (!success) get()._startReconnection()
       }, delay + jitter)
     }
   }))
   ```

3. `[app]` Load credentials on app start:
   ```typescript
   // In App.tsx or a startup hook
   useEffect(() => {
     useConnectionManagerStore.getState()._loadFromKeychain()
   }, [])
   ```

**Verification:**
```bash
pnpm tsc --noEmit
```

---

## Session 113: Pairing Screen

**Goal:** Build the pairing screen with QR code scanning and manual entry.

**Definition of Done:** User can scan QR code or manually enter server URL + API key, test connection, and proceed to main app.

**Tasks:**

1. `[app]` Install QR scanner:
   ```bash
   pnpm add expo-camera
   # or: pnpm add react-native-camera
   ```

2. `[app]` Create `src/screens/PairingScreen.tsx`:
   ```tsx
   import { View, Text, TextInput, Pressable, Alert } from 'react-native'
   import { useState } from 'react'
   import { useConnectionManagerStore } from '../stores/useConnectionManagerStore'

   export function PairingScreen({ onConnected }: { onConnected: () => void }) {
     const [serverUrl, setServerUrl] = useState('')
     const [apiKey, setApiKey] = useState('')
     const [testing, setTesting] = useState(false)
     const [showScanner, setShowScanner] = useState(false)

     const { setCredentials, testConnection, connect } = useConnectionManagerStore()

     const handleQRScan = (data: string) => {
       try {
         const payload = JSON.parse(data)
         setServerUrl(`${payload.host}:${payload.port}`)
         setApiKey(payload.key)
         setShowScanner(false)
       } catch {
         Alert.alert('Invalid QR Code', 'Could not parse pairing data')
       }
     }

     const handleConnect = async () => {
       if (!serverUrl || !apiKey) {
         Alert.alert('Missing fields', 'Enter server URL and API key')
         return
       }

       setTesting(true)
       await setCredentials(serverUrl, apiKey)
       const result = await testConnection()
       setTesting(false)

       if (result.success) {
         await connect()
         onConnected()
       } else {
         Alert.alert('Connection Failed', result.error || 'Could not connect to server')
       }
     }

     if (showScanner) {
       return <QRScannerView onScan={handleQRScan} onCancel={() => setShowScanner(false)} />
     }

     return (
       <View className="flex-1 bg-zinc-900 p-6 justify-center">
         <Text className="text-white text-2xl font-bold text-center mb-8">
           Connect to Hive
         </Text>

         <Pressable
           className="bg-blue-600 rounded-xl p-4 mb-6"
           onPress={() => setShowScanner(true)}
         >
           <Text className="text-white text-center text-lg font-semibold">
             Scan QR Code
           </Text>
         </Pressable>

         <Text className="text-zinc-500 text-center mb-4">— or enter manually —</Text>

         <Text className="text-zinc-400 text-sm mb-1">Server URL</Text>
         <TextInput
           className="bg-zinc-800 text-white p-3 rounded-lg mb-4"
           placeholder="192.168.1.100:8443"
           placeholderTextColor="#71717a"
           value={serverUrl}
           onChangeText={setServerUrl}
           autoCapitalize="none"
           autoCorrect={false}
         />

         <Text className="text-zinc-400 text-sm mb-1">API Key</Text>
         <TextInput
           className="bg-zinc-800 text-white p-3 rounded-lg mb-6"
           placeholder="hive_..."
           placeholderTextColor="#71717a"
           value={apiKey}
           onChangeText={setApiKey}
           secureTextEntry
           autoCapitalize="none"
           autoCorrect={false}
         />

         <Pressable
           className={`rounded-xl p-4 ${testing ? 'bg-zinc-700' : 'bg-green-600'}`}
           onPress={handleConnect}
           disabled={testing}
         >
           <Text className="text-white text-center text-lg font-semibold">
             {testing ? 'Testing Connection...' : 'Connect'}
           </Text>
         </Pressable>
       </View>
     )
   }
   ```

3. `[app]` Create `src/components/QRScannerView.tsx`:
   ```tsx
   import { Camera, CameraView } from 'expo-camera'
   import { View, Text, Pressable } from 'react-native'

   export function QRScannerView({ onScan, onCancel }) {
     return (
       <View className="flex-1">
         <CameraView
           className="flex-1"
           barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
           onBarcodeScanned={({ data }) => onScan(data)}
         />
         <Pressable className="absolute bottom-10 left-0 right-0 items-center" onPress={onCancel}>
           <Text className="text-white text-lg bg-zinc-800 px-6 py-3 rounded-full">Cancel</Text>
         </Pressable>
       </View>
     )
   }
   ```

4. `[app]` Wire into app root — show pairing screen when not connected:
   ```tsx
   export default function App() {
     const { state } = useConnectionManagerStore()

     if (state !== 'connected') {
       return <PairingScreen onConnected={() => {}} />
     }

     return (
       <ApolloProvider>
         <NavigationContainer>
           <TabNavigator />
         </NavigationContainer>
       </ApolloProvider>
     )
   }
   ```

5. `[app]` Test: scan a QR code from `hive --headless` output, verify connection.

**Verification:**
```bash
npx expo start --ios
# Scan QR code from headless server → connected
# Or manually enter URL + key → connected
```

---

## Summary of Files Created

```
# New repository: hive-mobile/
package.json
tsconfig.json
tailwind.config.js
babel.config.js
codegen.ts
app.json

src/
  App.tsx
  screens/
    PairingScreen.tsx
  components/
    ui/
    TestStyles.tsx
    QRScannerView.tsx
  stores/
    useConnectionManagerStore.ts
  hooks/
  lib/
    apollo.ts
    ApolloProvider.tsx
    transport.ts
    graphql-transport.ts
    TransportProvider.tsx
  graphql/
    schema/                          — Copied SDL files from server
    operations/
      projects.ts                    — Sample operations for codegen
    __generated__/
      hooks.ts                       — Codegen output
  navigation/
    types.ts
    TabNavigator.tsx
    ProjectsStack.tsx
    SessionStack.tsx
    FilesStack.tsx
    MoreStack.tsx
```

## What Comes Next

Phase 12 (Shared Logic Port, Sessions 114-120) ports all Zustand stores from the desktop app to the mobile app, replacing `window.*` calls with GraphQL transport calls.
