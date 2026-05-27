import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('native Ghostty Shift+Enter handling', () => {
  test('rewrites bare Shift+Enter to ESC+CR instead of relying on default return handling', () => {
    const source = readFileSync(join(process.cwd(), 'src/native/src/nsview_host.mm'), 'utf8')

    expect(source).toContain('shiftEnterAsNewline && isBareShiftEnterEvent(event)')
    expect(source).toContain('pasteText(self.surfaceId, "\\x1b\\r")')
    expect(source).not.toContain('ghosttyConsumedModsForKeyEvent')
    expect(source).not.toContain('pasteText(self.surfaceId, "\\n")')
  })
})
