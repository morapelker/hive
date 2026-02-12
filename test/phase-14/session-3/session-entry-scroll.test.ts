import { describe, test, expect } from 'vitest'

/**
 * Session 3: Session Entry Auto-Scroll
 *
 * Verifies that SessionView scrolls instantly to the bottom (no animation)
 * when entering or switching to a session, using requestAnimationFrame
 * to wait for messages to render before scrolling.
 *
 * The scroll is triggered by a useEffect that watches viewState.status and
 * sessionId. It waits for viewState === 'connected' (meaning the message
 * list DOM is rendered) and messages.length > 0 before scrolling. This is
 * necessary because while viewState is 'connecting', a loading spinner is
 * shown instead of the message list, so messagesEndRef would be null.
 */

describe('Session 3: Session Entry Auto-Scroll', () => {
  test('instant scrollIntoView is present in SessionView', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sourcePath = path.resolve(
      __dirname,
      '../../../src/renderer/src/components/sessions/SessionView.tsx'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')

    expect(source).toContain("messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })")
  })

  test('scroll waits for viewState connected before firing', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sourcePath = path.resolve(
      __dirname,
      '../../../src/renderer/src/components/sessions/SessionView.tsx'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // The effect should check for viewState.status === 'connected' and messages
    // before attempting to scroll, because the message list DOM only exists
    // when viewState is 'connected'
    const scrollEffect = source.match(
      /useEffect\(\(\)\s*=>\s*\{[\s\S]*?viewState\.status\s*===\s*'connected'[\s\S]*?messages\.length\s*>\s*0[\s\S]*?requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*?messagesEndRef\.current\?\.scrollIntoView\(\{\s*behavior:\s*'instant'\s*\}\)[\s\S]*?\}\)[\s\S]*?\},\s*\[viewState\.status,\s*sessionId\]\)/
    )
    expect(scrollEffect).not.toBeNull()
  })

  test('scroll effect depends on viewState.status and sessionId (not messages)', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sourcePath = path.resolve(
      __dirname,
      '../../../src/renderer/src/components/sessions/SessionView.tsx'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // The dependency array must NOT include messages — otherwise it would fire
    // on every streaming append and override smooth auto-scroll
    expect(source).toContain('[viewState.status, sessionId]')
  })

  test('smooth scroll is still used for streaming auto-scroll (not instant)', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sourcePath = path.resolve(
      __dirname,
      '../../../src/renderer/src/components/sessions/SessionView.tsx'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // The scrollToBottom callback should still use 'smooth' behavior
    // for streaming auto-scroll
    expect(source).toContain("scrollIntoView({ behavior: 'smooth' })")
  })

  test('messagesEndRef is used as the scroll anchor', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const sourcePath = path.resolve(
      __dirname,
      '../../../src/renderer/src/components/sessions/SessionView.tsx'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')

    // Verify the ref exists and is attached to a DOM element
    expect(source).toContain('const messagesEndRef = useRef<HTMLDivElement>(null)')
    expect(source).toContain('ref={messagesEndRef}')
  })
})
