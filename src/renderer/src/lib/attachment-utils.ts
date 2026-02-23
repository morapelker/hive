export interface AttachmentInfo {
  type: 'jira' | 'figma'
  label: string
}

/**
 * Parse a URL and detect if it's a Jira or Figma link.
 * Returns type + label, or null if unsupported.
 */
export function parseAttachmentUrl(url: string): AttachmentInfo | null {
  try {
    const parsed = new URL(url)

    // Jira: *.atlassian.net/browse/KEY-123 or *.atlassian.net/.../KEY-123
    if (parsed.hostname.endsWith('.atlassian.net')) {
      const match = parsed.pathname.match(/\/([A-Z][A-Z0-9]+-\d+)/)
      if (match) {
        return { type: 'jira', label: match[1] }
      }
    }

    // Figma: figma.com/design/*/Name or figma.com/file/*/Name
    if (
      parsed.hostname === 'figma.com' ||
      parsed.hostname === 'www.figma.com'
    ) {
      const match = parsed.pathname.match(/\/(design|file|board|proto)\/[^/]+\/([^/?]+)/)
      if (match) {
        const name = decodeURIComponent(match[2]).replace(/-/g, ' ')
        return { type: 'figma', label: name }
      }
    }

    return null
  } catch {
    return null
  }
}
