// ── Types ────────────────────────────────────────────────────────────
export interface ParsedTicket {
  title: string
  description: string
}

export interface ParsedPrComment {
  author: string
  file: string
  line: string
  body: string
  diffHunk: string
}

export interface ParsedFile {
  path: string
  name: string
}

export interface ParsedUserAttachments {
  tickets: ParsedTicket[]
  prComments: ParsedPrComment[]
  files: ParsedFile[]
  cleanText: string
}

// ── XML attribute un-escaping ────────────────────────────────────────
const unescapeXmlAttr = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

// ── Regex patterns ──────────────────────────────────────────────────
const TICKET_RE = /<ticket\s+title="([^"]*)">\n?([\s\S]*?)\n?<\/ticket>/g
const PR_COMMENT_RE =
  /<pr-comment\s+author="([^"]*)"\s+file="([^"]*)"\s+line="([^"]*)">\n?([\s\S]*?)\n?<\/pr-comment>/g
const ATTACHED_FILES_RE = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>/g
const FILE_RE = /<file\s+path="([^"]*)">([\s\S]*?)<\/file>/g
const DIFF_HUNK_RE = /<diff-hunk>([\s\S]*?)<\/diff-hunk>/

// ── Parser ──────────────────────────────────────────────────────────
export function parseUserMessageAttachments(content: string): ParsedUserAttachments {
  const tickets: ParsedTicket[] = []
  const prComments: ParsedPrComment[] = []
  const files: ParsedFile[] = []

  let cleaned = content

  // Extract tickets
  for (const m of content.matchAll(TICKET_RE)) {
    tickets.push({
      title: unescapeXmlAttr(m[1]),
      description: m[2].trim()
    })
  }
  cleaned = cleaned.replace(TICKET_RE, '')

  // Extract PR comments
  for (const m of content.matchAll(PR_COMMENT_RE)) {
    const rawBody = m[4]
    const diffMatch = rawBody.match(DIFF_HUNK_RE)
    const diffHunk = diffMatch ? diffMatch[1].trim() : ''
    const body = rawBody.replace(DIFF_HUNK_RE, '').trim()

    prComments.push({
      author: unescapeXmlAttr(m[1]),
      file: unescapeXmlAttr(m[2]),
      line: m[3],
      body,
      diffHunk
    })
  }
  cleaned = cleaned.replace(PR_COMMENT_RE, '')

  // Extract attached files
  for (const m of content.matchAll(ATTACHED_FILES_RE)) {
    const block = m[1]
    for (const fm of block.matchAll(FILE_RE)) {
      files.push({
        path: unescapeXmlAttr(fm[1]),
        name: fm[2].trim()
      })
    }
  }
  cleaned = cleaned.replace(ATTACHED_FILES_RE, '')

  // Collapse excessive blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

  return { tickets, prComments, files, cleanText: cleaned }
}
