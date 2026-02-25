import type { ChildProcess } from 'child_process'

/**
 * Handle to a running LSP server process with optional initialization options.
 */
export interface LspServerHandle {
  process: ChildProcess
  initializationOptions?: Record<string, unknown>
}

/**
 * Definition for a language server — how to identify, find, and spawn it.
 */
export interface LspServerDefinition {
  /** Unique identifier for this server type (e.g. 'typescript', 'gopls') */
  id: string
  /** File extensions this server handles (e.g. ['.ts', '.tsx']) */
  extensions: string[]
  /** Files that indicate a project root (e.g. ['tsconfig.json', 'package.json']) */
  rootMarkers: string[]
  /** Spawn the server process. Returns undefined if the binary is not installed. */
  spawn: (root: string) => Promise<LspServerHandle | undefined>
}

/**
 * A position in a file — 0-based line and character.
 */
export interface LspPosition {
  file: string
  line: number
  character: number
}

/**
 * The 9 LSP operations exposed via the tool.
 */
export type LspOperation =
  | 'goToDefinition'
  | 'hover'
  | 'findReferences'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'incomingCalls'
  | 'outgoingCalls'
  | 'diagnostics'

/**
 * All supported LSP operations as a const array.
 */
export const LSP_OPERATIONS: readonly LspOperation[] = [
  'goToDefinition',
  'hover',
  'findReferences',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'incomingCalls',
  'outgoingCalls',
  'diagnostics'
] as const
