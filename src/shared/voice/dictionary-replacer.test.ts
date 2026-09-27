import { describe, expect, it } from 'vitest'
import { DictionaryReplacer } from './dictionary-replacer'
import type { VoiceDictionaryEntry } from '../types/voice'

const entry = (
  word: string,
  soundsLike: string[] = [],
  caseSensitive = false
): VoiceDictionaryEntry => ({ word, soundsLike, caseSensitive })

const apply = (entries: VoiceDictionaryEntry[], text: string): string =>
  new DictionaryReplacer(entries).apply(text)

describe('DictionaryReplacer', () => {
  it('normalises casing for plain entries', () => {
    const entries = [entry('Claude')]
    expect(apply(entries, 'ask claude')).toBe('ask Claude')
    expect(apply(entries, 'ask CLAUDE')).toBe('ask Claude')
    expect(apply(entries, 'ask Claude')).toBe('ask Claude')
  })

  it('lowercase canonical wins even at sentence start', () => {
    expect(apply([entry('kubectl')], 'Kubectl get pods')).toBe('kubectl get pods')
  })

  it('rewrites aliases to the word', () => {
    const entries = [entry('Mor', ['moor', 'mohr'])]
    expect(apply(entries, 'hey moor')).toBe('hey Mor')
    expect(apply(entries, 'hey Mohr')).toBe('hey Mor')
  })

  it('treats punctuation as a boundary', () => {
    expect(apply([entry('Mor', ['moor'])], 'moor, hi')).toBe('Mor, hi')
    expect(apply([entry('Claude', ['clod'])], 'clod-based tool (clod)')).toBe(
      'Claude-based tool (Claude)'
    )
  })

  it('never matches substrings', () => {
    const entries = [entry('Mor', ['moor', 'more'])]
    expect(apply(entries, 'moreover the moors moved')).toBe('moreover the moors moved')
    expect(apply(entries, 'moorland')).toBe('moorland')
  })

  it('respects unicode and underscore boundaries', () => {
    const entries = [entry('Mor', ['moor'])]
    for (const text of ['cafémoor', 'cafémoor', 'user_moor', 'moor_id', 'moor2']) {
      expect(apply(entries, text)).toBe(text)
    }
  })

  it('treats newlines and string edges as boundaries', () => {
    const entries = [entry('Mor', ['moor'])]
    expect(apply(entries, 'moor\nplease')).toBe('Mor\nplease')
    expect(apply(entries, 'moor')).toBe('Mor')
  })

  it('preserves possessives', () => {
    const entries = [entry('Mor', ['moor'])]
    expect(apply(entries, "moor's laptop")).toBe("Mor's laptop")
    expect(apply(entries, 'moor’s laptop')).toBe('Mor’s laptop')
    expect(apply(entries, "MOOR'S LAPTOP")).toBe("Mor's LAPTOP")
  })

  it('matches multi-word aliases across whitespace', () => {
    const entries = [entry('Wispelker', ['wisp elker'])]
    expect(apply(entries, 'wisp elker')).toBe('Wispelker')
    expect(apply(entries, 'Wisp   Elker')).toBe('Wispelker')
  })

  it('normalises multi-word canonical words', () => {
    expect(apply([entry('Claude Code')], 'claude  code')).toBe('Claude Code')
  })

  it('escapes regex metacharacters', () => {
    const entries = [entry('C++', ['see plus plus'])]
    expect(apply(entries, 'c++')).toBe('C++')
    expect(apply(entries, 'see plus plus')).toBe('C++')
  })

  it('inserts replacements literally (no $ expansion)', () => {
    expect(apply([entry('A$AP', ['ay sap'])], 'ay sap')).toBe('A$AP')
  })

  it('case-sensitive entries skip recasing but aliases still apply', () => {
    const entries = [entry('Mark', ['marc'], true)]
    expect(apply(entries, 'mark')).toBe('mark')
    expect(apply(entries, 'MARK')).toBe('MARK')
    expect(apply(entries, 'marc')).toBe('Mark')
  })

  it('longest alias wins at the same position', () => {
    const entries = [entry('Todo', ['to']), entry('Tedooo', ['to do'])]
    expect(apply(entries, 'add it to do list')).toBe('add it Tedooo list')
  })

  it('first entry wins on duplicate aliases', () => {
    const entries = [entry('Mor', ['moor']), entry('Moore', ['moor'])]
    expect(apply(entries, 'moor')).toBe('Mor')
  })

  it('never chains replacements', () => {
    const entries = [entry('Hub', ['hab']), entry('GitHub', ['git hub'])]
    expect(apply(entries, 'the git hab pipeline')).toBe('the git Hub pipeline')
  })

  it('an alias colliding with another entry word loses to that entry', () => {
    const entries = [entry('Mor'), entry('Morris', ['mor'])]
    expect(apply(entries, 'mor met morris')).toBe('Mor met Morris')
  })

  it('a multi-word canonical word applies even when its first token is already canonical', () => {
    const entries = [entry('Claude'), entry('Claude Code')]
    expect(apply(entries, 'open Claude code')).toBe('open Claude Code')
    expect(apply(entries, 'open claude code now')).toBe('open Claude Code now')
  })

  it('chain-prone dictionaries are idempotent', () => {
    const entries = [entry('Hub', ['hab']), entry('GitHub', ['git hub'])]
    expect(apply(entries, 'the git Hub pipeline')).toBe('the git Hub pipeline')
    expect(apply(entries, 'the git hub pipeline')).toBe('the GitHub pipeline')
  })

  it('a canonical word is never rewritten by a colliding alias', () => {
    const entries = [entry('Marcus', ['mark']), entry('Mark', [], true)]
    expect(apply(entries, 'ask Mark about it')).toBe('ask Mark about it')
    expect(apply(entries, 'ask mark about it')).toBe('ask Marcus about it')
  })

  it('a case-sensitive word does not swallow a later alias', () => {
    const entries = [entry('Mark', [], true), entry('Marc', ['mark'])]
    expect(apply(entries, 'mark')).toBe('Marc')
    expect(apply(entries, 'Mark')).toBe('Mark')
  })

  it("a case-sensitive entry's own alias still fires", () => {
    expect(apply([entry('Mark', ['mark'], true)], 'mark it done')).toBe('Mark it done')
  })

  it('matches across unicode normalisation forms and outputs NFC', () => {
    const nfcWord = 'Café'
    const nfdText = 'café is open'
    const out = apply([entry(nfcWord)], nfdText)
    expect(out).toBe('Café is open')
    expect(out.normalize('NFC')).toBe(out)
    const nfdWord = 'Café'
    expect(apply([entry(nfdWord)], 'café is open')).toBe('Café is open')
  })

  it('empty entries and text are identity', () => {
    expect(apply([], 'hello')).toBe('hello')
    expect(apply([entry('Mor')], '')).toBe('')
    expect(apply([entry('   ')], 'hello')).toBe('hello')
    expect(new DictionaryReplacer([]).isEmpty).toBe(true)
  })

  it('is idempotent on a realistic sentence', () => {
    const entries = [entry('Mor', ['moor']), entry('Claude'), entry('Wispelker', ['wisp elker'])]
    const once = apply(entries, "hey moor claude broke the wisp elker build and moor's tests")
    expect(once).toBe("hey Mor Claude broke the Wispelker build and Mor's tests")
    expect(apply(entries, once)).toBe(once)
  })
})
