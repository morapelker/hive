# Phase 16 — Mobile Testing (Sessions 145–148)

**PRD Reference:** `docs/plans/mobileapp.md`
**Master Plan Reference:** `docs/plans/mobileapp-implementation.md`

## Phase Overview

Phase 16 is the final phase. It adds comprehensive testing at all levels (unit, component, E2E) and prepares the app for App Store and Play Store submission. This ensures the mobile app is reliable, well-tested, and ready for production use.

At the end of this phase, the entire Hive mobile app project is complete — from server infrastructure to mobile testing and release.

## Prerequisites

- Phases 11-15 completed: full-featured, polished mobile app.
- All screens, stores, hooks, and components implemented.
- Performance optimized, notifications working, offline handling robust.

## Architecture Notes

### Test Pyramid

```
         ┌───────────┐
         │  E2E (5)  │  ← Detox: full user flows
         ├───────────┤
         │Component  │  ← RNTL: screen rendering, user interactions
         │  (15-20)  │
         ├───────────┤
         │   Unit    │  ← Vitest/Jest: stores, utilities, transport
         │  (30-40)  │
         └───────────┘
```

### Mock Transport for Store Tests

All store tests use a mock transport that returns canned data. This isolates store logic from the GraphQL layer:

```typescript
// test/helpers/mock-transport.ts
export function createMockTransport(): HiveTransport {
  return {
    db: {
      project: {
        getAll: vi.fn().mockResolvedValue([
          { id: '1', name: 'Test Project', path: '/tmp/test', ... }
        ]),
        get: vi.fn().mockImplementation(id =>
          Promise.resolve(id === '1' ? mockProject : null)
        ),
        create: vi.fn().mockImplementation(data =>
          Promise.resolve({ id: 'new-1', ...data })
        ),
        // ... all methods mocked
      },
      // ... all namespaces mocked
    }
  }
}
```

### Component Test Strategy

Component tests use React Native Testing Library (RNTL) to render screens and simulate user interactions. They test:
- Screen renders correctly with mock data
- User interactions trigger expected store actions
- Loading and error states display correctly
- Navigation occurs on expected actions

### E2E Test Strategy

Detox tests run against a real headless server instance (or a mock server). They test full user flows:
- Pairing and connection
- Project browsing → session creation → prompt → streaming
- Permission approval flow
- Git operations flow
- Offline/reconnection behavior

---

## Session 145: Unit Tests — Stores

**Goal:** Unit tests for all shared stores using mock transport.

**Definition of Done:** All 13+ stores have tests for their key actions and derived state.

**Tasks:**

1. `[app]` Install test dependencies:
   ```bash
   pnpm add -D vitest @testing-library/react-native @testing-library/jest-native jest-expo
   ```

2. `[app]` Create `test/helpers/mock-transport.ts` — complete mock of `HiveTransport`:
   - All methods return predictable canned data
   - Methods are `vi.fn()` wrappers for call assertion
   - `reset()` clears all mock state

3. `[app]` Create `test/helpers/test-data.ts` — shared test fixtures:
   ```typescript
   export const mockProject = {
     id: 'proj-1',
     name: 'Test Project',
     path: '/tmp/test-project',
     language: 'typescript',
     sort_order: 0,
     created_at: '2024-01-01T00:00:00Z',
     // ... all fields
   }

   export const mockWorktree = {
     id: 'wt-1',
     project_id: 'proj-1',
     name: 'main',
     branch_name: 'main',
     path: '/tmp/test-project',
     status: 'active',
     is_default: true,
     // ... all fields
   }

   export const mockSession = {
     id: 'sess-1',
     worktree_id: 'wt-1',
     project_id: 'proj-1',
     status: 'active',
     agent_sdk: 'opencode',
     // ... all fields
   }
   ```

4. `[app]` Create `test/stores/useProjectStore.test.ts`:
   ```typescript
   import { describe, it, expect, beforeEach, vi } from 'vitest'
   import { useProjectStore } from '../../src/stores/useProjectStore'
   import { createMockTransport, setTransport } from '../helpers/mock-transport'

   describe('useProjectStore', () => {
     beforeEach(() => {
       useProjectStore.setState(useProjectStore.getInitialState())
       setTransport(createMockTransport())
     })

     it('loadProjects fetches and stores projects', async () => {
       await useProjectStore.getState().loadProjects()
       expect(useProjectStore.getState().projects).toHaveLength(2)
     })

     it('createProject adds project to store', async () => {
       await useProjectStore.getState().createProject({ name: 'New', path: '/tmp/new' })
       expect(useProjectStore.getState().projects).toContainEqual(
         expect.objectContaining({ name: 'New' })
       )
     })

     it('deleteProject removes project from store', async () => {
       await useProjectStore.getState().loadProjects()
       await useProjectStore.getState().deleteProject('proj-1')
       expect(useProjectStore.getState().projects).not.toContainEqual(
         expect.objectContaining({ id: 'proj-1' })
       )
     })

     it('selectProject sets selectedProjectId', () => {
       useProjectStore.getState().selectProject('proj-1')
       expect(useProjectStore.getState().selectedProjectId).toBe('proj-1')
     })

     it('reorderProjects updates sort order', async () => {
       await useProjectStore.getState().loadProjects()
       await useProjectStore.getState().reorderProjects(['proj-2', 'proj-1'])
       const transport = getTransport()
       expect(transport.db.project.reorder).toHaveBeenCalledWith(['proj-2', 'proj-1'])
     })
   })
   ```

5. `[app]` Create tests for all stores:

   **Store test files (each with 3-5 tests):**
   - `test/stores/useProjectStore.test.ts` — CRUD, selection, reorder
   - `test/stores/useWorktreeStore.test.ts` — CRUD, create, archive, sync
   - `test/stores/useSessionStore.test.ts` — CRUD, connect, prompt, abort, model selection (most tests ~10)
   - `test/stores/useWorktreeStatusStore.test.ts` — status updates, badge rendering
   - `test/stores/useContextStore.test.ts` — token tracking
   - `test/stores/usePermissionStore.test.ts` — add, remove, getForSession
   - `test/stores/useQuestionStore.test.ts` — add, remove, getForSession
   - `test/stores/useGitStore.test.ts` — load statuses, stage/unstage, commit
   - `test/stores/useFileTreeStore.test.ts` — scan, loadChildren
   - `test/stores/useFileViewerStore.test.ts` — loadFile, open/close tabs
   - `test/stores/useSettingsStore.test.ts` — get, set, getAll
   - `test/stores/useConnectionStore.test.ts` — CRUD, addMember
   - `test/stores/useSpaceStore.test.ts` — CRUD, assign/remove
   - `test/stores/useConnectionManagerStore.test.ts` — connection lifecycle, reconnection

6. `[app]` Create `test/lib/stream-event-handler.test.ts`:
   ```typescript
   describe('handleStreamEvent', () => {
     it('message.created updates session store', () => {
       handleStreamEvent({
         type: 'message.created',
         sessionId: 'sess-1',
         data: { id: 'msg-1', role: 'assistant', content: 'Hello' }
       })
       expect(useSessionStore.getState().getMessages('sess-1')).toContainEqual(
         expect.objectContaining({ id: 'msg-1' })
       )
     })

     it('permission.requested adds to permission store', () => {
       handleStreamEvent({
         type: 'permission.requested',
         sessionId: 'sess-1',
         data: { id: 'perm-1', permission: 'file_read', tool: 'read' }
       })
       expect(usePermissionStore.getState().getForSession('sess-1')).toBeTruthy()
     })

     it('session.completed updates status store', () => {
       handleStreamEvent({
         type: 'session.completed',
         sessionId: 'sess-1',
         data: {}
       })
       expect(useWorktreeStatusStore.getState().getStatus('wt-1')).toBe('completed')
     })
   })
   ```

7. `[app]` Run all store tests:

**Verification:**
```bash
pnpm vitest run test/stores/ test/lib/
```

---

## Session 146: Component Tests

**Goal:** Component tests for key screens using React Native Testing Library.

**Definition of Done:** All critical screens have render and interaction tests.

**Tasks:**

1. `[app]` Install RNTL:
   ```bash
   pnpm add -D @testing-library/react-native @testing-library/jest-native
   ```

2. `[app]` Create test wrapper with providers:
   ```typescript
   // test/helpers/render.tsx
   import { render } from '@testing-library/react-native'
   import { NavigationContainer } from '@react-navigation/native'
   import { TransportProvider } from '../../src/lib/TransportProvider'
   import { createMockTransport } from './mock-transport'

   export function renderWithProviders(component: React.ReactElement) {
     return render(
       <TransportProvider transport={createMockTransport()}>
         <NavigationContainer>
           {component}
         </NavigationContainer>
       </TransportProvider>
     )
   }
   ```

3. `[app]` Create `test/screens/ProjectBrowserScreen.test.tsx`:
   ```typescript
   import { screen, waitFor, fireEvent } from '@testing-library/react-native'
   import { renderWithProviders } from '../helpers/render'
   import { ProjectBrowserScreen } from '../../src/screens/ProjectBrowserScreen'

   describe('ProjectBrowserScreen', () => {
     it('renders project list', async () => {
       renderWithProviders(<ProjectBrowserScreen navigation={mockNavigation} />)
       await waitFor(() => {
         expect(screen.getByText('Test Project')).toBeTruthy()
       })
     })

     it('renders worktrees under projects', async () => {
       renderWithProviders(<ProjectBrowserScreen navigation={mockNavigation} />)
       await waitFor(() => {
         expect(screen.getByText('main')).toBeTruthy()
       })
     })

     it('navigates to worktree detail on tap', async () => {
       renderWithProviders(<ProjectBrowserScreen navigation={mockNavigation} />)
       await waitFor(() => {
         fireEvent.press(screen.getByText('main'))
         expect(mockNavigation.navigate).toHaveBeenCalledWith('WorktreeDetail', { worktreeId: 'wt-1' })
       })
     })

     it('shows status badges', async () => {
       // Set up a worktree with 'permission' status
       useWorktreeStatusStore.getState().update('sess-1', 'permission')
       renderWithProviders(<ProjectBrowserScreen navigation={mockNavigation} />)
       await waitFor(() => {
         expect(screen.getByTestId('status-badge-permission')).toBeTruthy()
       })
     })
   })
   ```

4. `[app]` Create component tests for key screens:

   **Screen tests:**
   - `test/screens/ProjectBrowserScreen.test.tsx` — renders, navigation, badges
   - `test/screens/WorktreeDetailScreen.test.tsx` — worktree info, session list, new session
   - `test/screens/SessionViewScreen.test.tsx` — messages render, input works, streaming indicator
   - `test/screens/PairingScreen.test.tsx` — manual entry, connect button, error handling
   - `test/screens/GitChangesScreen.test.tsx` — staged/unstaged sections render
   - `test/screens/FileTreeScreen.test.tsx` — tree renders, expand/collapse
   - `test/screens/SettingsScreen.test.tsx` — settings render, disconnect button

   **Component tests:**
   - `test/components/PermissionBanner.test.tsx` — renders, Allow/Deny work
   - `test/components/QuestionBanner.test.tsx` — renders, options work
   - `test/components/PlanApprovalModal.test.tsx` — renders markdown, approve/reject
   - `test/components/ModelSelector.test.tsx` — renders models, selection works
   - `test/components/ToolCard.test.tsx` — collapsed/expanded rendering
   - `test/components/OfflineBanner.test.tsx` — shows/hides based on connection state
   - `test/components/InputArea.test.tsx` — send/abort button states

5. `[app]` Run all component tests:

**Verification:**
```bash
pnpm vitest run test/screens/ test/components/
```

---

## Session 147: E2E Tests

**Goal:** End-to-end tests with Detox covering critical user flows.

**Definition of Done:** 5+ E2E tests covering pairing, browsing, AI session, git, and offline flows.

**Tasks:**

1. `[app]` Install Detox:
   ```bash
   pnpm add -D detox @types/detox jest-circus
   ```

2. `[app]` Configure Detox in `package.json` or `.detoxrc.js`:
   ```javascript
   module.exports = {
     testRunner: { args: { $0: 'jest', config: 'e2e/jest.config.js' } },
     apps: {
       'ios.debug': {
         type: 'ios.app',
         binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/HiveMobile.app',
         build: 'xcodebuild ...',
       }
     },
     devices: {
       simulator: { type: 'ios.simulator', device: { type: 'iPhone 15' } }
     },
     configurations: {
       'ios.sim.debug': { device: 'simulator', app: 'ios.debug' }
     }
   }
   ```

3. `[app]` Create `e2e/pairing.test.ts`:
   ```typescript
   describe('Pairing Flow', () => {
     beforeAll(async () => {
       await device.launchApp({ newInstance: true })
     })

     it('shows pairing screen on first launch', async () => {
       await expect(element(by.text('Connect to Hive'))).toBeVisible()
     })

     it('can enter server URL and API key manually', async () => {
       await element(by.placeholder('192.168.1.100:8443')).typeText(testServerUrl)
       await element(by.placeholder('hive_...')).typeText(testApiKey)
       await element(by.text('Connect')).tap()

       // Should transition to main app
       await waitFor(element(by.text('Projects'))).toBeVisible().withTimeout(10000)
     })
   })
   ```

4. `[app]` Create `e2e/project-browsing.test.ts`:
   ```typescript
   describe('Project Browsing', () => {
     beforeAll(async () => {
       await device.launchApp()
       // Assume already paired
     })

     it('shows projects on home screen', async () => {
       await waitFor(element(by.text('Test Project'))).toBeVisible().withTimeout(5000)
     })

     it('navigates to worktree detail', async () => {
       await element(by.text('main')).tap()
       await expect(element(by.text('main'))).toBeVisible() // Branch name
       await expect(element(by.text('New Session'))).toBeVisible()
     })
   })
   ```

5. `[app]` Create `e2e/ai-session.test.ts`:
   ```typescript
   describe('AI Session', () => {
     it('creates and runs a session', async () => {
       // Navigate to worktree
       await element(by.text('main')).tap()
       // Create new session
       await element(by.text('New Session')).tap()
       // Type prompt
       await element(by.placeholder('Send a message...')).typeText('Hello, what files are in this project?')
       // Send
       await element(by.id('send-button')).tap()
       // Wait for response
       await waitFor(element(by.id('assistant-message'))).toBeVisible().withTimeout(30000)
     })

     it('shows streaming indicator during response', async () => {
       await element(by.placeholder('Send a message...')).typeText('List the top 3 files')
       await element(by.id('send-button')).tap()
       // Abort button should appear during streaming
       await waitFor(element(by.id('abort-button'))).toBeVisible().withTimeout(5000)
     })
   })
   ```

6. `[app]` Create `e2e/git-operations.test.ts`:
   ```typescript
   describe('Git Operations', () => {
     it('shows git changes', async () => {
       // Navigate to Files tab
       await element(by.text('Files')).tap()
       // Switch to Changes view
       await element(by.text('Changes')).tap()
       // Should show changed files (if any)
       await waitFor(element(by.id('git-changes-list'))).toBeVisible().withTimeout(5000)
     })
   })
   ```

7. `[app]` Create `e2e/offline.test.ts`:
   ```typescript
   describe('Offline Behavior', () => {
     it('shows offline banner when disconnected', async () => {
       // Simulate network disconnect
       await device.setURLBlacklist(['.*'])
       await waitFor(element(by.text('Disconnected from server'))).toBeVisible().withTimeout(10000)

       // Restore network
       await device.setURLBlacklist([])
       await waitFor(element(by.text('Disconnected from server'))).not.toBeVisible().withTimeout(30000)
     })
   })
   ```

8. `[app]` Run E2E tests:

**Verification:**
```bash
# Start headless server first:
# hive --headless --port 8443

# Build app for testing:
detox build --configuration ios.sim.debug

# Run E2E tests:
detox test --configuration ios.sim.debug
```

---

## Session 148: App Store Preparation

**Goal:** Prepare the app for iOS App Store and Google Play Store submission.

**Definition of Done:** App icons, splash screen, metadata complete. Build configurations ready. App can be built for release.

**Tasks:**

1. `[app]` Create app icon set:
   - Design app icon (Hive logo adapted for mobile)
   - Generate all required sizes:
     - iOS: 1024x1024 (App Store), 180x180 (iPhone @3x), 120x120 (iPhone @2x), etc.
     - Android: 512x512 (Play Store), adaptive icon layers, various DPIs
   - Place icons in `assets/` directory

2. `[app]` Create splash screen:
   - Hive logo on dark background
   - Configure in `app.json` (Expo) or native config files
   ```json
   {
     "expo": {
       "splash": {
         "image": "./assets/splash.png",
         "resizeMode": "contain",
         "backgroundColor": "#18181b"
       }
     }
   }
   ```

3. `[app]` Configure app metadata:
   ```json
   {
     "expo": {
       "name": "Hive",
       "slug": "hive-mobile",
       "version": "1.0.0",
       "ios": {
         "bundleIdentifier": "com.hive.mobile",
         "buildNumber": "1",
         "supportsTablet": true,
         "infoPlist": {
           "NSCameraUsageDescription": "Scan QR code to connect to Hive server",
           "NSLocalNetworkUsageDescription": "Connect to Hive server on your local network"
         }
       },
       "android": {
         "package": "com.hive.mobile",
         "versionCode": 1,
         "permissions": ["CAMERA", "INTERNET"]
       }
     }
   }
   ```

4. `[app]` Prepare App Store description:
   ```
   Hive Mobile — Remote control for your AI development environment.

   Control Hive from your phone:
   • Browse projects and worktrees
   • Start and monitor AI coding sessions
   • Approve permissions and review plans on the go
   • View files with syntax highlighting
   • Manage git operations (stage, commit, push)
   • Run terminal commands remotely

   Requires a running Hive desktop app with headless mode enabled.
   ```

5. `[app]` Prepare screenshots (5-10 per platform):
   - Project browser
   - AI session with streaming
   - Permission approval
   - File viewer
   - Git changes
   - QR code pairing

6. `[app]` Configure build for release:
   ```bash
   # iOS
   eas build --platform ios --profile production

   # Android
   eas build --platform android --profile production
   ```

7. `[app]` Create release checklist:
   - [ ] All unit tests pass (`pnpm test`)
   - [ ] All component tests pass
   - [ ] All E2E tests pass (against a test headless server)
   - [ ] App icon and splash screen display correctly
   - [ ] Pairing flow works (QR + manual)
   - [ ] AI session flow works end-to-end
   - [ ] Permissions/questions/plans flow works
   - [ ] File browsing and viewing works
   - [ ] Git operations work
   - [ ] Terminal works
   - [ ] Settings work
   - [ ] Offline mode shows banner, reconnects automatically
   - [ ] Push notifications work (background)
   - [ ] Deep linking from notifications works
   - [ ] Actionable notifications work (approve/deny)
   - [ ] No memory leaks during long sessions
   - [ ] 60fps during AI streaming
   - [ ] App size reasonable (< 50MB)
   - [ ] No sensitive data in app bundle
   - [ ] Privacy policy URL configured
   - [ ] Support email configured

**Verification:**
```bash
# Run all tests:
pnpm test
pnpm vitest run test/
detox test --configuration ios.sim.debug

# Build for release:
eas build --platform ios --profile production
eas build --platform android --profile production
```

---

## Summary of Files Created

```
test/
  helpers/
    mock-transport.ts               — Complete HiveTransport mock
    test-data.ts                    — Shared test fixtures
    render.tsx                      — Test wrapper with providers
  stores/
    useProjectStore.test.ts
    useWorktreeStore.test.ts
    useSessionStore.test.ts
    useWorktreeStatusStore.test.ts
    useContextStore.test.ts
    usePermissionStore.test.ts
    useQuestionStore.test.ts
    useGitStore.test.ts
    useFileTreeStore.test.ts
    useFileViewerStore.test.ts
    useSettingsStore.test.ts
    useConnectionStore.test.ts
    useSpaceStore.test.ts
    useConnectionManagerStore.test.ts
  lib/
    stream-event-handler.test.ts
  screens/
    ProjectBrowserScreen.test.tsx
    WorktreeDetailScreen.test.tsx
    SessionViewScreen.test.tsx
    PairingScreen.test.tsx
    GitChangesScreen.test.tsx
    FileTreeScreen.test.tsx
    SettingsScreen.test.tsx
  components/
    PermissionBanner.test.tsx
    QuestionBanner.test.tsx
    PlanApprovalModal.test.tsx
    ModelSelector.test.tsx
    ToolCard.test.tsx
    OfflineBanner.test.tsx
    InputArea.test.tsx

e2e/
  jest.config.js
  pairing.test.ts
  project-browsing.test.ts
  ai-session.test.ts
  git-operations.test.ts
  offline.test.ts

assets/
  icon.png                          — App icon
  splash.png                        — Splash screen
  adaptive-icon.png                 — Android adaptive icon
```

## Summary of Files Modified

| File | Change |
|------|--------|
| `package.json` | Add test scripts, Detox config |
| `app.json` | App metadata, icons, splash |
| `.detoxrc.js` | Detox configuration |

## Project Complete

All 16 phases (148 sessions) are now documented:

- **Phases 1-10** (server, this repo): Foundation, SDL Schema, Server Core, DB Resolvers, Operation Resolvers, OpenCode AI Resolvers, Script/Terminal/Logging Resolvers, Subscriptions, Security & Operations, Server Testing
- **Phases 11-16** (mobile app, separate repo): React Native Foundation, Shared Logic Port, Mobile Core Screens, Mobile Feature Screens, Mobile Polish, Mobile Testing

The Hive headless server exposes the full desktop app capability via GraphQL, and the React Native mobile app provides feature-complete remote control.
