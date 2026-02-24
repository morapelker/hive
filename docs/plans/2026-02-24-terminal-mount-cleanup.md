# Terminal Mount Cleanup — Critical Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two critical bugs in terminal session lifecycle: (1) mounted terminal IDs never shrink, causing memory leaks and stale PTYs, and (2) `setSessionModel` misses connection-scoped terminal sessions. All fixes must preserve terminal PTY state across worktree/connection switches — terminals are only destroyed on explicit tab close.

**Architecture:** Add a `closedTerminalSessionIds` set to the session store that `closeSession` populates. `MainPane` subscribes to it, prunes closed IDs from the mounted list, and acknowledges them. Also fix `setSessionModel` to search both session maps using the existing `findSessionScope` helper pattern.

**Tech Stack:** React 19, Zustand, Vitest, @testing-library/react

---

### Task 1: Add `closedTerminalSessionIds` to the session store

**Files:**
- Modify: `src/renderer/src/stores/useSessionStore.ts`

**Step 1: Write the failing test**

Create file: `test/terminal/closed-terminal-signal.test.ts`

```typescript
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from '@testing-library/react'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'

function makeTerminalSession(id: string, worktreeId: string) {
  return {
    id,
    worktree_id: worktreeId,
    project_id: 'proj-1',
    connection_id: null,
    name: id,
    status: 'active' as const,
    opencode_session_id: null,
    agent_sdk: 'terminal' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null
  }
}

describe('closedTerminalSessionIds signal', () => {
  beforeEach(() => {
    // Mock window APIs used by closeSession
    Object.defineProperty(window, 'db', {
      value: {
        session: {
          update: vi.fn().mockResolvedValue(undefined)
        }
      },
      writable: true,
      configurable: true
    })
    Object.defineProperty(window, 'terminalOps', {
      value: {
        destroy: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })

    act(() => {
      useSessionStore.setState({
        activeSessionId: 'term-1',
        activeWorktreeId: 'wt-1',
        activeConnectionId: null,
        inlineConnectionSessionId: null,
        isLoading: false,
        closedTerminalSessionIds: new Set(),
        sessionsByWorktree: new Map([
          ['wt-1', [makeTerminalSession('term-1', 'wt-1'), makeTerminalSession('term-2', 'wt-1')]]
        ]),
        sessionsByConnection: new Map(),
        tabOrderByWorktree: new Map([['wt-1', ['term-1', 'term-2']]]),
        tabOrderByConnection: new Map(),
        activeSessionByWorktree: { 'wt-1': 'term-1' },
        activeSessionByConnection: {}
      })
    })
  })

  test('closeSession adds terminal session ID to closedTerminalSessionIds', async () => {
    expect(useSessionStore.getState().closedTerminalSessionIds.size).toBe(0)

    await act(async () => {
      await useSessionStore.getState().closeSession('term-1')
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.has('term-1')).toBe(true)
  })

  test('closeSession does NOT add non-terminal session ID to closedTerminalSessionIds', async () => {
    // Replace term-1 with a non-terminal session
    act(() => {
      useSessionStore.setState({
        sessionsByWorktree: new Map([
          [
            'wt-1',
            [
              { ...makeTerminalSession('oc-1', 'wt-1'), agent_sdk: 'opencode' as const },
              makeTerminalSession('term-2', 'wt-1')
            ]
          ]
        ]),
        activeSessionId: 'oc-1',
        tabOrderByWorktree: new Map([['wt-1', ['oc-1', 'term-2']]])
      })
    })

    await act(async () => {
      await useSessionStore.getState().closeSession('oc-1')
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.size).toBe(0)
  })

  test('acknowledgeClosedTerminals removes IDs from the set', async () => {
    await act(async () => {
      await useSessionStore.getState().closeSession('term-1')
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.has('term-1')).toBe(true)

    act(() => {
      useSessionStore.getState().acknowledgeClosedTerminals(new Set(['term-1']))
    })

    expect(useSessionStore.getState().closedTerminalSessionIds.size).toBe(0)
  })
})
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/terminal/closed-terminal-signal.test.ts`
Expected: FAIL — `closedTerminalSessionIds` and `acknowledgeClosedTerminals` don't exist yet.

**Step 3: Add `closedTerminalSessionIds` state + `acknowledgeClosedTerminals` action to the store**

In `src/renderer/src/stores/useSessionStore.ts`:

1. Add to the state interface (near the other state fields):
   ```typescript
   closedTerminalSessionIds: Set<string>
   ```

2. Add to the initial state (near the other initializers):
   ```typescript
   closedTerminalSessionIds: new Set<string>(),
   ```

3. Add `acknowledgeClosedTerminals` action (near `closeSession`):
   ```typescript
   acknowledgeClosedTerminals: (ids: Set<string>) => {
     set((state) => {
       const remaining = new Set(state.closedTerminalSessionIds)
       for (const id of ids) remaining.delete(id)
       return { closedTerminalSessionIds: remaining }
     })
   },
   ```

4. In `closeSession`, inside the `set()` callback, after the terminal check and PTY destroy but inside the state update, add the signal. Add this right before the `return` of the `set()` call (around line 456):
   ```typescript
   // Signal to MainPane that this terminal should be unmounted
   const newClosedTerminals = isTerminalSession
     ? new Set([...state.closedTerminalSessionIds, sessionId])
     : state.closedTerminalSessionIds
   ```
   And include `closedTerminalSessionIds: newClosedTerminals` in the returned state object.

   **Important:** `isTerminalSession` is computed *before* the `set()` call (line 340-356), so it's available inside the closure. Pass it into the `set()` via the outer scope.

5. Exclude `closedTerminalSessionIds` from persistence. In the `partialize` config (find the `persist` options), ensure it is NOT included (it's transient state).

**Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/terminal/closed-terminal-signal.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/stores/useSessionStore.ts test/terminal/closed-terminal-signal.test.ts
git commit -m "feat: add closedTerminalSessionIds signal to session store"
```

---

### Task 2: Wire `MainPane` to prune closed terminals from mounted list

**Files:**
- Modify: `src/renderer/src/components/layout/MainPane.tsx`
- Modify: `test/terminal/main-pane-terminal-persistence.test.tsx`

**Step 1: Write the failing test**

Add to `test/terminal/main-pane-terminal-persistence.test.tsx`:

```typescript
test('removes terminal from mounted list when session is closed via store signal', () => {
  render(<MainPane />)

  // Both terminals are mounted
  expect(screen.getByTestId('session-terminal-term-1')).toBeInTheDocument()
  expect(screen.getByTestId('session-terminal-term-2')).toBeInTheDocument()

  // Simulate closeSession: remove from sessions map AND signal via closedTerminalSessionIds
  act(() => {
    useSessionStore.setState({
      activeSessionId: 'term-2',
      closedTerminalSessionIds: new Set(['term-1']),
      sessionsByWorktree: new Map([['wt-1', [makeTerminalSession('term-2')]]])
    })
  })

  // term-1 should be unmounted, term-2 should remain
  expect(screen.queryByTestId('session-terminal-term-1')).not.toBeInTheDocument()
  expect(screen.getByTestId('session-terminal-term-2')).toBeInTheDocument()
})
```

Also add to the `beforeEach` state setup:
```typescript
closedTerminalSessionIds: new Set(),
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/terminal/main-pane-terminal-persistence.test.tsx`
Expected: FAIL — term-1 still in DOM because mounted list never shrinks.

**Step 3: Wire the cleanup in MainPane**

In `src/renderer/src/components/layout/MainPane.tsx`:

1. Subscribe to `closedTerminalSessionIds`:
   ```typescript
   const closedTerminalSessionIds = useSessionStore((state) => state.closedTerminalSessionIds)
   ```

2. Import `acknowledgeClosedTerminals` is not needed — call it via `useSessionStore.getState()`.

3. Add a new `useEffect` after the existing grow-only effect (~line 89) that handles pruning:
   ```typescript
   // Prune terminals that were explicitly closed (tab close).
   // This is the ONLY path that removes from mountedTerminalSessionIds.
   useEffect(() => {
     if (closedTerminalSessionIds.size === 0) return

     setMountedTerminalSessionIds((current) => {
       const filtered = current.filter((id) => !closedTerminalSessionIds.has(id))
       return filtered.length === current.length ? current : filtered
     })

     // Acknowledge so the signal set doesn't grow forever
     useSessionStore.getState().acknowledgeClosedTerminals(closedTerminalSessionIds)
   }, [closedTerminalSessionIds])
   ```

**Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/terminal/main-pane-terminal-persistence.test.tsx`
Expected: ALL PASS (including original persistence tests — terminals still survive scope switches).

**Step 5: Run full terminal test suite**

Run: `pnpm vitest run test/terminal/`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/renderer/src/components/layout/MainPane.tsx test/terminal/main-pane-terminal-persistence.test.tsx
git commit -m "fix: prune closed terminals from mounted list via store signal"
```

---

### Task 3: Verify terminal persistence across scope switches still works

**Files:**
- Modify: `test/terminal/main-pane-terminal-persistence.test.tsx`

**Step 1: Write the test**

Add to `test/terminal/main-pane-terminal-persistence.test.tsx`:

```typescript
test('preserves terminal state across worktree switches', () => {
  render(<MainPane />)

  // Both terminals mounted in wt-1
  expect(screen.getByTestId('session-terminal-term-1')).toBeInTheDocument()
  expect(screen.getByTestId('session-terminal-term-2')).toBeInTheDocument()
  expect(terminalMounts.get('term-1')).toBe(1)

  // Switch to a different worktree with its own terminal
  act(() => {
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-2' })
    useSessionStore.setState({
      activeSessionId: 'term-3',
      activeWorktreeId: 'wt-2',
      sessionsByWorktree: new Map([
        ['wt-1', [makeTerminalSession('term-1'), makeTerminalSession('term-2')]],
        ['wt-2', [{ ...makeTerminalSession('term-3'), worktree_id: 'wt-2' }]]
      ])
    })
  })

  // term-3 is now mounted, term-1 and term-2 are still mounted (hidden)
  expect(screen.getByTestId('session-terminal-term-3')).toBeInTheDocument()
  expect(screen.getByTestId('session-terminal-term-1')).toBeInTheDocument()
  expect(screen.getByTestId('session-terminal-term-2')).toBeInTheDocument()

  // Switch back — term-1 should NOT have remounted
  act(() => {
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' })
    useSessionStore.setState({
      activeSessionId: 'term-1',
      activeWorktreeId: 'wt-1'
    })
  })

  expect(terminalMounts.get('term-1')).toBe(1) // Still 1 — never unmounted
  expect(screen.getByTestId('session-terminal-term-1').getAttribute('data-visible')).toBe('true')
})
```

**Step 2: Run the test**

Run: `pnpm vitest run test/terminal/main-pane-terminal-persistence.test.tsx`
Expected: PASS — this test should pass with the current approach since we never reset on scope switch.

**Step 3: Commit**

```bash
git add test/terminal/main-pane-terminal-persistence.test.tsx
git commit -m "test: verify terminal persistence across worktree switches"
```

---

### Task 4: Fix `setSessionModel` to search connection sessions for terminal SDK

**Files:**
- Modify: `src/renderer/src/stores/useSessionStore.ts`

**Step 1: Write the failing test**

Add to `test/terminal/closed-terminal-signal.test.ts` (reuse the same test file since it already sets up the store mocks):

```typescript
function makeConnectionTerminalSession(id: string, connectionId: string) {
  return {
    id,
    worktree_id: null,
    project_id: 'proj-1',
    connection_id: connectionId,
    name: id,
    status: 'active' as const,
    opencode_session_id: null,
    agent_sdk: 'terminal' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null
  }
}

describe('setSessionModel with connection terminal sessions', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'db', {
      value: {
        session: { update: vi.fn().mockResolvedValue(undefined) },
        worktree: { updateModel: vi.fn().mockResolvedValue(undefined) }
      },
      writable: true,
      configurable: true
    })
    Object.defineProperty(window, 'opencodeOps', {
      value: {
        setModel: vi.fn().mockResolvedValue(undefined)
      },
      writable: true,
      configurable: true
    })
    Object.defineProperty(window, 'terminalOps', {
      value: { destroy: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true
    })

    act(() => {
      useSessionStore.setState({
        activeSessionId: 'conn-term-1',
        activeWorktreeId: null,
        activeConnectionId: 'conn-1',
        inlineConnectionSessionId: null,
        isLoading: false,
        closedTerminalSessionIds: new Set(),
        sessionsByWorktree: new Map(),
        sessionsByConnection: new Map([
          ['conn-1', [makeConnectionTerminalSession('conn-term-1', 'conn-1')]]
        ]),
        tabOrderByWorktree: new Map(),
        tabOrderByConnection: new Map([['conn-1', ['conn-term-1']]]),
        activeSessionByWorktree: {},
        activeSessionByConnection: { 'conn-1': 'conn-term-1' }
      })
    })
  })

  test('does NOT call opencodeOps.setModel for connection-scoped terminal sessions', async () => {
    await act(async () => {
      await useSessionStore.getState().setSessionModel('conn-term-1', {
        providerID: 'anthropic',
        modelID: 'claude-4',
        variant: null
      })
    })

    expect(window.opencodeOps.setModel).not.toHaveBeenCalled()
  })
})
```

**Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/terminal/closed-terminal-signal.test.ts`
Expected: FAIL — `window.opencodeOps.setModel` IS called because `setSessionModel` only searches `sessionsByWorktree`.

**Step 3: Fix `setSessionModel`**

In `src/renderer/src/stores/useSessionStore.ts`, in the `setSessionModel` method (around line 770-783), replace the worktree-only search with a search of both maps:

```typescript
// Push to agent backend (SDK-aware) — skip for terminal sessions
try {
  // Find the session's SDK to route correctly (search both scopes)
  let agentSdk: 'opencode' | 'claude-code' | 'terminal' = 'opencode'
  for (const sessions of get().sessionsByWorktree.values()) {
    const found = sessions.find((s) => s.id === sessionId)
    if (found?.agent_sdk) {
      agentSdk = found.agent_sdk
      break
    }
  }
  if (agentSdk === 'opencode') {
    for (const sessions of get().sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found?.agent_sdk) {
        agentSdk = found.agent_sdk
        break
      }
    }
  }
  if (agentSdk !== 'terminal') {
    await window.opencodeOps.setModel({ ...model, agentSdk })
  }
}
```

**Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/terminal/closed-terminal-signal.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/renderer/src/stores/useSessionStore.ts test/terminal/closed-terminal-signal.test.ts
git commit -m "fix: setSessionModel searches connection sessions for terminal SDK"
```

---

### Task 5: Run full test suite and verify no regressions

**Files:** None (verification only)

**Step 1: Run all terminal tests**

Run: `pnpm vitest run test/terminal/`
Expected: ALL PASS

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS (or only pre-existing failures unrelated to our changes)

**Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS

**Step 4: Commit any lint fixes if needed**

```bash
git add -A && git commit -m "chore: lint fixes"
```
