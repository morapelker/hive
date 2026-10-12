import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { openConnection, openSession } from './document-flow-navigation'

const defaultRpcClient = getRendererRpcClient()
const initialConnectionState = useConnectionStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialSessionState = useSessionStore.getState()
const initialWorktreeState = useWorktreeStore.getState()

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The database knows the session with `status`; nothing else is asked of the server. */
function sessionInDatabase(status: string): void {
  setRendererRpcClient({
    request: async <T>(method: string): Promise<T> =>
      (method === 'db.session.get' ? { id: 'session-1', status } : undefined) as T,
    subscribe: () => () => {}
  })
}

beforeEach(() => {
  sessionInDatabase('active')
})

afterEach(() => {
  vi.resetAllMocks()
  setRendererRpcClient(defaultRpcClient)
  useConnectionStore.setState(initialConnectionState, true)
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
  useSessionStore.setState(initialSessionState, true)
  useWorktreeStore.setState(initialWorktreeState, true)
})

describe('openConnection', () => {
  it('leaves the board, selects the instance and the project, and makes the instance active', () => {
    const toggleBoardView = vi.fn()
    useKanbanStore.setState({ isBoardViewActive: true, toggleBoardView } as never)
    useWorktreeStore.setState({ selectedWorktreeId: 'wt-1' } as never)

    openConnection('project-conn', 'conn-int')

    expect(toggleBoardView).toHaveBeenCalledTimes(1)
    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-int')
    expect(useProjectStore.getState().selectedProjectId).toBe('project-conn')
    expect(useSessionStore.getState().activeConnectionId).toBe('conn-int')
    // Selecting a connection clears the worktree selection, as a sidebar click does
    expect(useWorktreeStore.getState().selectedWorktreeId).toBeNull()
  })
})

describe('openSession', () => {
  it('opens a worktree session as before', () => {
    openSession('project-1', 'wt-1', 'session-1')

    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('wt-1')
    expect(useSessionStore.getState().activeWorktreeId).toBe('wt-1')
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    expect(useConnectionStore.getState().selectedConnectionId).toBeNull()
  })

  it('opens a connection session on its instance, the connection outranking a worktree', () => {
    openSession('project-conn', null, 'session-1', 'conn-a1')

    expect(useConnectionStore.getState().selectedConnectionId).toBe('conn-a1')
    expect(useSessionStore.getState().activeConnectionId).toBe('conn-a1')
    expect(useSessionStore.getState().activeWorktreeId).toBeNull()
    expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    expect(useProjectStore.getState().selectedProjectId).toBe('project-conn')
  })

  it('reopens a closed connection session on its instance, not as a worktree session', async () => {
    sessionInDatabase('completed')
    const reopenSession = vi.fn().mockResolvedValue({ success: true })
    const reopenConnectionSession = vi.fn().mockResolvedValue({ success: true })
    useSessionStore.setState({ reopenSession, reopenConnectionSession } as never)

    openSession('project-conn', null, 'session-1', 'conn-a1')
    await flush()

    expect(reopenConnectionSession).toHaveBeenCalledWith('session-1', 'conn-a1')
    expect(reopenSession).not.toHaveBeenCalled()
  })

  it('leaves an open connection session alone', async () => {
    const reopenConnectionSession = vi.fn().mockResolvedValue({ success: true })
    useSessionStore.setState({ reopenConnectionSession } as never)

    openSession('project-conn', null, 'session-1', 'conn-a1')
    await flush()

    expect(reopenConnectionSession).not.toHaveBeenCalled()
  })
})
