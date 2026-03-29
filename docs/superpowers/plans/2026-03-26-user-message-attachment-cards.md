# User Message Attachment Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse XML tags (`<ticket>`, `<pr-comment>`, `<attached_files>`) from user message content and render them as visual cards above the user message bubble, instead of showing raw XML text.

**Architecture:** A pure parser function extracts structured attachment data from raw message text, returning typed objects and the remaining clean text. The `UserBubble` component receives these parsed attachments as a new prop and renders read-only cards above the text bubble using the same visual language as the existing input-area attachment previews.

**Tech Stack:** React, TypeScript, Vitest, Tailwind CSS, lucide-react icons

---

## File Structure

| File | Responsibility |
|------|---------------|
| Create: `src/renderer/src/lib/parse-user-message-attachments.ts` | Pure function: regex-parse XML tags from raw text, return typed attachment objects + clean text |
| Create: `src/renderer/src/components/sessions/UserMessageAttachmentCards.tsx` | Read-only card rendering for parsed ticket / PR comment / file attachments |
| Modify: `src/renderer/src/components/sessions/UserBubble.tsx` | Accept parsed attachments prop, render `UserMessageAttachmentCards` above text |
| Modify: `src/renderer/src/components/sessions/MessageRenderer.tsx` | Call parser on `displayContent`, pass results to `UserBubble` |
| Create: `test/user-message-attachments/parse-user-message-attachments.test.ts` | Unit tests for the parser |
| Create: `test/user-message-attachments/user-message-attachment-cards.test.tsx` | Component tests for the cards |

---

### Task 1: Parser — `parseUserMessageAttachments`

**Files:**
- Create: `src/renderer/src/lib/parse-user-message-attachments.ts`
- Create: `test/user-message-attachments/parse-user-message-attachments.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/user-message-attachments/parse-user-message-attachments.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { parseUserMessageAttachments } from '@/lib/parse-user-message-attachments'

describe('parseUserMessageAttachments', () => {
  test('returns empty arrays and original text when no XML tags present', () => {
    const result = parseUserMessageAttachments('hello world')
    expect(result).toEqual({
      tickets: [],
      prComments: [],
      files: [],
      cleanText: 'hello world'
    })
  })

  test('extracts a single <ticket> tag', () => {
    const input = '<ticket title="mul_1240">\nadd another function - mul_1240 which accepts x and returns x * 1240\n</ticket>\nwhat does the ticket want us to do?'
    const result = parseUserMessageAttachments(input)

    expect(result.tickets).toEqual([
      { title: 'mul_1240', description: 'add another function - mul_1240 which accepts x and returns x * 1240' }
    ])
    expect(result.cleanText.trim()).toBe('what does the ticket want us to do?')
  })

  test('extracts multiple <ticket> tags', () => {
    const input = '<ticket title="auth">\nlogin flow\n</ticket>\n<ticket title="dashboard">\nbuild dashboard\n</ticket>\nwork on these'
    const result = parseUserMessageAttachments(input)

    expect(result.tickets).toHaveLength(2)
    expect(result.tickets[0].title).toBe('auth')
    expect(result.tickets[1].title).toBe('dashboard')
    expect(result.cleanText.trim()).toBe('work on these')
  })

  test('handles XML-escaped title attributes', () => {
    const input = '<ticket title="fix &amp; improve &lt;auth&gt;">\ndescription\n</ticket>\ndo it'
    const result = parseUserMessageAttachments(input)

    expect(result.tickets[0].title).toBe('fix & improve <auth>')
    expect(result.cleanText.trim()).toBe('do it')
  })

  test('extracts a single <pr-comment> tag', () => {
    const input = '<pr-comment author="octocat" file="src/auth.ts" line="42">\nThis needs error handling\n<diff-hunk>@@ -40,3 +40,5 @@\n+const user = getUser()\n</diff-hunk>\n</pr-comment>\nplease fix this'
    const result = parseUserMessageAttachments(input)

    expect(result.prComments).toEqual([
      {
        author: 'octocat',
        file: 'src/auth.ts',
        line: '42',
        body: 'This needs error handling',
        diffHunk: '@@ -40,3 +40,5 @@\n+const user = getUser()'
      }
    ])
    expect(result.cleanText.trim()).toBe('please fix this')
  })

  test('extracts <pr-comment> with file-level line', () => {
    const input = '<pr-comment author="dev" file="README.md" line="file-level">\nUpdate docs\n<diff-hunk>some diff</diff-hunk>\n</pr-comment>\ncheck this'
    const result = parseUserMessageAttachments(input)

    expect(result.prComments[0].line).toBe('file-level')
    expect(result.cleanText.trim()).toBe('check this')
  })

  test('extracts <attached_files> block with multiple files', () => {
    const input = '<attached_files>\n<file path="/src/utils.ts">utils.ts</file>\n<file path="/src/index.ts">index.ts</file>\n</attached_files>\nreview these files'
    const result = parseUserMessageAttachments(input)

    expect(result.files).toEqual([
      { path: '/src/utils.ts', name: 'utils.ts' },
      { path: '/src/index.ts', name: 'index.ts' }
    ])
    expect(result.cleanText.trim()).toBe('review these files')
  })

  test('extracts all three tag types in one message', () => {
    const input = [
      '<pr-comment author="alice" file="api.ts" line="10">\nfix this\n<diff-hunk>diff</diff-hunk>\n</pr-comment>',
      '<ticket title="bug_fix">\nfix the login bug\n</ticket>',
      '<attached_files>\n<file path="/f.ts">f.ts</file>\n</attached_files>',
      'please handle all of these'
    ].join('\n')
    const result = parseUserMessageAttachments(input)

    expect(result.tickets).toHaveLength(1)
    expect(result.prComments).toHaveLength(1)
    expect(result.files).toHaveLength(1)
    expect(result.cleanText.trim()).toBe('please handle all of these')
  })

  test('preserves text between tags', () => {
    const input = 'before\n<ticket title="t1">\ndesc\n</ticket>\nmiddle\n<ticket title="t2">\ndesc2\n</ticket>\nafter'
    const result = parseUserMessageAttachments(input)

    expect(result.tickets).toHaveLength(2)
    expect(result.cleanText).toContain('before')
    expect(result.cleanText).toContain('middle')
    expect(result.cleanText).toContain('after')
  })

  test('trims body and description whitespace', () => {
    const input = '<ticket title="t1">\n  spaced description  \n</ticket>\nquestion'
    const result = parseUserMessageAttachments(input)

    expect(result.tickets[0].description).toBe('spaced description')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/user-message-attachments/parse-user-message-attachments.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the parser**

Create `src/renderer/src/lib/parse-user-message-attachments.ts`:

```ts
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
// Match: <ticket title="...">...content...</ticket>
const TICKET_RE = /<ticket\s+title="([^"]*)">\n?([\s\S]*?)\n?<\/ticket>/g

// Match: <pr-comment author="..." file="..." line="...">...body...<diff-hunk>...diff...</diff-hunk>...</pr-comment>
const PR_COMMENT_RE =
  /<pr-comment\s+author="([^"]*)"\s+file="([^"]*)"\s+line="([^"]*)">\n?([\s\S]*?)\n?<\/pr-comment>/g

// Match: <attached_files>...<file path="...">name</file>...</attached_files>
const ATTACHED_FILES_RE = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>/g

// Match individual <file path="...">name</file> within attached_files
const FILE_RE = /<file\s+path="([^"]*)">([\s\S]*?)<\/file>/g

// Match diff-hunk within a pr-comment body
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/user-message-attachments/parse-user-message-attachments.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/parse-user-message-attachments.ts test/user-message-attachments/parse-user-message-attachments.test.ts
git commit -m "feat: add parseUserMessageAttachments utility to extract XML tags from user messages"
```

---

### Task 2: Card component — `UserMessageAttachmentCards`

**Files:**
- Create: `src/renderer/src/components/sessions/UserMessageAttachmentCards.tsx`
- Create: `test/user-message-attachments/user-message-attachment-cards.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `test/user-message-attachments/user-message-attachment-cards.test.tsx`:

```tsx
import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UserMessageAttachmentCards } from '@/components/sessions/UserMessageAttachmentCards'
import type { ParsedTicket, ParsedPrComment, ParsedFile } from '@/lib/parse-user-message-attachments'

describe('UserMessageAttachmentCards', () => {
  test('renders nothing when all arrays are empty', () => {
    const { container } = render(
      <UserMessageAttachmentCards tickets={[]} prComments={[]} files={[]} />
    )
    expect(container.firstChild).toBeNull()
  })

  test('renders a ticket card with title and description', () => {
    const tickets: ParsedTicket[] = [
      { title: 'mul_1240', description: 'add mul_1240 function' }
    ]
    render(<UserMessageAttachmentCards tickets={tickets} prComments={[]} files={[]} />)

    expect(screen.getByTestId('parsed-ticket-card')).toBeTruthy()
    expect(screen.getByText('mul_1240')).toBeTruthy()
    expect(screen.getByText('add mul_1240 function')).toBeTruthy()
  })

  test('renders a pr-comment card with author, file, line, and body', () => {
    const prComments: ParsedPrComment[] = [
      { author: 'octocat', file: 'src/auth.ts', line: '42', body: 'Needs error handling', diffHunk: '' }
    ]
    render(<UserMessageAttachmentCards tickets={[]} prComments={prComments} files={[]} />)

    expect(screen.getByTestId('parsed-pr-comment-card')).toBeTruthy()
    expect(screen.getByText('octocat')).toBeTruthy()
    expect(screen.getByText('auth.ts:42')).toBeTruthy()
    expect(screen.getByText('Needs error handling')).toBeTruthy()
  })

  test('renders file-level pr-comment without line number', () => {
    const prComments: ParsedPrComment[] = [
      { author: 'dev', file: 'README.md', line: 'file-level', body: 'Update docs', diffHunk: '' }
    ]
    render(<UserMessageAttachmentCards tickets={[]} prComments={prComments} files={[]} />)

    expect(screen.getByText('README.md')).toBeTruthy()
  })

  test('renders file attachment cards with path', () => {
    const files: ParsedFile[] = [
      { path: '/src/utils.ts', name: 'utils.ts' },
      { path: '/src/index.ts', name: 'index.ts' }
    ]
    render(<UserMessageAttachmentCards tickets={[]} prComments={[]} files={files} />)

    const cards = screen.getAllByTestId('parsed-file-card')
    expect(cards).toHaveLength(2)
    expect(screen.getByText('utils.ts')).toBeTruthy()
    expect(screen.getByText('index.ts')).toBeTruthy()
  })

  test('renders mixed attachment types together', () => {
    const tickets: ParsedTicket[] = [{ title: 't1', description: 'd1' }]
    const prComments: ParsedPrComment[] = [
      { author: 'a', file: 'f.ts', line: '1', body: 'b', diffHunk: '' }
    ]
    const files: ParsedFile[] = [{ path: '/p.ts', name: 'p.ts' }]

    render(<UserMessageAttachmentCards tickets={tickets} prComments={prComments} files={files} />)

    expect(screen.getByTestId('parsed-ticket-card')).toBeTruthy()
    expect(screen.getByTestId('parsed-pr-comment-card')).toBeTruthy()
    expect(screen.getByTestId('parsed-file-card')).toBeTruthy()
  })

  test('truncates long descriptions at 120 chars', () => {
    const longDesc = 'A'.repeat(150)
    const tickets: ParsedTicket[] = [{ title: 't', description: longDesc }]
    render(<UserMessageAttachmentCards tickets={tickets} prComments={[]} files={[]} />)

    const descEl = screen.getByTestId('parsed-ticket-description')
    expect(descEl.textContent).toBe('A'.repeat(120) + '...')
  })

  test('truncates long pr-comment body at 80 chars', () => {
    const longBody = 'B'.repeat(100)
    const prComments: ParsedPrComment[] = [
      { author: 'a', file: 'f.ts', line: '1', body: longBody, diffHunk: '' }
    ]
    render(<UserMessageAttachmentCards tickets={[]} prComments={prComments} files={[]} />)

    const bodyEl = screen.getByTestId('parsed-pr-comment-body')
    expect(bodyEl.textContent).toBe('B'.repeat(80) + '...')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/user-message-attachments/user-message-attachment-cards.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the card component**

Create `src/renderer/src/components/sessions/UserMessageAttachmentCards.tsx`:

```tsx
import { KanbanSquare, Github, FileText } from 'lucide-react'
import type { ParsedTicket, ParsedPrComment, ParsedFile } from '@/lib/parse-user-message-attachments'

interface UserMessageAttachmentCardsProps {
  tickets: ParsedTicket[]
  prComments: ParsedPrComment[]
  files: ParsedFile[]
}

export function UserMessageAttachmentCards({
  tickets,
  prComments,
  files
}: UserMessageAttachmentCardsProps): React.JSX.Element | null {
  if (tickets.length === 0 && prComments.length === 0 && files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 justify-end mb-2">
      {tickets.map((t, i) => (
        <div
          key={`ticket-${i}`}
          className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
          data-testid="parsed-ticket-card"
        >
          <div className="flex items-center gap-2">
            <KanbanSquare className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            <span className="font-medium text-foreground truncate">{t.title}</span>
          </div>
          {t.description && (
            <span
              className="text-xs text-muted-foreground line-clamp-2"
              data-testid="parsed-ticket-description"
            >
              {t.description.length > 120 ? t.description.slice(0, 120) + '...' : t.description}
            </span>
          )}
        </div>
      ))}

      {prComments.map((c, i) => {
        const fileName = c.file.split('/').pop() ?? c.file
        const lineLabel = c.line === 'file-level' ? '' : `:${c.line}`
        return (
          <div
            key={`pr-${i}`}
            className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px] min-w-[220px]"
            data-testid="parsed-pr-comment-card"
          >
            <div className="flex items-center gap-2">
              <Github className="h-3.5 w-3.5 shrink-0 text-foreground" />
              <span className="font-medium text-foreground truncate">{c.author}</span>
            </div>
            <span className="text-xs text-muted-foreground truncate">
              {fileName}{lineLabel}
            </span>
            {c.body && (
              <span
                className="text-xs text-muted-foreground line-clamp-2"
                data-testid="parsed-pr-comment-body"
              >
                {c.body.length > 80 ? c.body.slice(0, 80) + '...' : c.body}
              </span>
            )}
          </div>
        )
      })}

      {files.map((f, i) => (
        <div
          key={`file-${i}`}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border text-sm max-w-[400px]"
          data-testid="parsed-file-card"
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-foreground truncate">{f.name}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/user-message-attachments/user-message-attachment-cards.test.tsx`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/sessions/UserMessageAttachmentCards.tsx test/user-message-attachments/user-message-attachment-cards.test.tsx
git commit -m "feat: add UserMessageAttachmentCards component for read-only attachment cards"
```

---

### Task 3: Wire into `UserBubble` and `MessageRenderer`

**Files:**
- Modify: `src/renderer/src/components/sessions/UserBubble.tsx`
- Modify: `src/renderer/src/components/sessions/MessageRenderer.tsx`

- [ ] **Step 1: Update `UserBubble` to accept and render parsed attachments**

Modify `src/renderer/src/components/sessions/UserBubble.tsx` — the full updated file:

```tsx
import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { parseUserMessageAttachments } from '@/lib/parse-user-message-attachments'
import { UserMessageAttachmentCards } from './UserMessageAttachmentCards'

interface UserBubbleProps {
  content: string
  timestamp: string
  isPlanMode?: boolean
  isAskMode?: boolean
}

export const UserBubble = memo(function UserBubble({ content, isPlanMode, isAskMode }: UserBubbleProps): React.JSX.Element {
  const { tickets, prComments, files, cleanText } = useMemo(
    () => parseUserMessageAttachments(content),
    [content]
  )

  const hasAttachments = tickets.length > 0 || prComments.length > 0 || files.length > 0

  return (
    <div className="flex flex-col items-end px-6 py-4" data-testid="message-user">
      {hasAttachments && (
        <div className="max-w-[80%]">
          <UserMessageAttachmentCards tickets={tickets} prComments={prComments} files={files} />
        </div>
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3',
          isPlanMode
            ? 'bg-purple-500/10 text-foreground'
            : isAskMode
              ? 'bg-amber-500/10 text-foreground'
              : 'bg-primary/10 text-foreground'
        )}
      >
        {isPlanMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-purple-500/15 text-purple-400 mb-1"
            data-testid="plan-mode-badge"
          >
            PLAN
          </span>
        )}
        {isAskMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-400 mb-1"
            data-testid="ask-mode-badge"
          >
            ASK
          </span>
        )}
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{cleanText}</p>
      </div>
    </div>
  )
})
```

Key changes:
- Outer div changes from `flex justify-end` to `flex flex-col items-end` so cards and bubble stack vertically, both right-aligned
- `parseUserMessageAttachments` is called with `useMemo` on `content`
- Cards render above the bubble div
- Bubble text uses `cleanText` (XML stripped) instead of raw `content`

- [ ] **Step 2: Verify `MessageRenderer` needs no changes**

`MessageRenderer` already passes `displayContent` (with mode prefix stripped) to `UserBubble`. Since the XML parsing now lives inside `UserBubble`, no changes are needed to `MessageRenderer.tsx`.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run test/user-message-attachments/`
Expected: All tests from Tasks 1 and 2 PASS (18 total)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/sessions/UserBubble.tsx
git commit -m "feat: render parsed XML attachments as cards above user message bubble"
```

---

### Task 4: Manual smoke test

- [ ] **Step 1: Verify rendering with a ticket attachment**

1. Open the app, start a session
2. Attach a board ticket to a message and send it
3. The sent message should show:
   - Ticket card (blue KanbanSquare icon + title + description preview) above the bubble
   - Clean text in the bubble (no `<ticket>` XML visible)

- [ ] **Step 2: Verify rendering with a PR comment attachment**

1. Open a PR review, attach comments to a message and send
2. The sent message should show:
   - PR comment card(s) (Github icon + author + file:line + body snippet) above the bubble
   - Clean text in the bubble (no `<pr-comment>` XML visible)

- [ ] **Step 3: Verify rendering with file attachments**

1. Attach file(s) to a message and send
2. The sent message should show:
   - File card(s) (FileText icon + filename) above the bubble
   - Clean text in the bubble (no `<attached_files>` XML visible)

- [ ] **Step 4: Verify mixed attachments and edge cases**

1. Send a message with no attachments — should render normally (no cards)
2. Send a message with PLAN/ASK mode + attachments — mode badge should still appear, cards should render, XML should be stripped
3. Scroll through message history — previously sent attachment messages should now render with cards

- [ ] **Step 5: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: adjustments from smoke testing attachment cards"
```
