import type { Attachment } from '@/components/sessions/AttachmentPreview'
import type { MessagePart } from '@shared/types/opencode'

export const isImageMime = (mime: string): boolean => mime.startsWith('image/')

export const MAX_ATTACHMENTS = 10

/** Escape characters that would break XML attribute values */
const escapeXmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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

  // Ticket attachments -> each becomes an XML <ticket> block
  const ticketAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'ticket' }> => a.kind === 'ticket'
  )
  if (ticketAttachments.length > 0) {
    const ticketBlocks = ticketAttachments
      .map(
        (t) =>
          `<ticket title="${escapeXmlAttr(t.title)}">\n${t.description ?? ''}\n</ticket>`
      )
      .join('\n')
    parts.push({ type: 'text', text: ticketBlocks })
  }

  // Final text part
  parts.push({ type: 'text', text: promptText })

  return parts
}

/**
 * Build the full text content from attachments + prompt text.
 * Returns the concatenated string that the server will store as the message
 * content, so the optimistic UI message matches what comes back from disk.
 */
export const buildDisplayContent = (attachments: Attachment[], promptText: string): string => {
  const textParts: string[] = []

  // Path attachments -> XML block
  const pathAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'path' }> => a.kind === 'path'
  )
  if (pathAttachments.length > 0) {
    textParts.push(
      '<attached_files>\n' +
      pathAttachments.map((a) => `<file path="${a.filePath}">${a.name}</file>`).join('\n') +
      '\n</attached_files>'
    )
  }

  // Ticket attachments -> XML blocks
  const ticketAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'ticket' }> => a.kind === 'ticket'
  )
  if (ticketAttachments.length > 0) {
    textParts.push(
      ticketAttachments
        .map(
          (t) =>
            `<ticket title="${escapeXmlAttr(t.title)}">\n${t.description ?? ''}\n</ticket>`
        )
        .join('\n')
    )
  }

  // Final prompt text (already includes prContext + modePrefix if applicable)
  textParts.push(promptText)

  return textParts.join('\n')
}
