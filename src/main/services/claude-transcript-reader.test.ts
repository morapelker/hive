import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePath, readClaudeTranscriptRaw } from './claude-transcript-reader'

describe('readClaudeTranscriptRaw', () => {
  let tempDir: string | null = null

  afterEach(() => {
    vi.unstubAllEnvs()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('falls back to the realpath encoded transcript directory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hive-claude-transcript-'))
    const claudeConfigDir = join(tempDir, 'claude')
    const realWorktreePath = join(tempDir, 'real-worktree')
    const linkedWorktreePath = join(tempDir, 'linked-worktree')
    const claudeSessionId = 'session-123'
    const transcript = '{"type":"user","message":{"role":"user","content":"hello"}}\n'

    mkdirSync(realWorktreePath, { recursive: true })
    symlinkSync(realWorktreePath, linkedWorktreePath)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir)

    const transcriptDir = join(
      claudeConfigDir,
      'projects',
      encodePath(realpathSync(realWorktreePath))
    )
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, `${claudeSessionId}.jsonl`), transcript)

    await expect(readClaudeTranscriptRaw(linkedWorktreePath, claudeSessionId)).resolves.toBe(
      transcript
    )
  })
})
