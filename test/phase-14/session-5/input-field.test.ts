import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const sessionViewPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions',
  'SessionView.tsx'
)

function readSessionView(): string {
  return fs.readFileSync(sessionViewPath, 'utf-8')
}

describe('Session 5: Better Input Field', () => {
  describe('wider input container', () => {
    test('input container uses max-w-4xl class', () => {
      const content = readSessionView()
      // The input area container should use max-w-4xl
      expect(content).toContain('max-w-4xl mx-auto relative')
    })

    test('permission prompt container uses max-w-4xl for consistency', () => {
      const content = readSessionView()
      const lines = content.split('\n')
      // Find the line with PermissionPrompt, then check the nearby max-w class
      const permLineIdx = lines.findIndex((l) => l.includes('<PermissionPrompt'))
      expect(permLineIdx).toBeGreaterThan(0)
      // The container div with max-w-4xl should be within 3 lines above
      const nearbyLines = lines.slice(Math.max(0, permLineIdx - 3), permLineIdx).join('\n')
      expect(nearbyLines).toContain('max-w-4xl')
    })

    test('question prompt container uses max-w-4xl for consistency', () => {
      const content = readSessionView()
      const lines = content.split('\n')
      // Find the line with QuestionPrompt, then check the nearby max-w class
      const questionLineIdx = lines.findIndex((l) => l.includes('<QuestionPrompt'))
      expect(questionLineIdx).toBeGreaterThan(0)
      // The container div with max-w-4xl should be within 3 lines above
      const nearbyLines = lines.slice(Math.max(0, questionLineIdx - 3), questionLineIdx).join('\n')
      expect(nearbyLines).toContain('max-w-4xl')
    })

    test('no max-w-3xl remains in input/prompt areas', () => {
      const content = readSessionView()
      // max-w-3xl should not appear in the input/prompt area containers
      // (it may still exist in other unrelated areas like SessionHistory panel)
      const lines = content.split('\n')
      const inputAreaLines = lines.filter(
        (line) =>
          line.includes('max-w-3xl') &&
          !line.includes('SessionHistory') &&
          !line.includes('fixed inset')
      )
      expect(inputAreaLines).toHaveLength(0)
    })
  })

  describe('auto-resize with sessionId dependency', () => {
    test('auto-resize effect depends on sessionId', () => {
      const content = readSessionView()
      // The auto-resize useEffect should include sessionId in its dependency array
      expect(content).toContain('[inputValue, sessionId]')
    })

    test('auto-resize uses requestAnimationFrame', () => {
      const content = readSessionView()
      // Find the auto-resize effect block
      const resizeIdx = content.indexOf('Auto-resize textarea')
      expect(resizeIdx).toBeGreaterThan(-1)
      const resizeBlock = content.substring(resizeIdx, resizeIdx + 300)
      expect(resizeBlock).toContain('requestAnimationFrame')
    })

    test('auto-resize still caps at 200px', () => {
      const content = readSessionView()
      // The max height cap should still be 200px
      expect(content).toContain('Math.min(textarea.scrollHeight, 200)')
    })

    test('auto-resize resets height to auto first', () => {
      const content = readSessionView()
      // Should reset to 'auto' before measuring scrollHeight
      expect(content).toContain("textarea.style.height = 'auto'")
    })
  })
})
