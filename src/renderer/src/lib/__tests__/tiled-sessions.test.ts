import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KanbanTicket } from '../../../../main/db/types'
import { computeGridLayout, openTiledInProgressSessions } from '../tiled-sessions'

const terminalApiMocks = vi.hoisted(() => ({
  getLiveTerminalIds: vi.fn<() => Promise<string[]>>().mockResolvedValue([])
}))

vi.mock('@/api/terminal-api', () => ({
  terminalApi: terminalApiMocks
}))
import { useSessionStore, type Session } from '@/stores/useSessionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { usePinnedStore } from '@/stores/usePinnedStore'

const initialSessionState = useSessionStore.getState()
const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()
const initialPinnedState = usePinnedStore.getState()

function makeTicket(overrides: Partial<KanbanTicket>): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: 'p1',
    title: 'Ticket',
    description: null,
    attachments: [],
    column: 'in_progress',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as KanbanTicket
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    worktree_id: 'wt1',
    project_id: 'p1',
    connection_id: null,
    name: null,
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'opencode',
    mode: 'build',
    session_type: 'default',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    ...overrides
  } as Session
}

describe('computeGridLayout', () => {
  it('handles degenerate counts', () => {
    expect(computeGridLayout(0, 1600, 900)).toEqual({ cols: 1, rows: 1 })
    expect(computeGridLayout(1, 1600, 900)).toEqual({ cols: 1, rows: 1 })
  })

  it('falls back to a near-square grid when dimensions are unknown', () => {
    expect(computeGridLayout(5, 0, 0)).toEqual({ cols: 3, rows: 2 })
    expect(computeGridLayout(9, 0, 0)).toEqual({ cols: 3, rows: 3 })
  })

  it('tiles a landscape container horizontally first', () => {
    expect(computeGridLayout(2, 1600, 900)).toEqual({ cols: 2, rows: 1 })
    expect(computeGridLayout(3, 1600, 900)).toEqual({ cols: 2, rows: 2 })
    expect(computeGridLayout(4, 1600, 900)).toEqual({ cols: 2, rows: 2 })
    expect(computeGridLayout(5, 1600, 900)).toEqual({ cols: 3, rows: 2 })
    expect(computeGridLayout(6, 1600, 900)).toEqual({ cols: 3, rows: 2 })
  })

  it('tiles a portrait container vertically', () => {
    expect(computeGridLayout(2, 700, 1600)).toEqual({ cols: 1, rows: 2 })
  })

  it('never produces fewer cells than tiles', () => {
    for (let n = 1; n <= 24; n++) {
      const { cols, rows } = computeGridLayout(n, 1440, 800)
      expect(cols * rows).toBeGreaterThanOrEqual(n)
      expect(cols).toBeLessThanOrEqual(n)
    }
  })
})

describe('openTiledInProgressSessions', () => {
  afterEach(() => {
    useSessionStore.setState(initialSessionState, true)
    useKanbanStore.setState(initialKanbanState, true)
    useProjectStore.setState(initialProjectState, true)
    usePinnedStore.setState(initialPinnedState, true)
    terminalApiMocks.getLiveTerminalIds.mockClear()
    terminalApiMocks.getLiveTerminalIds.mockResolvedValue([])
  })

  it('builds a snapshot for a single-project board (no project names on tiles)', async () => {
    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'Acme' }] as never
    })
    useKanbanStore.setState({
      tickets: new Map([
        [
          'p1',
          [
            makeTicket({
              id: 't-chat',
              title: 'Chat ticket',
              current_session_id: 's-chat',
              sort_order: 0
            }),
            makeTicket({
              id: 't-cli-running',
              title: 'CLI running',
              current_session_id: 's-cli-running',
              sort_order: 1
            }),
            makeTicket({
              id: 't-cli-idle',
              title: 'CLI idle',
              current_session_id: 's-cli-idle',
              sort_order: 2
            }),
            makeTicket({ id: 't-no-session', title: 'No session', sort_order: 3 }),
            makeTicket({ id: 't-done', title: 'Done ticket', column: 'done', sort_order: 4 })
          ]
        ]
      ])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          'wt1',
          [
            makeSession({ id: 's-chat', agent_sdk: 'opencode' }),
            makeSession({ id: 's-cli-running', agent_sdk: 'claude-code-cli' }),
            makeSession({ id: 's-cli-idle', agent_sdk: 'claude-code-cli' })
          ]
        ]
      ]),
      mountedTerminalMirror: new Set(['s-cli-running'])
    })

    await openTiledInProgressSessions({ projectId: 'p1' })

    const state = useSessionStore.getState()
    expect(state.isTiledSessionsActive).toBe(true)
    expect(state.tiledSessionsTab?.scopeLabel).toBe('Acme')

    const tiles = state.tiledSessionsTab?.tiles ?? []
    expect(tiles.map((t) => t.title)).toEqual([
      'Chat ticket',
      'CLI running',
      'CLI idle',
      'No session'
    ])
    // Single-project board: no project names on tiles
    expect(tiles.every((t) => t.projectName === null)).toBe(true)

    const byTitle = new Map(tiles.map((t) => [t.title, t]))
    // Chat session: active status is enough to be running
    expect(byTitle.get('Chat ticket')?.isRunning).toBe(true)
    // Terminal-backed: running only when its view/PTY is mounted
    expect(byTitle.get('CLI running')?.isRunning).toBe(true)
    expect(byTitle.get('CLI idle')?.isRunning).toBe(false)
    expect(byTitle.get('No session')?.sessionId).toBeNull()
    expect(byTitle.get('No session')?.isRunning).toBe(false)
  })

  it('marks a terminal-backed session running when its PTY is alive in the backend but not mounted', async () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'Acme' }] as never })
    useKanbanStore.setState({
      tickets: new Map([
        [
          'p1',
          [
            makeTicket({
              id: 't-cli-bg',
              title: 'CLI background',
              current_session_id: 's-cli-bg',
              sort_order: 0
            }),
            makeTicket({
              id: 't-cli-dead',
              title: 'CLI dead',
              current_session_id: 's-cli-dead',
              sort_order: 1
            })
          ]
        ]
      ])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        [
          'wt1',
          [
            makeSession({ id: 's-cli-bg', agent_sdk: 'claude-code-cli' }),
            makeSession({ id: 's-cli-dead', agent_sdk: 'claude-code-cli' })
          ]
        ]
      ]),
      // Neither session was activated in this renderer lifetime
      mountedTerminalMirror: new Set()
    })
    // ...but the backend still holds a live PTY for one of them (e.g. window
    // reloaded while the agent kept working)
    terminalApiMocks.getLiveTerminalIds.mockResolvedValue(['s-cli-bg'])

    await openTiledInProgressSessions({ projectId: 'p1' })

    const tiles = useSessionStore.getState().tiledSessionsTab?.tiles ?? []
    const byTitle = new Map(tiles.map((t) => [t.title, t]))
    expect(byTitle.get('CLI background')?.isRunning).toBe(true)
    expect(byTitle.get('CLI dead')?.isRunning).toBe(false)
  })

  it('merges tickets sharing one session into a single tile', async () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'Acme' }] as never })
    useKanbanStore.setState({
      tickets: new Map([
        [
          'p1',
          [
            makeTicket({ id: 't1', title: 'First', current_session_id: 'shared', sort_order: 0 }),
            makeTicket({ id: 't2', title: 'Second', current_session_id: 'shared', sort_order: 1 })
          ]
        ]
      ])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([['wt1', [makeSession({ id: 'shared' })]]])
    })

    await openTiledInProgressSessions({ projectId: 'p1' })

    const tiles = useSessionStore.getState().tiledSessionsTab?.tiles ?? []
    expect(tiles).toHaveLength(1)
    expect(tiles[0].title).toBe('First · Second')
    expect(tiles[0].ticketIds).toEqual(['t1', 't2'])
  })

  it('includes project names on pinned boards', async () => {
    useProjectStore.setState({
      projects: [
        { id: 'p1', name: 'Acme' },
        { id: 'p2', name: 'Umbrella' }
      ] as never
    })
    usePinnedStore.setState({ pinnedProjectIds: new Set(['p1', 'p2']) } as never)
    useKanbanStore.setState({
      tickets: new Map([
        ['p1', [makeTicket({ id: 'a1', title: 'From Acme', current_session_id: 'sa' })]],
        [
          'p2',
          [
            makeTicket({
              id: 'b1',
              title: 'From Umbrella',
              project_id: 'p2',
              current_session_id: 'sb'
            })
          ]
        ]
      ])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['wt1', [makeSession({ id: 'sa', project_id: 'p1' })]],
        ['wt2', [makeSession({ id: 'sb', project_id: 'p2', worktree_id: 'wt2' })]]
      ])
    })

    await openTiledInProgressSessions({ projectId: '', isPinnedMode: true })

    const state = useSessionStore.getState()
    expect(state.tiledSessionsTab?.scopeLabel).toBe('Pinned')
    const tiles = state.tiledSessionsTab?.tiles ?? []
    expect(tiles).toHaveLength(2)
    const byTitle = new Map(tiles.map((t) => [t.title, t]))
    expect(byTitle.get('From Acme')?.projectName).toBe('Acme')
    expect(byTitle.get('From Umbrella')?.projectName).toBe('Umbrella')
  })

  it('marks completed sessions as not running', async () => {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'Acme' }] as never })
    useKanbanStore.setState({
      tickets: new Map([
        ['p1', [makeTicket({ id: 't1', title: 'Ended', current_session_id: 's-ended' })]]
      ])
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map([
        ['wt1', [makeSession({ id: 's-ended', status: 'completed' })]]
      ])
    })

    await openTiledInProgressSessions({ projectId: 'p1' })

    const tiles = useSessionStore.getState().tiledSessionsTab?.tiles ?? []
    expect(tiles[0].isRunning).toBe(false)
    expect(tiles[0].sessionId).toBe('s-ended')
  })
})
