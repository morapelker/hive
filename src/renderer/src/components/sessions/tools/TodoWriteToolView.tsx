import { useMemo } from 'react'
import { Circle, CircleCheck, CircleDot, CircleX, ListTodo } from 'lucide-react'
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

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3
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
  return (
    <span
      className={cn(
        'text-[10px] rounded px-1.5 py-0.5 font-medium shrink-0 leading-none',
        priority === 'high' && 'bg-red-500/15 text-red-500 dark:text-red-400',
        priority === 'medium' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        priority === 'low' && 'bg-muted text-muted-foreground'
      )}
    >
      {priority}
    </span>
  )
}

export function TodoWriteToolView({ input, error }: ToolViewProps) {
  const todoInput = input as unknown as TodoInput
  const todos = useMemo(() => todoInput?.todos || [], [todoInput?.todos])

  const sorted = useMemo(
    () => [...todos].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)),
    [todos]
  )

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
        {sorted.map((todo) => (
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
