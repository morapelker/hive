import type { PRReviewThread } from '@shared/types/pr-comment'

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths}mo ago`
}

export function buildPRCommentPrompt(
  threads: PRReviewThread[],
  branchName: string
): string {
  if (threads.length === 0) return ''

  // Group threads by file path
  const grouped = new Map<string, PRReviewThread[]>()
  for (const t of threads) {
    const path = t.rootComment.path
    const existing = grouped.get(path) || []
    existing.push(t)
    grouped.set(path, existing)
  }

  const sections: string[] = []
  sections.push(
    `These are review comments from the PR on branch \`${branchName}\`:\n`
  )

  for (const [filePath, fileThreads] of grouped.entries()) {
    for (const thread of fileThreads) {
      const root = thread.rootComment
      const lineRef = root.line !== null ? ` (line ${root.line})` : ''
      sections.push(`## ${filePath}${lineRef}\n`)

      if (root.diff_hunk) {
        sections.push('```diff')
        sections.push(root.diff_hunk)
        sections.push('```\n')
      }

      sections.push(
        `**@${root.author_login}** (${formatRelativeTime(root.created_at)}):`
      )
      sections.push(root.body)

      for (const reply of thread.replies) {
        sections.push('')
        sections.push(
          `> **@${reply.author_login}** (${formatRelativeTime(reply.created_at)}):`
        )
        // Indent reply body lines with >
        const replyLines = reply.body.split('\n')
        sections.push(replyLines.map((line) => `> ${line}`).join('\n'))
      }

      sections.push('\n---\n')
    }
  }

  return sections.join('\n').trimEnd()
}
