// src/main/services/ticket-providers/adf-to-markdown.ts
//
// Lightweight Atlassian Document Format (ADF) → Markdown converter.
// Used to convert Jira issue descriptions returned by the REST API v3.

interface AdfNode {
  type: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
  text?: string
  marks?: AdfMark[]
}

interface AdfMark {
  type: string
  attrs?: Record<string, unknown>
}

// ── Inline marks ─────────────────────────────────────────────────────────────

function applyMarks(text: string, marks: AdfMark[] | undefined): string {
  if (!marks || marks.length === 0) return text

  let result = text
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong':
        result = `**${result}**`
        break
      case 'em':
        result = `*${result}*`
        break
      case 'code':
        result = `\`${result}\``
        break
      case 'strike':
        result = `~~${result}~~`
        break
      case 'link': {
        const href = mark.attrs?.href ?? ''
        result = `[${result}](${href})`
        break
      }
      // unknown marks are ignored — text passes through unchanged
    }
  }
  return result
}

// ── Node converter ────────────────────────────────────────────────────────────

function convertNode(node: AdfNode, listDepth = 0): string {
  switch (node.type) {
    case 'doc':
      return convertChildren(node.content, listDepth).trimEnd()

    case 'paragraph':
      return convertChildren(node.content, listDepth) + '\n\n'

    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1
      const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6))
      return `${hashes} ${convertChildren(node.content, listDepth)}\n\n`
    }

    case 'bulletList': {
      const items = (node.content ?? []).map((item) => convertListItem(item, '-', listDepth))
      return items.join('') + (listDepth === 0 ? '\n' : '')
    }

    case 'orderedList': {
      const items = (node.content ?? []).map((item, i) =>
        convertListItem(item, `${i + 1}.`, listDepth)
      )
      return items.join('') + (listDepth === 0 ? '\n' : '')
    }

    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      const code = extractText(node)
      return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`
    }

    case 'blockquote': {
      const inner = convertChildren(node.content, listDepth).trimEnd()
      const quoted = inner
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      return `${quoted}\n\n`
    }

    case 'rule':
      return '---\n\n'

    case 'text':
      return applyMarks(node.text ?? '', node.marks)

    case 'hardBreak':
      return '\n'

    default:
      // Unknown node: recursively extract any text content as fallback
      return convertChildren(node.content, listDepth)
  }
}

function convertListItem(item: AdfNode, prefix: string, depth: number): string {
  const indent = '  '.repeat(depth)
  const children = item.content ?? []

  // The first block-level child is rendered inline with the bullet/number.
  // Subsequent children (nested lists, extra paragraphs) are rendered below.
  if (children.length === 0) return `${indent}${prefix} \n`

  const [first, ...rest] = children

  // Render the first child's inline content (strip trailing newlines)
  let firstText: string
  if (first.type === 'paragraph') {
    firstText = convertChildren(first.content, depth).replace(/\n+$/, '')
  } else {
    firstText = convertNode(first, depth).replace(/\n+$/, '')
  }

  let result = `${indent}${prefix} ${firstText}\n`

  for (const child of rest) {
    if (child.type === 'bulletList' || child.type === 'orderedList') {
      result += convertNode(child, depth + 1)
    } else {
      // Additional paragraphs inside a list item
      const text = convertChildren(child.content, depth).replace(/\n+$/, '')
      if (text) result += `${indent}  ${text}\n`
    }
  }

  return result
}

function convertChildren(nodes: AdfNode[] | undefined, listDepth: number): string {
  if (!nodes || nodes.length === 0) return ''
  return nodes.map((n) => convertNode(n, listDepth)).join('')
}

// Recursively extract raw text from a node (used for code blocks and fallback)
function extractText(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (!node.content) return ''
  return node.content.map(extractText).join('')
}

// ── Public API ────────────────────────────────────────────────────────────────

export function adfToMarkdown(adf: unknown): string {
  if (adf === null || adf === undefined) return ''

  // Accept plain strings unchanged (e.g. already-plain descriptions)
  if (typeof adf === 'string') return adf

  if (typeof adf !== 'object') return ''

  const node = adf as AdfNode
  if (node.type !== 'doc') {
    // If we receive a non-doc node, wrap it and try anyway
    return convertNode({ type: 'doc', content: [node] })
  }

  return convertNode(node)
}
