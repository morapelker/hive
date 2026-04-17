import { useMemo } from 'react'
import { isTodoWriteTool } from './ToolCard'
import type { OpenCodeMessage } from './SessionView'
import type { TodoItem } from './tools/todoIcons'

export type { TodoItem }

/**
 * Scan a list of messages (and an optional streaming message) for the latest
 * `TodoWrite`-style tool_use and return its parsed todos list.
 *
 * Logic:
 *  1. If `streamingMessage` is provided and contains a TodoWrite tool_use whose
 *     `input.todos` is an array, that list wins.
 *  2. Otherwise, walk `messages` from the end to the start and return the todos
 *     from the first TodoWrite tool_use whose `input.todos` is an array.
 *  3. If nothing is found, `todos` is `null`.
 *
 * `isIncomplete` is `true` when any returned todo has a status other than
 * `completed` or `cancelled` (i.e. `pending` or `in_progress`).
 */
export function useLatestTodoList(
  messages: OpenCodeMessage[],
  streamingMessage?: OpenCodeMessage | null
): { todos: TodoItem[] | null; isIncomplete: boolean } {
  return useMemo(() => {
    const scan = (msg: OpenCodeMessage | null | undefined): TodoItem[] | null => {
      const parts = msg?.parts
      if (!parts || parts.length === 0) return null
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]
        if (part?.type !== 'tool_use') continue
        if (!isTodoWriteTool(part.toolUse?.name ?? '')) continue
        const input = part.toolUse?.input
        if (!input || !Array.isArray(input.todos)) continue
        return input.todos as TodoItem[]
      }
      return null
    }

    let found: TodoItem[] | null = null
    if (streamingMessage) {
      found = scan(streamingMessage)
    }
    if (!found) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const hit = scan(messages[i])
        if (hit) {
          found = hit
          break
        }
      }
    }

    if (!found) {
      return { todos: null, isIncomplete: false }
    }

    const isIncomplete = found.some(
      (t) => t.status !== 'completed' && t.status !== 'cancelled'
    )
    return { todos: found, isIncomplete }
  }, [messages, streamingMessage])
}
