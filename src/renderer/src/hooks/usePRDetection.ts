import { useEffect, useRef } from 'react'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

export const PR_URL_PATTERN = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
const PR_CREATION_CUE_PATTERN =
  /(created pr\s*#\d+|created pull request|pull request created|creating pull request|gh pr create)/i

interface PRCandidate {
  prNumber: number
  prUrl: string
}

function extractLastPrCandidate(
  text: string,
  options: { requireCreationCue?: boolean } = {}
): PRCandidate | null {
  if (!text) return null
  if (options.requireCreationCue && !PR_CREATION_CUE_PATTERN.test(text)) return null

  const matches = Array.from(text.matchAll(new RegExp(PR_URL_PATTERN.source, 'g')))
  const lastMatch = matches.at(-1)
  if (!lastMatch) return null

  return {
    prNumber: parseInt(lastMatch[1], 10),
    prUrl: lastMatch[0]
  }
}

function collectStringLeaves(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  out: string[]
): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }

  if (value === null || value === undefined || depth <= 0) return

  if (Array.isArray(value)) {
    value.forEach((item) => collectStringLeaves(item, seen, depth - 1, out))
    return
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return
    seen.add(value)

    Object.values(value).forEach((item) => collectStringLeaves(item, seen, depth - 1, out))
  }
}

function extractTextFromUnknown(value: unknown): string {
  const out: string[] = []
  collectStringLeaves(value, new WeakSet<object>(), 6, out)
  return out.join('\n')
}

function serializeForFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return extractTextFromUnknown(value)
  }
}

/**
 * Watches stream events for a PR session and detects when a GitHub PR URL
 * appears in assistant output. Transitions from creating → attached (DB-persisted).
 *
 * Stream detection is scoped to the specific Hive session that started PR
 * creation (event.sessionId === prCreation.sessionId). This prevents concurrent PR
 * workflows in sibling worktrees from leaking state into each other.
 *
 * We scan both text content AND tool output (the `gh pr create` command output
 * typically contains the PR URL before the assistant's text summary does).
 */
export function usePRDetection(worktreeId: string | null): void {
  const prCreation = useGitStore((s) =>
    worktreeId ? s.prCreation.get(worktreeId) : undefined
  )
  const setPrCreation = useGitStore((s) => s.setPrCreation)
  const attachPR = useGitStore((s) => s.attachPR)

  const worktreePath = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) return match.path
    }
    return null
  })

  const opencodeSessionId = useSessionStore((s) => {
    const prSessionId = prCreation?.sessionId
    if (!prSessionId) return null
    for (const sessions of s.sessionsByWorktree.values()) {
      const match = sessions.find((session) => session.id === prSessionId)
      if (match?.opencode_session_id) return match.opencode_session_id
    }
    return null
  })

  // Use refs to avoid stale closures in the stream listener
  const prCreationRef = useRef(prCreation)
  const worktreeIdRef = useRef(worktreeId)
  prCreationRef.current = prCreation
  worktreeIdRef.current = worktreeId

  // Accumulate streamed text to detect PR URLs across deltas
  const accumulatedTextRef = useRef('')
  const transcriptFingerprintsRef = useRef<string[]>([])
  const transcriptInitializedRef = useRef(false)

  useEffect(() => {
    // Only monitor when actively creating
    if (!worktreeId || !prCreation || !prCreation.creating) return

    // Reset accumulated text
    accumulatedTextRef.current = ''
    transcriptFingerprintsRef.current = []
    transcriptInitializedRef.current = false

    const maybeAttachCandidate = (candidate: PRCandidate | null): void => {
      if (!candidate) return

      const currentCreation = prCreationRef.current
      const currentWorktreeId = worktreeIdRef.current
      if (!currentCreation || !currentWorktreeId || !currentCreation.creating) return

      // Persist to DB + optimistic cache
      attachPR(currentWorktreeId, candidate.prNumber, candidate.prUrl)
      // Clear ephemeral creation state
      setPrCreation(currentWorktreeId, null)
    }

    const unsubscribe = window.opencodeOps?.onStream
      ? window.opencodeOps.onStream((event) => {
          const currentCreation = prCreationRef.current
          if (
            !currentCreation ||
            !currentCreation.creating ||
            !currentCreation.sessionId
          ) {
            return
          }

          if (event.sessionId !== currentCreation.sessionId) return

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
              maybeAttachCandidate(extractLastPrCandidate(accumulatedTextRef.current))
              return
            }

            // Check tool output (gh pr create output often contains the PR URL)
            if (part.type === 'tool') {
              const output = part.state?.output ?? part.output
              if (typeof output === 'string') {
                maybeAttachCandidate(extractLastPrCandidate(output))
              } else if (output !== undefined && output !== null) {
                maybeAttachCandidate(extractLastPrCandidate(extractTextFromUnknown(output)))
              }
            }

            return
          }

          // Fallback path: some providers may emit URL on message.updated
          if (event.type === 'message.updated') {
            const messageText =
              event.data?.message?.content ?? event.data?.content ?? event.data?.info?.content
            if (typeof messageText === 'string') {
              maybeAttachCandidate(extractLastPrCandidate(messageText))
            }
          }
        })
      : () => {}

    return unsubscribe
  }, [worktreeId, prCreation, opencodeSessionId, worktreePath, setPrCreation, attachPR])

  // Backstop: poll transcript while creating in case stream event payload shapes vary.
  useEffect(() => {
    if (
      !worktreeId ||
      !prCreation ||
      !prCreation.creating ||
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

        const messages = result.messages
        const nextFingerprints = messages.map((message) => serializeForFingerprint(message))

        if (!transcriptInitializedRef.current) {
          transcriptInitializedRef.current = true
          transcriptFingerprintsRef.current = nextFingerprints

          const latestMessage = messages.at(-1)
          maybeAttachCandidate(
            extractLastPrCandidate(extractTextFromUnknown(latestMessage), {
              requireCreationCue: true
            })
          )
          return
        }

        const previousFingerprints = transcriptFingerprintsRef.current
        transcriptFingerprintsRef.current = nextFingerprints

        const changedSegments: string[] = []
        for (let index = 0; index < messages.length; index += 1) {
          if (nextFingerprints[index] !== previousFingerprints[index]) {
            changedSegments.push(extractTextFromUnknown(messages[index]))
          }
        }

        maybeAttachCandidate(extractLastPrCandidate(changedSegments.join('\n')))
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
  }, [worktreeId, worktreePath, opencodeSessionId, prCreation, setPrCreation, attachPR])
}
