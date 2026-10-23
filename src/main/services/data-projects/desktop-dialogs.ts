// Native file dialogs for data projects, opened by Electron main on behalf of the server child
// (desktop commands `dataSaveFileDialog` / `dataOpenFileDialog`, handled in
// main/desktop/data-project-commands.ts). No timeout: a dialog waits for the user, and main
// always answers once it closes. Both resolve null when the user cancels or when no main
// process is reachable (browser / Docker server mode), so callers have one "no file" path.

import { makeDesktopCommandRequest } from '../../../shared/desktop-command'
import { processDesktopRequester, type DataDesktopCommandRequester } from './desktop-requester'

export type DataOpenDialogPurpose = 'sqlite' | 'certificate' | 'ssh-key'

const MAX_EXTENSIONS = 16

/** 'csv', '.CSV', ' json ' → 'csv', 'CSV', 'json'; drops anything that is not a plain extension. */
const normalizeExtensions = (extensions: readonly string[]): string[] => {
  const seen = new Set<string>()
  for (const raw of extensions) {
    const ext = raw.trim().replace(/^\.+/, '')
    if (/^[A-Za-z0-9]{1,16}$/.test(ext)) seen.add(ext)
    if (seen.size >= MAX_EXTENSIONS) break
  }
  return [...seen]
}

/** A file name only (no directories), capped, never empty. */
const normalizeDefaultName = (name: string): string => {
  const base = [...name.replace(/[/\\]/g, '_')]
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('')
    .trim()
  return (base || 'export').slice(0, 255)
}

const readFilePath = (value: unknown): string | null => {
  const filePath = (value as { filePath?: unknown } | null)?.filePath
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null
}

export const showDataSaveDialog = async (
  input: { defaultName: string; extensions: string[] },
  requester: DataDesktopCommandRequester = processDesktopRequester
): Promise<string | null> => {
  if (!requester.available()) return null
  const value = await requester.request(
    (id) =>
      makeDesktopCommandRequest(id, 'dataSaveFileDialog', {
        defaultName: normalizeDefaultName(input.defaultName),
        extensions: normalizeExtensions(input.extensions)
      }),
    { timeoutMs: null }
  )
  return readFilePath(value)
}

export const showDataOpenDialog = async (
  input: { purpose: DataOpenDialogPurpose; allowCreate?: boolean },
  requester: DataDesktopCommandRequester = processDesktopRequester
): Promise<string | null> => {
  if (!requester.available()) return null
  const value = await requester.request(
    (id) =>
      makeDesktopCommandRequest(id, 'dataOpenFileDialog', {
        purpose: input.purpose,
        ...(input.allowCreate ? { allowCreate: true } : {})
      }),
    { timeoutMs: null }
  )
  return readFilePath(value)
}
