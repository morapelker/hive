import { ChevronDown, ChevronUp, ListTodo } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { PriorityBadge, StatusIcon, type TodoItem } from './tools/todoIcons'

export interface TaskListWidgetProps {
  todos: TodoItem[]
  /**
   * Distance from the top edge of the widget's positioning parent, in pixels.
   * Driven by a measurement of the PR notification stack so the widget always
   * clears its bottom edge (see usePRStackTopOffset).
   */
  topOffsetPx: number
}

export function TaskListWidget({
  todos,
  topOffsetPx
}: TaskListWidgetProps): React.JSX.Element {
  const collapsed = useSettingsStore((s) => s.taskListCollapsed)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const completed = todos.filter((t) => t.status === 'completed').length
  const total = todos.length

  return (
    <div
      data-testid="task-list-widget"
      style={{ top: `${topOffsetPx}px` }}
      className="absolute right-4 z-20 w-72 rounded-lg border border-border bg-background/95 backdrop-blur shadow-md transition-all duration-150"
    >
      {collapsed ? (
        <button
          type="button"
          data-testid="task-list-widget-toggle"
          onClick={() => updateSetting('taskListCollapsed', false)}
          className="px-3 py-2 flex items-center gap-2 cursor-pointer w-full text-left"
          aria-label="Expand task list"
        >
          <ListTodo className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium">
            {completed}/{total}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 ml-auto" />
        </button>
      ) : (
        <>
          <button
            type="button"
            data-testid="task-list-widget-toggle"
            onClick={() => updateSetting('taskListCollapsed', true)}
            className="px-3 py-2 flex items-center gap-2 cursor-pointer border-b border-border w-full text-left"
            aria-label="Collapse task list"
          >
            <span className="text-sm font-medium">Tasks</span>
            <span className="ml-auto text-sm text-muted-foreground">
              {completed}/{total}
            </span>
            <ChevronUp className="h-4 w-4 shrink-0" />
          </button>
          <div className="max-h-[60vh] overflow-y-auto p-2 space-y-0.5">
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
        </>
      )}
    </div>
  )
}
