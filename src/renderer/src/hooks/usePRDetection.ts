import { useEffect, useRef } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

export const PR_URL_PATTERN = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/

/**
 * Watches stream events for a PR session and detects when a GitHub PR URL
 * appears in assistant output. Transitions PR state from 'creating' to 'created'.
 *
 * We listen to ALL stream events (not filtered by session ID) because the
 * opencode_session_id is only persisted to the database — it is never written
 * back to the Zustand session store, so we can't reliably look it up in-memory.
 *
 * This is safe because:
 * - The monitoring window is narrow (only while prInfo.state === 'creating')
 * - PR URLs are very distinctive patterns unlikely to appear in unrelated sessions
 * - Detection transitions state to 'created', ending monitoring immediately
 *
 * We scan both text content AND tool output (the `gh pr create` command output
 * typically contains the PR URL before the assistant's text summary does).
 */
export function usePRDetection(worktreeId: string | null): void {
  const prInfo = useGitStore((s) => (worktreeId ? s.prInfo.get(worktreeId) : undefined))
  const setPrState = useGitStore((s) => s.setPrState)

  const worktreePath = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) return match.path
    }
    return null
  })

  const opencodeSessionId = useSessionStore((s) => {
    const prSessionId = prInfo?.sessionId
    if (!prSessionId) return null
    for (const sessions of s.sessionsByWorktree.values()) {
      const match = sessions.find((session) => session.id === prSessionId)
      if (match?.opencode_session_id) return match.opencode_session_id
    }
    return null
  })

  // Use refs to avoid stale closures in the stream listener
  const prInfoRef = useRef(prInfo)
  const worktreeIdRef = useRef(worktreeId)
  prInfoRef.current = prInfo
  worktreeIdRef.current = worktreeId

  // Accumulate streamed text to detect PR URLs across deltas
  const accumulatedTextRef = useRef('')

  useEffect(() => {
    // Only monitor when state is 'creating'
    if (!worktreeId || !prInfo || prInfo.state !== 'creating') return

    // Reset accumulated text
    accumulatedTextRef.current = ''

    const checkForPrUrl = (text: string): void => {
      const match = text.match(PR_URL_PATTERN)
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
    }

    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          // Primary path: message part updates (SDK streams text/tool deltas here)
          if (event.type === 'message.part.updated') {
            const payload = event.data
            const part = payload?.part ?? payload
            if (!part) return

            // Check text content (assistant prose)
            if (part.type === 'text') {
              const delta = payload?.delta
              if (typeof delta === 'string' && delta.length > 0) {
                accumulatedTextRef.current += delta
              } else if (typeof part.text === 'string' && part.text.length > 0) {
                accumulatedTextRef.current = part.text
              }
              checkForPrUrl(accumulatedTextRef.current)
              return
            }

            // Check tool output (gh pr create output often contains the PR URL)
            if (part.type === 'tool') {
              const output = part.state?.output ?? part.output
              if (typeof output === 'string') {
                checkForPrUrl(output)
              } else if (output !== undefined && output !== null) {
                try {
                  checkForPrUrl(JSON.stringify(output))
                } catch {
                  // ignore non-serializable tool outputs
                }
              }
            }

            return
          }

          // Fallback path: some providers may emit URL on message.updated
          if (event.type === 'message.updated') {
            const messageText =
              event.data?.message?.content ?? event.data?.content ?? event.data?.info?.content
            if (typeof messageText === 'string') {
              checkForPrUrl(messageText)
            }
          }
        })
      : () => {}

    return unsubscribe
  }, [worktreeId, prInfo, opencodeSessionId, worktreePath, setPrState])

  // Backstop: poll transcript while creating in case stream event payload shapes vary.
  useEffect(() => {
    if (
      !worktreeId ||
      !prInfo ||
      prInfo.state !== 'creating' ||
      !worktreePath ||
      !opencodeSessionId
    ) {
      return
    }

    let cancelled = false

    const checkForPrFromTranscript = async (): Promise<void> => {
      try {
        const result = await window.opencodeOps.getMessages(worktreePath, opencodeSessionId)
        if (!result.success || !Array.isArray(result.messages) || cancelled) return

        const serialized = JSON.stringify(result.messages)
        const match = serialized.match(PR_URL_PATTERN)
        if (!match) return

        const currentPrInfo = prInfoRef.current
        const currentWorktreeId = worktreeIdRef.current
        if (!currentPrInfo || !currentWorktreeId || currentPrInfo.state !== 'creating') return

        const prNumber = parseInt(match[1], 10)
        setPrState(currentWorktreeId, {
          ...currentPrInfo,
          state: 'created',
          prNumber,
          prUrl: match[0]
        })
      } catch {
        // Non-fatal: next poll tick will retry
      }
    }

    void checkForPrFromTranscript()
    const intervalId = window.setInterval(() => {
      void checkForPrFromTranscript()
    }, 1500)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [worktreeId, worktreePath, opencodeSessionId, prInfo, setPrState])
}
