import { prdFileName, tasksFileName } from '@shared/document-flow/prd-flow'
import { describeExistingPrdFlowFiles, type PrdFlowTargetResult } from '@/lib/prd-flow/target'

// What the "New PRD → orchestrator ticket" form (PrdFlowDialog) says under its fields, worked
// out apart from the dialog: the line under "Name" (the two files and where they are written,
// or why nothing can run), and the sentence for a file that is already there.

/** How long the name is left alone before its files are looked for on disk. */
export const PRD_FLOW_EXISTING_FILES_DEBOUNCE_MS = 300

export interface PrdFlowFilesLine {
  text: string
  /** The line says why "Start" is off, and is not just where the files go. */
  blocking: boolean
}

/**
 * The line under "Name". A project the flow cannot run in says why, whatever is typed; a name
 * without a letter or a digit gives no file name; otherwise the two files the session is asked
 * for, with the directory once it is known. Null while there is nothing to say yet.
 */
export function prdFlowFilesLine(input: {
  name: string
  /** `prdFlowPrefix(name)`. */
  prefix: string
  /** Where the session would run; null while that is still being worked out. */
  target: PrdFlowTargetResult | null
}): PrdFlowFilesLine | null {
  const { name, prefix, target } = input
  if (target && !target.ok) return { text: target.error, blocking: true }
  if (!prefix) {
    if (name.trim()) {
      return { text: 'The name needs at least one letter or digit.', blocking: true }
    }
    return target ? { text: `The session runs in ${target.target.cwd}`, blocking: false } : null
  }
  const files = `${prdFileName(prefix)}, then ${tasksFileName(prefix)}`
  return { text: target ? `${files}, in ${target.target.cwd}` : files, blocking: false }
}

/**
 * The sentence for documents that are already on disk under this name (the flow would take
 * them for the session's own), as `findExistingPrdFlowFiles` found them: the one file or
 * both, and the directory the first of them is in. Null when none is there. The same words
 * "Start" refuses with (lib/prd-flow/start), so the form says them before it is pressed.
 */
export function prdFlowExistingFilesError(paths: readonly string[]): string | null {
  return paths.length === 0 ? null : describeExistingPrdFlowFiles(paths)
}
