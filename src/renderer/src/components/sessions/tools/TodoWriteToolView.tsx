import { useMemo } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  ListTodo
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolViewProps } from './types'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

interface TodoInput {
  todos: TodoItem[]
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed':
      return <CircleCheck className="h-3.5 w-3.5 text-green-500 shrink-0" />
    case 'in_progress':
      return <CircleDot className="h-3.5 w-3.5 text-blue-500 shrink-0 animate-pulse" />
    case 'cancelled':
      return <CircleX className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
    case 'pending':
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
  }
}

function PriorityBadge({ priority }: { priority: TodoItem['priority'] }) {
  switch (priority) {
    case 'high':
      return <ChevronsUp className="h-3.5 w-3.5 text-red-500 shrink-0" />
    case 'medium':
      return <ChevronUp className="h-3.5 w-3.5 text-amber-500 shrink-0" />
    case 'low':
      return <ChevronDown className="h-3.5 w-3.5 text-blue-500 shrink-0" />
    default:
      return null
  }
}

export function TodoWriteToolView({ input, error }: ToolViewProps) {
  const todoInput = input as unknown as TodoInput
  const todos = useMemo(() => todoInput?.todos || [], [todoInput?.todos])

  const counts = useMemo(() => {
    const c = { completed: 0, in_progress: 0, pending: 0, cancelled: 0, total: todos.length }
    for (const t of todos) {
      if (t.status in c) c[t.status as keyof typeof c]++
    }
    return c
  }, [todos])

  if (todos.length === 0) {
    return (
      <div data-testid="todowrite-tool-view" className="text-xs text-muted-foreground">
        No tasks
      </div>
    )
  }

  return (
    <div data-testid="todowrite-tool-view">
      {/* Error */}
      {error && (
        <div className="mb-2">
          <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all bg-red-500/10 rounded p-2">
            {error}
          </div>
        </div>
      )}

      {/* Summary bar */}
      <div className="flex items-center gap-2 mb-2 text-[11px] text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span>
          {counts.completed}/{counts.total} completed
        </span>
        {counts.in_progress > 0 && (
          <span className="text-blue-500">{counts.in_progress} in progress</span>
        )}
        {counts.cancelled > 0 && (
          <span className="text-muted-foreground/50">{counts.cancelled} cancelled</span>
        )}
      </div>

      {/* Todo list */}
      <div className="space-y-0.5">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={cn(
              'flex items-center gap-2 py-0.5 px-1 rounded-sm text-xs',
              todo.status === 'in_progress' && 'bg-blue-500/5'
            )}
          >
            <StatusIcon status={todo.status} />
            <span
              className={cn(
                'flex-1 min-w-0 truncate',
                (todo.status === 'completed' || todo.status === 'cancelled') &&
                  'line-through text-muted-foreground/50'
              )}
            >
              {todo.content}
            </span>
            <PriorityBadge priority={todo.priority} />
          </div>
        ))}
      </div>
    </div>
  )
}
