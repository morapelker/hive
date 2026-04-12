import type { SubtaskInfo } from '@/lib/opencode-transcript'

export type ToolStatus = 'pending' | 'running' | 'success' | 'error'

export type ToolViewSubtask = SubtaskInfo

export interface ToolViewProps {
  name: string
  input: Record<string, unknown>
  output?: string
  error?: string
  status: ToolStatus
  subtasks?: ToolViewSubtask[]
}
