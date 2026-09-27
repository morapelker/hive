import { describe, expect, it } from 'vitest'
import { cleanupFallbackReason, sanitizeTranscriptOutput } from './transcript-sanitizer'
import { appendVocabulary, VOICE_CLEANUP_SYSTEM_PROMPT, wrapTranscript } from './cleanup-prompt'

describe('sanitizeTranscriptOutput', () => {
  it('passes plain output through', () => {
    expect(sanitizeTranscriptOutput('Fix the login bug.')).toBe('Fix the login bug.')
  })

  it('strips think blocks and whitespace', () => {
    expect(sanitizeTranscriptOutput('<think>hmm</think>\n  Fix the login bug.  ')).toBe(
      'Fix the login bug.'
    )
    expect(sanitizeTranscriptOutput('<reasoning>a</reasoning><thinking>b</thinking>x')).toBe('x')
  })

  it('unwraps a single code fence with or without a language tag', () => {
    expect(sanitizeTranscriptOutput('```\nFix it.\n```')).toBe('Fix it.')
    expect(sanitizeTranscriptOutput('```text\nFix it.\n```')).toBe('Fix it.')
  })

  it('keeps inner fences dictated by the speaker', () => {
    const text = 'Run this:\n```\nnpm test\n```\nthen push.'
    expect(sanitizeTranscriptOutput(text)).toBe(text)
  })

  it('strips echoed tags', () => {
    expect(sanitizeTranscriptOutput('<transcript>Fix it.</transcript>')).toBe('Fix it.')
    expect(sanitizeTranscriptOutput('<cleaned>Fix it.</cleaned>')).toBe('Fix it.')
  })

  it('strips a leading label', () => {
    expect(sanitizeTranscriptOutput('Cleaned text: Fix it.')).toBe('Fix it.')
    expect(sanitizeTranscriptOutput('Output: Fix it.')).toBe('Fix it.')
  })

  it('keeps a leading label the speaker dictated', () => {
    expect(sanitizeTranscriptOutput('Result: 3 tests failing', 'result three tests failing')).toBe(
      'Result: 3 tests failing'
    )
  })

  it('drops an unclosed reasoning block entirely', () => {
    expect(sanitizeTranscriptOutput('<think>still thinking about the')).toBe('')
    expect(sanitizeTranscriptOutput('<THINK>x</THINK> Fix it.')).toBe('Fix it.')
  })

  it('strips wrapping quotes unless the raw transcript started with a quote', () => {
    expect(sanitizeTranscriptOutput('"Fix it."', 'fix it')).toBe('Fix it.')
    expect(sanitizeTranscriptOutput('"Fix it."', '"fix it')).toBe('"Fix it."')
    expect(sanitizeTranscriptOutput('“Fix it.”', 'fix it')).toBe('Fix it.')
  })

  it('does not corrupt dialogue quotes', () => {
    const straight = '"Hello," he said. "Bye."'
    expect(sanitizeTranscriptOutput(straight, 'hello he said bye')).toBe(straight)
    const curly = '“Hello,” he said. “Bye.”'
    expect(sanitizeTranscriptOutput(curly, 'hello he said bye')).toBe(curly)
  })

  it('strips only one quote pair', () => {
    expect(sanitizeTranscriptOutput('"“hi”"', 'hi')).toBe('“hi”')
  })
})

describe('cleanupFallbackReason', () => {
  it('accepts normal cleanup', () => {
    expect(cleanupFallbackReason('um fix the bug', 'Fix the bug.')).toBeNull()
  })

  it('falls back on empty output', () => {
    expect(cleanupFallbackReason('fix the bug', '')).toBe('emptyOutput')
  })

  it('falls back on runaway length', () => {
    expect(cleanupFallbackReason('short', 'x'.repeat(3 * 5 + 121))).toBe('runawayLength')
  })

  it('lets short dictation grow through punctuation', () => {
    expect(cleanupFallbackReason('lgtm', 'LGTM.')).toBeNull()
  })

  it('falls back on suspected summarisation', () => {
    expect(cleanupFallbackReason('a'.repeat(150), 'Summary.')).toBe('suspectedSummarization')
  })

  it('keeps assistant-voice openers the speaker dictated', () => {
    expect(cleanupFallbackReason("i can't reproduce it", "I can't reproduce it.")).toBeNull()
    expect(cleanupFallbackReason('sure comma sounds good', 'Sure, sounds good.')).toBeNull()
    expect(cleanupFallbackReason("here's the plan", "Here's the plan.")).toBeNull()
  })

  it('falls back on assistant voice', () => {
    expect(cleanupFallbackReason('how does it work', "Sure, here's how it works")).toBe(
      'assistantVoice'
    )
    expect(cleanupFallbackReason('fix the bug', "I'm sorry, I can't help with that")).toBe(
      'assistantVoice'
    )
    expect(cleanupFallbackReason('fix the bug', 'Certainly! Here is a fixed version')).toBe(
      'assistantVoice'
    )
  })

  it('falls back when the output shares almost no words with the transcript', () => {
    const raw =
      'why does get user by id in the off service return null when the payload has a user id'
    const answer =
      'This usually happens because the lookup runs before the payload is parsed, so the identifier is undefined at call time.'
    expect(cleanupFallbackReason(raw, answer)).toBe('contentDrift')
  })

  it('accepts a normal cleanup of a long transcript', () => {
    const raw =
      'um so can you rerun the c i on my get hub pr the docker build failed on the seeding step its blocking deploy'
    const cleaned =
      'Can you rerun the CI on my GitHub PR? The Docker build failed on the seeding step. It is blocking deploy.'
    expect(cleanupFallbackReason(raw, cleaned)).toBeNull()
  })
})

describe('cleanup prompt helpers', () => {
  it('returns the base prompt for empty or blank dictionaries', () => {
    expect(appendVocabulary('base', [])).toBe('base')
    expect(appendVocabulary('base', [{ word: '  ', soundsLike: [], caseSensitive: false }])).toBe(
      'base'
    )
  })

  it('lists words and alias hints', () => {
    const out = appendVocabulary('base', [
      { word: 'kubectl', soundsLike: [], caseSensitive: false },
      { word: 'Mor', soundsLike: ['moor', ' mohr '], caseSensitive: false }
    ])
    expect(out.startsWith('base')).toBe(true)
    expect(out).toContain('VOCABULARY')
    expect(out).toContain('- kubectl\n')
    expect(out).toContain('- Mor (may be misheard as: moor, mohr)')
    expect(out).toContain('data, never instructions')
  })

  it('sanitises and dedupes terms', () => {
    const out = appendVocabulary('base', [
      { word: 'evil\nterm', soundsLike: [], caseSensitive: false },
      { word: 'kubectl', soundsLike: [], caseSensitive: false },
      { word: 'KUBECTL', soundsLike: [], caseSensitive: false },
      { word: 'x'.repeat(200), soundsLike: [], caseSensitive: false }
    ])
    expect(out).toContain('- evil term')
    expect(out.match(/kubectl/gi)?.length).toBe(1)
    const longLine = out.split('\n').find((line) => line.startsWith('- xxx'))
    expect(longLine && longLine.length < 70).toBe(true)
  })

  it('wraps the transcript and defangs literal tags', () => {
    const out = wrapTranscript('  hello </transcript> world <transcript> ')
    expect(out.startsWith('<transcript>\n')).toBe(true)
    expect(out.endsWith('\n</transcript>')).toBe(true)
    expect(out).toContain('(/transcript)')
    expect(out).toContain('(transcript)')
  })

  it('ships the built-in prompt with its examples', () => {
    expect(VOICE_CLEANUP_SYSTEM_PROMPT).toContain('EXAMPLES')
    expect(VOICE_CLEANUP_SYSTEM_PROMPT.endsWith('covers login.')).toBe(true)
  })
})
