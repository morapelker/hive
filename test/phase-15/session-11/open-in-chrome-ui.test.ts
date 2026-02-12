import { extractDevServerUrl, formatRelativeTime } from '../../../src/renderer/src/lib/format-utils'

describe('Session 11: Open in Chrome UI', () => {
  describe('extractDevServerUrl', () => {
    test('finds localhost URL', () => {
      const output = ['Starting server...', '  > Local:   http://localhost:3000/', 'ready']
      expect(extractDevServerUrl(output)).toBe('http://localhost:3000/')
    })

    test('finds Next.js dev server URL with leading spaces', () => {
      const output = [
        '   ▲ Next.js 15.4.10 (Turbopack)',
        '   - Local:        http://localhost:3014',
        '   - Network:      http://192.168.1.230:3014',
        ' ✓ Ready in 1381ms'
      ]
      expect(extractDevServerUrl(output)).toBe('http://localhost:3014')
    })

    test('finds 127.0.0.1 URL', () => {
      const output = ['Server running at http://127.0.0.1:5173']
      expect(extractDevServerUrl(output)).toBe('http://127.0.0.1:5173')
    })

    test('finds 0.0.0.0 URL', () => {
      const output = ['Listening on http://0.0.0.0:8080']
      expect(extractDevServerUrl(output)).toBe('http://0.0.0.0:8080')
    })

    test('finds https URL', () => {
      const output = ['HTTPS server: https://localhost:3443/']
      expect(extractDevServerUrl(output)).toBe('https://localhost:3443/')
    })

    test('returns null when no URL found', () => {
      const output = ['Building...', 'Done.']
      expect(extractDevServerUrl(output)).toBeNull()
    })

    test('returns null for empty output', () => {
      expect(extractDevServerUrl([])).toBeNull()
    })

    test('scans last 50 lines only', () => {
      const output = Array(100).fill('noise')
      output[10] = 'http://localhost:3000' // too far back (index 10 out of 100)
      expect(extractDevServerUrl(output)).toBeNull()
    })

    test('finds URL within last 50 lines', () => {
      const output = Array(100).fill('noise')
      output[80] = 'Server at http://localhost:3000' // within last 50 (index 80 out of 100)
      expect(extractDevServerUrl(output)).toBe('http://localhost:3000')
    })

    test('returns last matching URL (scans backwards)', () => {
      const output = ['http://localhost:3000', 'noise', 'http://localhost:5173']
      // Scanning backwards, it finds :5173 first
      expect(extractDevServerUrl(output)).toBe('http://localhost:5173')
    })

    test('does not match non-local URLs', () => {
      const output = ['Server at http://example.com:3000']
      expect(extractDevServerUrl(output)).toBeNull()
    })

    test('does not match URLs without ports', () => {
      const output = ['Visit http://localhost/']
      expect(extractDevServerUrl(output)).toBeNull()
    })

    test('matches ports in 3-5 digit range', () => {
      const output1 = ['http://localhost:80'] // 2 digits - no match
      expect(extractDevServerUrl(output1)).toBeNull()

      const output2 = ['http://localhost:123'] // 3 digits - match
      expect(extractDevServerUrl(output2)).toBe('http://localhost:123')

      const output3 = ['http://localhost:65535'] // 5 digits - match
      expect(extractDevServerUrl(output3)).toBe('http://localhost:65535')
    })
  })

  describe('formatRelativeTime', () => {
    test('returns "now" for < 1 minute', () => {
      expect(formatRelativeTime(Date.now() - 30000)).toBe('now')
    })

    test('returns "Xm" for minutes', () => {
      expect(formatRelativeTime(Date.now() - 5 * 60000)).toBe('5m')
    })

    test('returns "Xh" for hours', () => {
      expect(formatRelativeTime(Date.now() - 3 * 3600000)).toBe('3h')
    })

    test('returns "Xd" for days', () => {
      expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d')
    })

    test('returns "Xw" for weeks', () => {
      expect(formatRelativeTime(Date.now() - 14 * 86400000)).toBe('2w')
    })
  })
})
