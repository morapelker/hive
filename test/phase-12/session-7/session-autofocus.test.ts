import { describe, test, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const componentPath = path.join(
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

describe('Session 7: Session Auto-Focus', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(componentPath, 'utf-8')
  })

  describe('unconditional focus effect', () => {
    test('has a useEffect that focuses textarea on sessionId change', () => {
      const effects = extractAllEffects(content)
      const focusEffects = effects.filter(
        (e) => e.includes('textareaRef') && e.includes('.focus()')
      )
      expect(focusEffects.length).toBeGreaterThanOrEqual(1)
    })

    test('focus effect depends on sessionId', () => {
      const effects = extractAllEffects(content)
      const focusEffect = effects.find(
        (e) => e.includes('textareaRef') && e.includes('.focus()') && e.includes('sessionId')
      )
      expect(focusEffect).toBeTruthy()
    })

    test('focus effect does NOT gate on viewState.status === connected', () => {
      const effects = extractAllEffects(content)
      const focusEffects = effects.filter(
        (e) => e.includes('textareaRef') && e.includes('.focus()')
      )

      // At least one focus effect should NOT require connected status
      const unconditionalFocusEffect = focusEffects.find(
        (e) => !e.includes("viewState.status === 'connected'")
      )
      expect(unconditionalFocusEffect).toBeTruthy()
    })

    test('focus effect uses requestAnimationFrame for timing', () => {
      const effects = extractAllEffects(content)
      const focusEffect = effects.find(
        (e) =>
          e.includes('textareaRef') &&
          e.includes('.focus()') &&
          !e.includes("viewState.status === 'connected'")
      )
      expect(focusEffect).toBeTruthy()
      expect(focusEffect).toContain('requestAnimationFrame')
    })

    test('focus works in idle state (no connected gate in dependency array)', () => {
      const effects = extractAllEffects(content)
      const focusEffect = effects.find(
        (e) =>
          e.includes('textareaRef') &&
          e.includes('.focus()') &&
          !e.includes("viewState.status === 'connected'")
      )
      expect(focusEffect).toBeTruthy()
      // The unconditional focus effect should only depend on sessionId, not viewState.status
      expect(focusEffect).not.toContain('viewState.status')
    })
  })
})

/**
 * Extract ALL useEffect blocks from the component source.
 */
function extractAllEffects(source: string): string[] {
  const lines = source.split('\n')
  const effects: string[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('useEffect')) continue

    let braceCount = 0
    let started = false
    const blockLines: string[] = []

    for (let j = i; j < lines.length; j++) {
      blockLines.push(lines[j])
      for (const ch of lines[j]) {
        if (ch === '{') {
          braceCount++
          started = true
        }
        if (ch === '}') braceCount--
      }
      if (started && braceCount <= 0) {
        effects.push(blockLines.join('\n'))
        break
      }
    }
  }

  return effects
}
