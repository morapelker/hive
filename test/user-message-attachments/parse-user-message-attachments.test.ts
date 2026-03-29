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
