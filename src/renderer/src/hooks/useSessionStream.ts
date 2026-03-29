import { useState, useEffect, useRef, useCallback } from 'react'
import { mapOpencodeMessagesToSessionViewMessages } from '@/lib/opencode-transcript'
import { appendStreamedAssistantFallback } from '@/lib/transcript-refresh'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'
import type { OpenCodeMessage, StreamingPart } from '@/components/sessions/SessionView'
import type { ToolUseInfo } from '@/components/sessions/ToolCard'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseSessionStreamParams {
  sessionId: string // The hive session ID (used to filter stream events)
  worktreePath: string // Filesystem path to the worktree
  opencodeSessionId: string // The opencode SDK session ID
}

export interface UseSessionStreamResult {
  messages: OpenCodeMessage[] // Historical messages
  streamingParts: StreamingPart[] // Current live streaming parts
  streamingContent: string // Legacy text content for backward compat
  isStreaming: boolean // Whether currently streaming
  isLoading: boolean // Initial load in progress
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionStream({
  sessionId,
  worktreePath,
  opencodeSessionId
}: UseSessionStreamParams): UseSessionStreamResult {
  // ---- State ----
  const [messages, setMessages] = useState<OpenCodeMessage[]>([])
  const [streamingParts, setStreamingParts] = useState<StreamingPart[]>([])
  const streamingPartsRef = useRef<StreamingPart[]>([])
  const [streamingContent, setStreamingContent] = useState<string>('')
  const streamingContentRef = useRef<string>('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const rafRef = useRef<number | null>(null)
  const childToSubtaskIndexRef = useRef<Map<string, number>>(new Map())
  const hasFinalizedRef = useRef(false)
  const generationRef = useRef(0)

  // ---- rAF batching helpers ----

  const flushStreamingState = useCallback(() => {
    setStreamingParts([...streamingPartsRef.current])
    setStreamingContent(streamingContentRef.current)
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        flushStreamingState()
      })
    }
  }, [flushStreamingState])

  const immediateFlush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    flushStreamingState()
  }, [flushStreamingState])

  const updateStreamingPartsRef = useCallback(
    (updater: (parts: StreamingPart[]) => StreamingPart[]) => {
      streamingPartsRef.current = updater(streamingPartsRef.current)
    },
    []
  )

  // ---- Streaming-part mutation helpers ----

  const appendTextDelta = useCallback(
    (delta: string) => {
      updateStreamingPartsRef((parts) => {
        const lastPart = parts[parts.length - 1]
        if (lastPart && lastPart.type === 'text') {
          return [...parts.slice(0, -1), { ...lastPart, text: (lastPart.text || '') + delta }]
        }
        return [...parts, { type: 'text' as const, text: delta }]
      })
      streamingContentRef.current += delta
      scheduleFlush()
    },
    [updateStreamingPartsRef, scheduleFlush]
  )

  const setTextContent = useCallback(
    (text: string) => {
      updateStreamingPartsRef((parts) => {
        const lastPart = parts[parts.length - 1]
        if (lastPart && lastPart.type === 'text') {
          return [...parts.slice(0, -1), { ...lastPart, text }]
        }
        return [...parts, { type: 'text' as const, text }]
      })
      streamingContentRef.current = text
      scheduleFlush()
    },
    [updateStreamingPartsRef, scheduleFlush]
  )

  const upsertToolUse = useCallback(
    (
      toolId: string,
      update: Partial<ToolUseInfo> & { name?: string; input?: Record<string, unknown> }
    ) => {
      updateStreamingPartsRef((parts) => {
        const existingIndex = parts.findIndex(
          (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
        )

        if (existingIndex >= 0) {
          const existing = parts[existingIndex].toolUse!
          return [
            ...parts.slice(0, existingIndex),
            {
              type: 'tool_use' as const,
              toolUse: {
                id: existing.id,
                name: update.name ?? existing.name,
                input: update.input ?? existing.input,
                status: update.status ?? existing.status,
                startTime: update.startTime ?? existing.startTime,
                endTime: update.endTime ?? existing.endTime,
                output: update.output ?? existing.output,
                error: update.error ?? existing.error,
                ...update
              }
            },
            ...parts.slice(existingIndex + 1)
          ]
        }

        const newToolUse: ToolUseInfo = {
          id: toolId,
          name: update.name ?? 'Unknown',
          input: update.input ?? {},
          status: update.status ?? 'running',
          startTime: update.startTime ?? Date.now(),
          ...update
        }
        return [...parts, { type: 'tool_use' as const, toolUse: newToolUse }]
      })
      immediateFlush()
    },
    [updateStreamingPartsRef, immediateFlush]
  )

  // ---- Reset helper ----

  const resetStreamingState = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamingPartsRef.current = []
    setStreamingParts([])
    streamingContentRef.current = ''
    setStreamingContent('')
    setIsStreaming(false)
    childToSubtaskIndexRef.current.clear()
  }, [])

  // ---- Main effect ----

  useEffect(() => {
    const currentGeneration = ++generationRef.current

    // Part A: Instantly restore streaming indicators from the global status store.
    // This provides immediate UI feedback before async message load completes.
    const storedStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
    if (storedStatus?.status === 'working' || storedStatus?.status === 'planning') {
      setIsStreaming(true)
    }

    // Simplified finalize — reload transcript from source-of-truth, fall back
    // to streamed content if the reload is empty.
    const finalizeResponse = async (): Promise<void> => {
      if (hasFinalizedRef.current) return
      hasFinalizedRef.current = true

      const streamedPartsSnapshot = [...streamingPartsRef.current]
      const streamedContentSnapshot = streamingContentRef.current

      try {
        const result = await window.opencodeOps.getMessages(worktreePath, opencodeSessionId)
        if (generationRef.current !== currentGeneration) return

        if (result.success && result.messages) {
          const refreshed = mapOpencodeMessagesToSessionViewMessages(
            result.messages as unknown[]
          )

          if (refreshed.length > 0) {
            setMessages(refreshed)
          } else if (
            streamedPartsSnapshot.length > 0 ||
            streamedContentSnapshot.length > 0
          ) {
            // Fallback: use appendStreamedAssistantFallback
            setMessages((current) =>
              appendStreamedAssistantFallback(current, {
                streamedContent: streamedContentSnapshot,
                streamedParts: streamedPartsSnapshot
              })
            )
          }
        }
      } catch (error) {
        console.error('[useSessionStream] Failed to refresh messages:', error)
      } finally {
        resetStreamingState()
      }
    }

    // Subscribe SYNCHRONOUSLY before any async work to prevent race conditions
    // where session.idle arrives during async init and is missed.
    const unsubscribe = window.opencodeOps?.onStream
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        window.opencodeOps.onStream((event: any) => {
          // Only handle events for this session
          if (event.sessionId !== sessionId) return

          // Guard: generation check — prevents stale closures
          if (generationRef.current !== currentGeneration) return

          // -----------------------------------------------------------
          // message.part.updated
          // -----------------------------------------------------------
          if (event.type === 'message.part.updated') {
            // Skip user-message echoes by role
            const role = event.data?.role || event.data?.message?.role
            if (role === 'user') return

            // Route child/subagent events into subtask cards
            if (event.childSessionId) {
              let subtaskIdx = childToSubtaskIndexRef.current.get(event.childSessionId)

              if (subtaskIdx === undefined) {
                subtaskIdx = streamingPartsRef.current.length
                updateStreamingPartsRef((parts) => [
                  ...parts,
                  {
                    type: 'subtask',
                    subtask: {
                      id: event.childSessionId!,
                      sessionID: event.childSessionId!,
                      prompt: '',
                      description: '',
                      agent: 'task',
                      parts: [],
                      status: 'running'
                    }
                  }
                ])
                childToSubtaskIndexRef.current.set(event.childSessionId, subtaskIdx)
                immediateFlush()
              }

              const childPart = event.data?.part
              if (childPart?.type === 'text') {
                updateStreamingPartsRef((parts) => {
                  const updated = [...parts]
                  const subtask = updated[subtaskIdx as number]
                  if (subtask?.type === 'subtask' && subtask.subtask) {
                    const lastPart =
                      subtask.subtask.parts[subtask.subtask.parts.length - 1]
                    if (lastPart?.type === 'text') {
                      lastPart.text =
                        (lastPart.text || '') + (event.data?.delta || childPart.text || '')
                    } else {
                      subtask.subtask.parts = [
                        ...subtask.subtask.parts,
                        { type: 'text', text: event.data?.delta || childPart.text || '' }
                      ]
                    }
                  }
                  return updated
                })
                scheduleFlush()
              } else if (childPart?.type === 'tool') {
                const state = childPart.state || childPart
                const toolId =
                  state.toolCallId || childPart.callID || childPart.id || `tool-${Date.now()}`
                updateStreamingPartsRef((parts) => {
                  const updated = [...parts]
                  const subtask = updated[subtaskIdx as number]
                  if (subtask?.type === 'subtask' && subtask.subtask) {
                    const existing = subtask.subtask.parts.find(
                      (p) => p.type === 'tool_use' && p.toolUse?.id === toolId
                    )
                    if (existing && existing.type === 'tool_use' && existing.toolUse) {
                      const statusMap: Record<string, string> = {
                        running: 'running',
                        completed: 'success',
                        error: 'error'
                      }
                      existing.toolUse.status = (statusMap[state.status] || 'running') as
                        | 'pending'
                        | 'running'
                        | 'success'
                        | 'error'
                      if (state.time?.end) existing.toolUse.endTime = state.time.end
                      if (state.status === 'completed') existing.toolUse.output = state.output
                      if (state.status === 'error') existing.toolUse.error = state.error
                    } else {
                      subtask.subtask.parts = [
                        ...subtask.subtask.parts,
                        {
                          type: 'tool_use',
                          toolUse: {
                            id: toolId,
                            name: childPart.tool || state.name || 'unknown',
                            input: state.input,
                            status: 'running',
                            startTime: state.time?.start || Date.now()
                          }
                        }
                      ]
                    }
                  }
                  return updated
                })
                immediateFlush()
              }
              setIsStreaming(true)
              return
            }

            const part = event.data?.part
            if (!part) return

            // Reset finalization flag on new content
            if (
              streamingPartsRef.current.length === 0 &&
              streamingContentRef.current.length === 0
            ) {
              hasFinalizedRef.current = false
            }

            if (part.type === 'text') {
              const delta = event.data?.delta
              if (delta) {
                appendTextDelta(delta)
              } else if (part.text) {
                setTextContent(part.text)
              }
              setIsStreaming(true)
            } else if (part.type === 'tool') {
              const toolId = part.callID || part.id || `tool-${Date.now()}`
              const toolName = part.tool || undefined
              const state = part.state || {}
              const statusMap: Record<
                string,
                'pending' | 'running' | 'success' | 'error'
              > = {
                pending: 'pending',
                running: 'running',
                completed: 'success',
                error: 'error'
              }
              upsertToolUse(toolId, {
                ...(toolName ? { name: toolName } : {}),
                ...(state.input ? { input: state.input } : {}),
                status: statusMap[state.status] || 'running',
                startTime: state.time?.start || Date.now(),
                endTime: state.time?.end,
                output: state.status === 'completed' ? state.output : undefined,
                error: state.status === 'error' ? state.error : undefined
              })
              setIsStreaming(true)
            } else if (part.type === 'subtask') {
              const subtaskIndex = streamingPartsRef.current.length
              updateStreamingPartsRef((parts) => [
                ...parts,
                {
                  type: 'subtask',
                  subtask: {
                    id: part.id || `subtask-${Date.now()}`,
                    sessionID: part.sessionID || '',
                    prompt: part.prompt || '',
                    description: part.description || '',
                    agent: part.agent || 'unknown',
                    parts: [],
                    status: 'running'
                  }
                }
              ])
              if (part.sessionID) {
                childToSubtaskIndexRef.current.set(part.sessionID, subtaskIndex)
              }
              immediateFlush()
              setIsStreaming(true)
            } else if (part.type === 'reasoning') {
              updateStreamingPartsRef((parts) => {
                const last = parts[parts.length - 1]
                if (last?.type === 'reasoning') {
                  return [
                    ...parts.slice(0, -1),
                    {
                      ...last,
                      reasoning:
                        (last.reasoning || '') + (event.data?.delta || part.text || '')
                    }
                  ]
                }
                return [
                  ...parts,
                  {
                    type: 'reasoning' as const,
                    reasoning: event.data?.delta || part.text || ''
                  }
                ]
              })
              scheduleFlush()
              setIsStreaming(true)
            } else if (part.type === 'step-start') {
              updateStreamingPartsRef((parts) => [
                ...parts,
                { type: 'step_start' as const, stepStart: { snapshot: part.snapshot } }
              ])
              immediateFlush()
              setIsStreaming(true)
            } else if (part.type === 'step-finish') {
              updateStreamingPartsRef((parts) => [
                ...parts,
                {
                  type: 'step_finish' as const,
                  stepFinish: {
                    reason: part.reason || '',
                    cost: typeof part.cost === 'number' ? part.cost : 0,
                    tokens: {
                      input:
                        typeof part.tokens?.input === 'number' ? part.tokens.input : 0,
                      output:
                        typeof part.tokens?.output === 'number' ? part.tokens.output : 0,
                      reasoning:
                        typeof part.tokens?.reasoning === 'number'
                          ? part.tokens.reasoning
                          : 0
                    }
                  }
                }
              ])
              immediateFlush()
              setIsStreaming(true)
            } else if (part.type === 'compaction') {
              updateStreamingPartsRef((parts) => [
                ...parts,
                { type: 'compaction' as const, compactionAuto: part.auto === true }
              ])
              immediateFlush()
              setIsStreaming(true)
            }
          }

          // -----------------------------------------------------------
          // session.idle
          // -----------------------------------------------------------
          else if (event.type === 'session.idle') {
            // Child session idle — update subtask status, don't finalize parent
            if (event.childSessionId) {
              const subtaskIdx = childToSubtaskIndexRef.current.get(event.childSessionId)
              if (subtaskIdx !== undefined) {
                updateStreamingPartsRef((parts) => {
                  const updated = [...parts]
                  const subtask = updated[subtaskIdx]
                  if (subtask?.type === 'subtask' && subtask.subtask) {
                    subtask.subtask.status = 'completed'
                  }
                  return updated
                })
                immediateFlush()
              }
              return
            }

            immediateFlush()
            if (!hasFinalizedRef.current) {
              void finalizeResponse()
            }
          }

          // -----------------------------------------------------------
          // session.status
          // -----------------------------------------------------------
          else if (event.type === 'session.status') {
            const status = event.statusPayload || event.data?.status
            if (!status) return

            // Skip child session status
            if (event.childSessionId) return

            if (status.type === 'busy') {
              setIsStreaming(true)
              hasFinalizedRef.current = false
            } else if (status.type === 'idle') {
              immediateFlush()
              if (!hasFinalizedRef.current) {
                void finalizeResponse()
              }
            }
          }

          // -----------------------------------------------------------
          // session.materialized — real SDK session ID replaces the
          // placeholder pending::UUID.  Update the session store so the
          // parent re-renders with the correct opencodeSessionId and
          // the next effect run fetches messages with the real ID.
          // -----------------------------------------------------------
          else if (event.type === 'session.materialized') {
            const newId = (event.data as Record<string, unknown> | undefined)?.newSessionId as string | undefined
            if (newId) {
              useSessionStore.getState().setOpenCodeSessionId(sessionId, newId)
            }
          }
        })
      : () => {}

    // ---- Async initialization: load initial messages ----
    const loadInitialMessages = async (): Promise<void> => {
      try {
        const result = await window.opencodeOps.getMessages(worktreePath, opencodeSessionId)
        if (generationRef.current !== currentGeneration) return

        if (result.success && result.messages) {
          const mapped = mapOpencodeMessagesToSessionViewMessages(
            result.messages as unknown[]
          )

          // Part B: Restore streaming parts from the last persisted assistant
          // message, but ONLY when the session is actively busy. For idle
          // sessions the completed response is already in `messages` from the
          // DB — populating the streaming overlay would cause the assistant
          // message to render twice.
          const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
          const isSessionBusy =
            currentStatus?.status === 'working' || currentStatus?.status === 'planning'

          if (isSessionBusy && mapped.length > 0) {
            const lastMsg = mapped[mapped.length - 1]
            if (lastMsg.role === 'assistant' && lastMsg.parts && lastMsg.parts.length > 0) {
              const dbParts = lastMsg.parts.map((p) => ({ ...p }))
              let restoredParts = dbParts

              // Merge: DB parts are the base, but keep any streaming parts
              // that have a tool_use with an ID not yet in the DB parts.
              // This handles tool calls that arrived during the async load.
              if (streamingPartsRef.current.length > 0) {
                const dbToolIds = new Set(
                  dbParts
                    .filter((p) => p.type === 'tool_use' && p.toolUse?.id)
                    .map((p) => p.toolUse!.id)
                )
                const extraParts = streamingPartsRef.current.filter(
                  (p) => p.type === 'tool_use' && p.toolUse?.id && !dbToolIds.has(p.toolUse.id)
                )
                restoredParts = [...dbParts, ...extraParts]
              }

              if (restoredParts.length > 0) {
                streamingPartsRef.current = restoredParts
                setStreamingParts([...restoredParts])

                const textParts = restoredParts.filter((p) => p.type === 'text')
                const content = textParts.map((p) => p.text || '').join('')
                streamingContentRef.current = content
                setStreamingContent(content)
                setIsStreaming(true)

                // Remove the last assistant message from the committed array
                // since it is now rendered as the streaming overlay.
                setMessages(mapped.slice(0, -1))
              } else {
                // Edge case: parts array was empty after merge
                streamingPartsRef.current = []
                streamingContentRef.current = ''
                setStreamingParts([])
                setStreamingContent('')
                setMessages(mapped)
              }
            } else {
              setMessages(mapped)
            }
          } else {
            setMessages(mapped)
          }
        }
      } catch (error) {
        console.error('[useSessionStream] Failed to load initial messages:', error)
      } finally {
        if (generationRef.current === currentGeneration) {
          setIsLoading(false)
        }
      }
    }

    void loadInitialMessages()

    // ---- Cleanup ----
    return () => {
      unsubscribe()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [
    sessionId,
    worktreePath,
    opencodeSessionId,
    appendTextDelta,
    setTextContent,
    upsertToolUse,
    updateStreamingPartsRef,
    immediateFlush,
    scheduleFlush,
    resetStreamingState
  ])

  return {
    messages,
    streamingParts,
    streamingContent,
    isStreaming,
    isLoading
  }
}
