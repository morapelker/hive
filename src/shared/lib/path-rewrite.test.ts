// Cross-machine tickets (docs/multi-instance/CROSS-MACHINE-TICKETS.md): the exact-string path
// rewrite the receiver applies to a moved ticket's attachment urls and launch prompt (and T6 to
// a moved run's columns) — longest prefix wins, partial segments are never touched, `file://`
// urls (plain and percent-encoded) are rewritten, and replacements do not cascade.
import { describe, expect, it } from 'vitest'
import { rewriteAttachmentUrls, rewritePaths } from './path-rewrite'

describe('rewritePaths', () => {
  it('replaces every whole-path occurrence of a key', () => {
    const text = 'See /Users/a/img.png and again /Users/a/img.png.'
    expect(rewritePaths(text, { '/Users/a/img.png': '/Users/b/x.png' })).toBe(
      'See /Users/b/x.png and again /Users/b/x.png.'
    )
  })

  it('prefers the longest key at a position', () => {
    const map = {
      '/runs/r1': '/peer/runs/r1',
      '/runs/r1/document.md': '/peer/runs/r1/doc.md'
    }
    expect(rewritePaths('- Full text: /runs/r1/document.md (dir /runs/r1)', map)).toBe(
      '- Full text: /peer/runs/r1/doc.md (dir /peer/runs/r1)'
    )
  })

  it('does not match a partial segment or a longer file name', () => {
    const map = { '/tmp/a/run': '/peer/run' }
    expect(rewritePaths('/tmp/a/run2/x', map)).toBe('/tmp/a/run2/x')
    expect(rewritePaths('/tmp/a/run.md', map)).toBe('/tmp/a/run.md')
    expect(rewritePaths('/tmp/a/run-2', map)).toBe('/tmp/a/run-2')
    expect(rewritePaths('/Users/me/tmp/a/run', map)).toBe('/Users/me/tmp/a/run')
    expect(rewritePaths('/tmp/a/run/doc.md', map)).toBe('/peer/run/doc.md')
    expect(rewritePaths('"/tmp/a/run"', map)).toBe('"/peer/run"')
    // A sentence-ending period is not an extension.
    expect(rewritePaths('Open /tmp/a/run. Then wait', map)).toBe('Open /peer/run. Then wait')
    expect(rewritePaths('Open /tmp/a/run.', map)).toBe('Open /peer/run.')
  })

  it('rewrites file:// urls, including percent-encoded spaces', () => {
    const map = { '/Users/a/my shot.png': '/Users/b/moved-shot.png' }
    expect(rewritePaths('file:///Users/a/my shot.png', map)).toBe('file:///Users/b/moved-shot.png')
    expect(rewritePaths('file:///Users/a/my%20shot.png', map)).toBe(
      'file:///Users/b/moved-shot.png'
    )
  })

  it('does not cascade replacements, so swapping two paths is safe', () => {
    const map = { '/a': '/b', '/b': '/a' }
    expect(rewritePaths('/a /b', map)).toBe('/b /a')
  })

  it('returns the same text when nothing matches, and ignores empty or identity entries', () => {
    const text = 'nothing to do here'
    expect(rewritePaths(text, { '/x': '/y', '': '/z', '/same': '/same' })).toBe(text)
    expect(rewritePaths(text, {})).toBe(text)
    expect(rewritePaths('', { '/x': '/y' })).toBe('')
  })
})

describe('rewriteAttachmentUrls', () => {
  it('rewrites url fields and leaves other entries untouched', () => {
    const attachments = [
      { type: 'image', url: '/Users/a/img.png', label: 'shot' },
      { type: 'link', url: 'https://example.com/x', label: 'docs' },
      'not-an-object',
      { type: 'jira', label: 'no url' }
    ]
    const result = rewriteAttachmentUrls(attachments, { '/Users/a/img.png': '/Users/b/i.png' })
    expect(result).toEqual([
      { type: 'image', url: '/Users/b/i.png', label: 'shot' },
      { type: 'link', url: 'https://example.com/x', label: 'docs' },
      'not-an-object',
      { type: 'jira', label: 'no url' }
    ])
    expect(result).not.toBe(attachments)
    expect(result[1]).toBe(attachments[1])
  })
})
