import type { Attachment } from '@/components/sessions/AttachmentPreview'
import type { MessagePart } from '@shared/types/opencode'

export const isImageMime = (mime: string): boolean => mime.startsWith('image/')

export const MAX_ATTACHMENTS = 10

export const buildMessageParts = (attachments: Attachment[], promptText: string): MessagePart[] => {
  const parts: MessagePart[] = []

  // Data attachments (images, PDFs) -> file parts
  for (const a of attachments) {
    if (a.kind === 'data') {
      parts.push({ type: 'file', mime: a.mime, url: a.dataUrl, filename: a.name })
    }
  }

  // Path attachments -> collected into single XML text block
  const pathAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'path' }> => a.kind === 'path'
  )
  if (pathAttachments.length > 0) {
    const xmlBlock =
      '<attached_files>\n' +
      pathAttachments.map((a) => `<file path="${a.filePath}">${a.name}</file>`).join('\n') +
      '\n</attached_files>'
    parts.push({ type: 'text', text: xmlBlock })
  }

  // Final text part
  parts.push({ type: 'text', text: promptText })

  return parts
}
