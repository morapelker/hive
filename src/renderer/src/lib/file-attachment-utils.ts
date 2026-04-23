import type { Attachment } from '@/components/sessions/AttachmentPreview'
import type { MessagePart } from '@shared/types/opencode'

export const isImageMime = (mime: string): boolean => mime.startsWith('image/')

export const MAX_ATTACHMENTS = 10

/** Escape characters that would break XML attribute values */
export const escapeXmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Escape `]]>` sequences that would prematurely terminate a CDATA section */
const escapeCdata = (s: string): string => s.replace(/\]\]>/g, ']]]]><![CDATA[>')

export const buildDiffCommentsXml = (comments: DiffComment[]): string => {
  if (comments.length === 0) return ''
  const sorted = [...comments].sort((a, b) => {
    if (a.file_path < b.file_path) return -1
    if (a.file_path > b.file_path) return 1
    return a.line_start - b.line_start
  })
  const inner = sorted
    .map((c) => {
      const lines = c.line_end ? `${c.line_start}-${c.line_end}` : `${c.line_start}`
      return [
        `<diff-comment file="${escapeXmlAttr(c.file_path)}" lines="${lines}" outdated="${String(c.is_outdated)}">`,
        `<snippet><![CDATA[${escapeCdata(c.anchor_text ?? '')}]]></snippet>`,
        `<body><![CDATA[${escapeCdata(c.body)}]]></body>`,
        `</diff-comment>`
      ].join('\n')
    })
    .join('\n')
  return `<diff-comments>\n${inner}\n</diff-comments>`
}

export const buildMessageParts = (attachments: Attachment[], promptText: string, diffComments?: DiffComment[]): MessagePart[] => {
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

  if (diffComments && diffComments.length > 0) {
    const diffXml = buildDiffCommentsXml(diffComments)
    parts.push({ type: 'text', text: diffXml })
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
export const buildDisplayContent = (attachments: Attachment[], promptText: string, diffComments?: DiffComment[]): string => {
  const textParts: string[] = []

  // Data attachments (images, PDFs) -> XML blocks
  const dataAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'data' }> => a.kind === 'data'
  )
  if (dataAttachments.length > 0) {
    textParts.push(
      dataAttachments
        .map(
          (d) =>
            `<data-attachment mime="${escapeXmlAttr(d.mime)}" name="${escapeXmlAttr(d.name)}">${d.dataUrl}</data-attachment>`
        )
        .join('\n')
    )
  }

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

  if (diffComments && diffComments.length > 0) {
    textParts.push(buildDiffCommentsXml(diffComments))
  }

  // Final prompt text (already includes prContext + modePrefix if applicable)
  textParts.push(promptText)

  return textParts.join('\n')
}
