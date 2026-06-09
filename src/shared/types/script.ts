export interface ScriptOutputEvent {
  readonly type: 'command-start' | 'output' | 'error' | 'done' | 'long-running'
  readonly command?: string
  readonly data?: string
  readonly exitCode?: number
  readonly elapsed?: number
}
