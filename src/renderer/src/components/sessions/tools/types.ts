export type ToolStatus = 'pending' | 'running' | 'success' | 'error'

export interface ToolViewProps {
  name: string
  input: Record<string, unknown>
  output?: string
  error?: string
  status: ToolStatus
}
