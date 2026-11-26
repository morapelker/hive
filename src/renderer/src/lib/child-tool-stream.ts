import type { StreamingPart, ToolUseInfo } from '@/lib/opencode-transcript'

/** Tool state as sent on a subagent (child session) `message.part.updated` event. */
export interface ChildToolState {
  toolCallId?: string
  name?: string
  status?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  time?: { start?: number; end?: number }
}

/** A subagent's tool part. Some senders put the state fields on the part itself. */
export interface ChildToolStreamPart extends ChildToolState {
  tool?: string
  callID?: string
  id?: string
  state?: ChildToolState
}

const STATUS_MAP: Record<string, ToolUseInfo['status']> = {
  running: 'running',
  completed: 'success',
  error: 'error'
}

/**
 * Add a subagent's tool to its subtask parts, or update it if it is already there.
 *
 * A tool can arrive while still pending, before its input is known: it starts
 * with `input: {}` (every tool view reads fields off it) and the input is filled
 * in by a later event. Updates replace the tool object rather than mutating it,
 * so the memoized ToolCard re-renders.
 */
export function upsertChildToolPart(
  parts: StreamingPart[],
  childPart: ChildToolStreamPart
): StreamingPart[] {
  const state = childPart.state || childPart
  const toolId = state.toolCallId || childPart.callID || childPart.id || `tool-${Date.now()}`
  const existingIdx = parts.findIndex((p) => p.type === 'tool_use' && p.toolUse?.id === toolId)
  const existing = parts[existingIdx]

  if (!existing?.toolUse) {
    return [
      ...parts,
      {
        type: 'tool_use',
        toolUse: {
          id: toolId,
          name: childPart.tool || state.name || 'unknown',
          input: state.input ?? {},
          status: 'running',
          startTime: state.time?.start || Date.now()
        }
      }
    ]
  }

  const nextParts = [...parts]
  nextParts[existingIdx] = {
    ...existing,
    toolUse: {
      ...existing.toolUse,
      ...(state.input ? { input: state.input } : {}),
      status: STATUS_MAP[state.status ?? ''] || 'running',
      ...(state.time?.end ? { endTime: state.time.end } : {}),
      ...(state.status === 'completed' ? { output: state.output } : {}),
      ...(state.status === 'error' ? { error: state.error } : {})
    }
  }
  return nextParts
}
