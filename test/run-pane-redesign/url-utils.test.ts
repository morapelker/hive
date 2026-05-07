import { describe, expect, test } from 'vitest'
import { splitLineByUrls, trimTrailingPunct } from '../../src/renderer/src/lib/url-utils'

describe('url-utils', () => {
  describe('splitLineByUrls', () => {
    test('returns a single text chunk when no URL is present', () => {
      expect(splitLineByUrls('server started on port 5173')).toEqual([
        { type: 'text', content: 'server started on port 5173' }
      ])
    })

    test('splits a single URL surrounded by text into three chunks', () => {
      expect(splitLineByUrls('Local: http://localhost:5173/ ready')).toEqual([
        { type: 'text', content: 'Local: ' },
        { type: 'url', content: 'http://localhost:5173/', url: 'http://localhost:5173/' },
        { type: 'text', content: ' ready' }
      ])
    })

    test('splits two URLs in one line into five chunks', () => {
      expect(splitLineByUrls('open http://localhost:5173/ or https://example.com/docs')).toEqual([
        { type: 'text', content: 'open ' },
        { type: 'url', content: 'http://localhost:5173/', url: 'http://localhost:5173/' },
        { type: 'text', content: ' or ' },
        { type: 'url', content: 'https://example.com/docs', url: 'https://example.com/docs' },
        { type: 'text', content: '' }
      ])
    })

    test('moves trailing punctuation into text chunks', () => {
      expect(splitLineByUrls('See https://example.com/a.,)];: next')).toEqual([
        { type: 'text', content: 'See ' },
        { type: 'url', content: 'https://example.com/a', url: 'https://example.com/a' },
        { type: 'text', content: '.,)];: next' }
      ])
    })

    test('keeps balanced Wikipedia-style closing parenthesis', () => {
      expect(splitLineByUrls('See https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
        { type: 'text', content: 'See ' },
        {
          type: 'url',
          content: 'https://en.wikipedia.org/wiki/Foo_(bar)',
          url: 'https://en.wikipedia.org/wiki/Foo_(bar)'
        },
        { type: 'text', content: '' }
      ])
    })

    test('angle brackets terminate URL detection', () => {
      expect(splitLineByUrls('<https://example.com>')).toEqual([
        { type: 'text', content: '<' },
        { type: 'url', content: 'https://example.com', url: 'https://example.com' },
        { type: 'text', content: '>' }
      ])
    })
  })

  describe('trimTrailingPunct', () => {
    test.each(['.', ',', ']', ';', ':'])('strips trailing %s', (punct) => {
      expect(trimTrailingPunct(`https://example.com/path${punct}`)).toBe(
        'https://example.com/path'
      )
    })

    test('strips an unbalanced trailing closing parenthesis', () => {
      expect(trimTrailingPunct('https://example.com/path)')).toBe('https://example.com/path')
    })

    test('keeps a balanced trailing closing parenthesis', () => {
      expect(trimTrailingPunct('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
        'https://en.wikipedia.org/wiki/Foo_(bar)'
      )
    })
  })
})
