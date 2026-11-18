import { prdFileName, tasksFileName, type PrdFlowDocument } from '@shared/document-flow/prd-flow'

// Where a flow's documents are looked for. The session runs in `cwd` and is asked for a bare
// file name, so the document is expected at the top of that directory; in a connection
// directory an agent may put it inside one of the member repositories instead, which are
// looked at next, in member order.

const SEPARATOR = /[\\/]+$/

/** `dir` and `name` joined with the separator `dir` itself uses. */
export function joinPath(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(SEPARATOR, '')}${separator}${name}`
}

export function prdFlowFileName(document: PrdFlowDocument, prefix: string): string {
  return document === 'prd' ? prdFileName(prefix) : tasksFileName(prefix)
}

/** The path the document is asked for at: the top of the session's directory. */
export function prdFlowDocumentPath(
  flow: { cwd: string; prefix: string },
  document: PrdFlowDocument
): string {
  return joinPath(flow.cwd, prdFlowFileName(document, flow.prefix))
}

/** Every path the document is looked for at, the expected one first. */
export function prdFlowDocumentCandidates(
  flow: { cwd: string; prefix: string; memberDirs: readonly string[] },
  document: PrdFlowDocument
): string[] {
  const name = prdFlowFileName(document, flow.prefix)
  return [
    joinPath(flow.cwd, name),
    ...flow.memberDirs.map((member) => joinPath(joinPath(flow.cwd, member), name))
  ]
}
