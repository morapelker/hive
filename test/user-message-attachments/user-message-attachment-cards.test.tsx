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
