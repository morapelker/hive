import { create } from 'zustand'
import { toast } from 'sonner'
import type {
  TelegramConnectionStatus,
  TelegramDiscoveredChat,
  TelegramForwardingStatus,
  TelegramMode
} from '@shared/types/telegram'
import { dbApi } from '@/api/db-api'
import { opencodeApi } from '@/api/opencode-api'
import { connectionApi } from '@/api/connection-api'
import { telegramApi } from '@/api/telegram-api'

interface TelegramStore {
  connectionStatus: TelegramConnectionStatus
  lastError: string | null
  activeForwardingSessionId: string | null
  activeForwardingWorktreeId: string | null
  activeForwardingConnectionId: string | null
  activeForwardingMode: TelegramMode | null
  discoveredChats: TelegramDiscoveredChat[]
  refreshing: boolean
  health: 'ok' | 'error'
  setStatus: (status: TelegramForwardingStatus) => void
  refreshStatus: () => Promise<void>
  setDiscoveredChats: (chats: TelegramDiscoveredChat[]) => void
  setRefreshing: (refreshing: boolean) => void
}

type TelegramHandoffSession = {
  project_id: string | null
  opencode_session_id: string | null
}

export const useTelegramStore = create<TelegramStore>((set) => ({
  connectionStatus: 'idle',
  lastError: null,
  activeForwardingSessionId: null,
  activeForwardingWorktreeId: null,
  activeForwardingConnectionId: null,
  activeForwardingMode: null,
  discoveredChats: [],
  refreshing: false,
  health: 'ok',

  setStatus: (status) => {
    set({
      activeForwardingSessionId: status.sessionId,
      activeForwardingWorktreeId: status.worktreeId,
      activeForwardingConnectionId: status.connectionId,
      activeForwardingMode: status.mode,
      health: status.health,
      lastError: status.lastError,
      connectionStatus: status.active ? (status.health === 'error' ? 'error' : 'connected') : 'idle'
    })
  },

  refreshStatus: async () => {
    try {
      const status = await telegramApi.getStatus()
      useTelegramStore.getState().setStatus(status)
    } catch (error) {
      set({
        connectionStatus: 'error',
        lastError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  setDiscoveredChats: (chats) => set({ discoveredChats: chats }),
  setRefreshing: (refreshing) => set({ refreshing })
}))

if (typeof window !== 'undefined') {
  setTimeout(() => {
    useTelegramStore
      .getState()
      .refreshStatus()
      .catch(() => {})
  }, 200)

  telegramApi.onStatusChanged((status) => {
    const previous = useTelegramStore.getState()
    useTelegramStore.getState().setStatus(status)
    if (status.health === 'error' && previous.health !== 'error' && status.lastError) {
      toast.error(`Telegram unreachable: ${status.lastError}`)
    }
  })

  telegramApi.onPlanImplementRequested((payload) => {
    void (async () => {
      try {
        const [
          { getEffectiveHandoffSelection },
          { useSessionStore },
          { useKanbanStore },
          { startBackgroundSessionPrompt }
        ] = await Promise.all([
          import('@/lib/handoffSelection'),
          import('./useSessionStore'),
          import('./useKanbanStore'),
          import('@/lib/backgroundSessionStart')
        ])
        const session = await dbApi.session.get<TelegramHandoffSession>(payload.sessionId)
        if (!session) {
          toast.error('Could not start Telegram plan handoff')
          return
        }

        if (payload.connectionId) {
          const connectionResult = await connectionApi.get(payload.connectionId)
          const connection = connectionResult.connection
          if (!connectionResult.success || !connection?.path) {
            toast.error('Could not start Telegram plan handoff')
            return
          }
          const sessionStore = useSessionStore.getState()
          sessionStore.setActiveConnection(payload.connectionId)
          if (session.opencode_session_id) {
            await opencodeApi.abort(connection.path, session.opencode_session_id).catch(() => {})
          }
          const selection = getEffectiveHandoffSelection({})
          const result = await sessionStore.createConnectionSession(
            payload.connectionId,
            selection.agentSdk,
            'build',
            {
              autoFocus: false,
              modelOverride: selection.model
            }
          )
          if (!result.success || !result.session) {
            toast.error(result.error ?? 'Failed to create Telegram handoff session')
            return
          }
          const handoffPrompt = `Implement the following plan\n${payload.plan}`
          await useKanbanStore
            .getState()
            .relinkTicketsForHandoff(payload.sessionId, result.session.id)
            .catch(() => {})
          const mode = useTelegramStore.getState().activeForwardingMode ?? 'questions'
          const forwarding = await telegramApi.startForwarding({
            sessionId: result.session.id,
            worktreeId: null,
            connectionId: payload.connectionId,
            mode
          })
          const forwardingMoved = forwarding.ok
          if (forwarding.ok) {
            useTelegramStore.getState().setStatus(forwarding.status)
          } else {
            toast.error(
              forwarding.error ?? 'Telegram handoff session created, but forwarding did not move'
            )
          }
          sessionStore.setActiveConnection(payload.connectionId)
          sessionStore.setActiveConnectionSession(result.session.id)
          await startBackgroundSessionPrompt({
            worktreePath: connection.path,
            sessionId: result.session.id,
            prompt: handoffPrompt,
            bumpTarget: { connectionId: payload.connectionId }
          })
          toast.success(
            forwardingMoved ? 'Telegram plan handoff started' : 'Handoff session started'
          )
          return
        }

        if (!session.project_id || !payload.worktreeId) {
          toast.error('Could not start Telegram plan handoff')
          return
        }
        const worktree = await dbApi.worktree.get(payload.worktreeId)
        if (!worktree?.path) {
          toast.error('Could not start Telegram plan handoff')
          return
        }
        useSessionStore.getState().setActiveWorktree(payload.worktreeId)
        if (session.opencode_session_id) {
          await opencodeApi.abort(worktree.path, session.opencode_session_id).catch(() => {})
        }
        const selection = getEffectiveHandoffSelection({ worktreeId: payload.worktreeId })
        const result = await useSessionStore
          .getState()
          .createSession(payload.worktreeId, session.project_id, selection.agentSdk, 'build', {
            autoFocus: false,
            modelOverride: selection.model
          })
        if (!result.success || !result.session) {
          toast.error(result.error ?? 'Failed to create Telegram handoff session')
          return
        }
        const handoffPrompt = `Implement the following plan\n${payload.plan}`
        await useKanbanStore
          .getState()
          .relinkTicketsForHandoff(payload.sessionId, result.session.id)
          .catch(() => {})
        const mode = useTelegramStore.getState().activeForwardingMode ?? 'questions'
        const forwarding = await telegramApi.startForwarding({
          sessionId: result.session.id,
          worktreeId: payload.worktreeId,
          connectionId: null,
          mode
        })
        const forwardingMoved = forwarding.ok
        if (forwarding.ok) {
          useTelegramStore.getState().setStatus(forwarding.status)
        } else {
          toast.error(
            forwarding.error ?? 'Telegram handoff session created, but forwarding did not move'
          )
        }
        await startBackgroundSessionPrompt({
          worktreePath: worktree.path,
          sessionId: result.session.id,
          prompt: handoffPrompt,
          bumpTarget: { worktreeId: payload.worktreeId }
        })
        toast.success(forwardingMoved ? 'Telegram plan handoff started' : 'Handoff session started')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Telegram handoff failed')
      }
    })()
  })
}
