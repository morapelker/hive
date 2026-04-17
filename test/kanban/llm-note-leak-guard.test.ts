/**
 * Guard test: the kanban ticket `note` field must NEVER be included in any
 * LLM prompt. The `note` is a personal annotation for the user only.
 *
 * Approach: static analysis on the known prompt-building source files. The
 * relevant prompt-construction helpers in these files are internal/non-exported,
 * so behavioral testing isn't practical today. Instead we assert two regression
 * classes are absent from each file:
 *   1. Direct access to `ticket.note`.
 *   2. Object spread of a ticket-like variable (`...ticket` / `...t`), which
 *      would silently include `note` if added to the projection.
 *
 * MAINTENANCE: when introducing a new code path that builds an LLM prompt from
 * `KanbanTicket`, add its source path to `LLM_PROMPT_FILES` below.
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..')

const LLM_PROMPT_FILES = [
  'src/renderer/src/components/kanban/BoardAssistantView.tsx',
  'src/renderer/src/stores/useBoardChatStore.ts',
  'src/renderer/src/components/kanban/WorktreePickerModal.tsx'
] as const

describe('Kanban ticket note never leaks into LLM prompts', () => {
  test.each(LLM_PROMPT_FILES)('%s does not read ticket.note', (relPath) => {
    const content = readFileSync(join(REPO_ROOT, relPath), 'utf8')
    expect(content, `${relPath} must not access .note on a ticket`).not.toMatch(/\bticket\.note\b/)
  })

  test.each(LLM_PROMPT_FILES)(
    '%s does not spread a ticket-like object into prompt context',
    (relPath) => {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf8')
      expect(
        content,
        `${relPath} must not spread "...ticket" or "...t" (would include note)`
      ).not.toMatch(/\.\.\.\s*(ticket|t)\b/)
    }
  )

  test('KanbanTicket.note has the LLM-exclusion JSDoc marker', () => {
    const typesPath = join(REPO_ROOT, 'src', 'main', 'db', 'types.ts')
    const content = readFileSync(typesPath, 'utf8')
    // Confirms the type-level marker is intact (defensive: anyone editing the type
    // will see the warning above the field).
    expect(content).toMatch(/MUST NOT be included in any LLM prompt[\s\S]{0,200}\n\s*note\??\s*:/)
  })
})
