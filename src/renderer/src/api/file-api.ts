import type { Envelope } from '@shared/types/ipc-envelope'
import { getDesktopBridge } from './desktop-bridge'
import { getRendererRpcClient } from './rpc-client'

type FileOpsAdapter = {
  getPathForFile: (file: File) => string
}

export type FileImageReadResult = {
  readonly data: string
  readonly mimeType?: string
}

export type FileReadResult = {
  readonly success: boolean
  readonly content?: string
  readonly error?: string
}

let fileOpsAdapterOverride: FileOpsAdapter | null = null

const toEnvelope = async <A>(request: Promise<A>): Promise<Envelope<A>> => {
  try {
    return { success: true, value: await request }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    const maybeDetails = error as Error & { details?: unknown }
    return {
      success: false,
      errorCode: error.name || 'INTERNAL_ERROR',
      error: error.message,
      ...(maybeDetails.details === undefined ? {} : { details: maybeDetails.details })
    }
  }
}

const getFileOpsAdapter = (): FileOpsAdapter => {
  if (fileOpsAdapterOverride) {
    return fileOpsAdapterOverride
  }

  const desktopBridge = getDesktopBridge()
  if (!desktopBridge?.getPathForFile) {
    throw new Error('desktopBridge.getPathForFile is unavailable')
  }
  return {
    getPathForFile: desktopBridge.getPathForFile.bind(desktopBridge)
  }
}

export const setFileOpsAdapterForTests = (adapter: FileOpsAdapter): void => {
  fileOpsAdapterOverride = adapter
}

export const resetFileOpsAdapterForTests = (): void => {
  fileOpsAdapterOverride = null
}

export const fileApi = {
  getPathForFile: (file: File): string => getFileOpsAdapter().getPathForFile(file),
  readFile: (filePath: string): Promise<Envelope<FileReadResult>> =>
    toEnvelope(getRendererRpcClient().request<FileReadResult>('fileOps.readFile', { filePath })),
  readImageAsBase64: (filePath: string): Promise<Envelope<FileImageReadResult>> =>
    toEnvelope(
      getRendererRpcClient().request<FileImageReadResult>('fileOps.readImageAsBase64', { filePath })
    ),
  writeFile: (filePath: string, content: string): Promise<Envelope<null>> =>
    toEnvelope(
      getRendererRpcClient().request<null>('fileOps.writeFile', {
        filePath,
        content
      })
    )
}
