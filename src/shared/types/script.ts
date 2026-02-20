export interface ScriptOutputEvent {
  type: 'command-start' | 'output' | 'error' | 'done'
  command?: string
  data?: string
  exitCode?: number
}
