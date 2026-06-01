import { getRendererRpcClient } from './rpc-client'

export type AttachmentSaveResult = {
  success: boolean
  filePath?: string
  error?: string
}

export type AttachmentDeleteResult = {
  success: boolean
  error?: string
}

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export const attachmentApi = {
  saveImage: async (buffer: ArrayBuffer, originalName: string): Promise<AttachmentSaveResult> =>
    getRendererRpcClient().request<AttachmentSaveResult>('attachmentOps.saveImage', {
      dataBase64: arrayBufferToBase64(buffer),
      originalName
    }),
  deleteImage: async (filePath: string): Promise<AttachmentDeleteResult> =>
    getRendererRpcClient().request<AttachmentDeleteResult>('attachmentOps.deleteImage', {
      filePath
    })
}
