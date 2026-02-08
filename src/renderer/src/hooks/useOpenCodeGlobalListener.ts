import { useEffect } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

/**
 * Extract text content from an OpenCode message object.
 * Handles multiple possible formats from the SDK.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextContent(message: any): string {
  // Format 1: parts array with type='text'
  if (Array.isArray(message.parts)) {
    const text = message.parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((p: any) => p.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((p: any) => p.text || p.content || '')
      .join('')
    if (text) return text
  }

  // Format 2: content as string
  if (typeof message.content === 'string') return message.content

  // Format 3: content as array of parts (Anthropic API format)
  if (Array.isArray(message.content)) {
    const text = message.content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((c: any) => c.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => c.text || '')
      .join('')
    if (text) return text
  }

  // Format 4: direct text field
  if (typeof message.text === 'string') return message.text

  return ''
}

/**
 * Extract messages array from getMessages response data.
 * The SDK might return an array directly or wrap it in an object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMessages(data: any): any[] {
  if (Array.isArray(data)) return data
  if (data?.messages && Array.isArray(data.messages)) return data.messages
  if (data?.data && Array.isArray(data.data)) return data.data
  return []
}

/**
 * Persistent global listener for OpenCode stream events.
 *
 * Handles background session completion (AI finishes while viewing another project):
 * - Updates worktree status from 'working' → 'unread'
 * - Saves the assistant response to the DB so it appears when the user switches back
 *
 * Must be called from a component that is ALWAYS mounted (AppLayout).
 * SessionView handles events for the currently active/viewed session.
 */
export function useOpenCodeGlobalListener(): void {
  useEffect(() => {
    const unsubscribe = window.opencodeOps.onStream(async (event) => {
      // Only handle session.idle — the definitive "response complete" signal
      if (event.type !== 'session.idle') return

      const sessionId = event.sessionId
      const activeId = useSessionStore.getState().activeSessionId

      // Skip if this session is currently being viewed — SessionView handles it
      if (sessionId === activeId) return

      // Update worktree status to 'unread' (clears 'working' spinner)
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'unread')

      // Try to save the assistant response that completed in the background
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = (await window.db.session.get(sessionId)) as any
        if (!session?.opencode_session_id || !session.worktree_id) return

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const worktree = (await window.db.worktree.get(session.worktree_id)) as any
        if (!worktree?.path) return

        // Check if we need to save (last DB message is from user = no response saved yet)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbMessages = (await window.db.message.getBySession(sessionId)) as any[]
        const lastMsg = dbMessages[dbMessages.length - 1]
        if (!lastMsg || lastMsg.role !== 'user') return

        // Fetch messages from OpenCode to get the completed assistant response
        const opcResult = await window.opencodeOps.getMessages(
          worktree.path,
          session.opencode_session_id
        )
        if (!opcResult.success) return

        const opcMessages = normalizeMessages(opcResult.messages)
        if (opcMessages.length === 0) return

        // Only save if the last message is from assistant (session completed its turn)
        const lastOpcMsg = opcMessages[opcMessages.length - 1]
        if (!lastOpcMsg || lastOpcMsg.role !== 'assistant') return

        const content = extractTextContent(lastOpcMsg)
        if (!content?.trim()) return

        await window.db.message.create({
          session_id: sessionId,
          role: 'assistant' as const,
          content
        })
      } catch (err) {
        console.warn('[GlobalListener] Failed to save background response:', err)
      }
    })

    return unsubscribe
  }, [])
}
