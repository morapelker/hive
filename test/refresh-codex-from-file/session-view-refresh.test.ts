import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('SessionView refresh from file re-render path', () => {
  it('reloads refreshed Codex sessions from durable DB state instead of live transcript merge', () => {
    const source = readFileSync(
      resolve(__dirname, '../../src/renderer/src/components/sessions/SessionView.tsx'),
      'utf8'
    )

    const refreshedBranch = source.match(/if \(detail\.refreshed\) \{([\s\S]*?)return\s*\n\s*\}/)

    expect(refreshedBranch?.[1]).toContain('refreshCodexMessagesFromDurableState')
    expect(refreshedBranch?.[1]).not.toContain('refreshMessagesFromOpenCode')
  })
})
