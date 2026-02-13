import { useEffect, useRef } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'

export const PR_URL_PATTERN = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/

/**
 * Watches stream events for a PR session and detects when a GitHub PR URL
 * appears in assistant output. Transitions PR state from 'creating' to 'created'.
 *
 * Messages are not stored in a global Zustand store — they live as component-local
 * state in SessionView and are fetched from the OpenCode backend. This hook
 * subscribes to stream events directly to detect PR URLs in real-time.
 */
export function usePRDetection(worktreeId: string | null): void {
  const prInfo = useGitStore((s) => (worktreeId ? s.prInfo.get(worktreeId) : undefined))
  const setPrState = useGitStore((s) => s.setPrState)

  // Track the Hive session ID from prInfo
  const sessionId = prInfo?.sessionId

  // Find the opencode session ID for this Hive session by scanning sessionsByWorktree
  const opencodeSessionId = useSessionStore((s) => {
    if (!sessionId) return undefined
    for (const sessions of s.sessionsByWorktree.values()) {
      const session = sessions.find((sess) => sess.id === sessionId)
      if (session?.opencode_session_id) return session.opencode_session_id
    }
    return undefined
  })

  // Use refs to avoid stale closures in the stream listener
  const prInfoRef = useRef(prInfo)
  const worktreeIdRef = useRef(worktreeId)
  prInfoRef.current = prInfo
  worktreeIdRef.current = worktreeId

  // Accumulate streamed text to detect PR URLs across deltas
  const accumulatedTextRef = useRef('')

  useEffect(() => {
    // Only monitor when state is 'creating' and we have a valid session
    if (!worktreeId || !prInfo || prInfo.state !== 'creating' || !opencodeSessionId) return

    // Reset accumulated text for this session
    accumulatedTextRef.current = ''

    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          // Only process events for the PR session
          if (event.sessionId !== opencodeSessionId) return

          // Only look at text content from message parts
          if (event.type !== 'message.part.updated') return

          const part = event.data
          if (!part || part.type !== 'text') return

          // Accumulate text from deltas
          const delta = event.data?.delta
          if (delta) {
            accumulatedTextRef.current += delta
          } else if (part.text) {
            accumulatedTextRef.current = part.text
          }

          // Check accumulated text for PR URL
          const match = accumulatedTextRef.current.match(PR_URL_PATTERN)
          if (match) {
            const currentPrInfo = prInfoRef.current
            const currentWorktreeId = worktreeIdRef.current
            if (currentPrInfo && currentWorktreeId && currentPrInfo.state === 'creating') {
              const prNumber = parseInt(match[1], 10)
              setPrState(currentWorktreeId, {
                ...currentPrInfo,
                state: 'created',
                prNumber,
                prUrl: match[0]
              })
            }
          }
        })
      : () => {}

    return unsubscribe
  }, [worktreeId, prInfo, opencodeSessionId, setPrState])
}
