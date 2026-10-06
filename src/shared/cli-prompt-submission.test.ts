import { describe, expect, it } from 'vitest'
import { encodeCliPromptSubmission, isCliPromptSubmission } from './cli-prompt-submission'

describe('encodeCliPromptSubmission', () => {
  it('is a bracketed paste and its Enter', () => {
    expect(encodeCliPromptSubmission('resolve the\nconflicts')).toBe(
      '\x1b[200~resolve the\nconflicts\x1b[201~\r'
    )
  })

  it('types the lead ahead of the paste, outside of it', () => {
    expect(encodeCliPromptSubmission('resolve the\nconflicts', 'This is from me:')).toBe(
      'This is from me: \x1b[200~resolve the\nconflicts\x1b[201~\r'
    )
  })

  it('keeps anything that would act as a key press out of the typed lead', () => {
    // An Enter in the lead would submit it alone; an Escape would be read as a key.
    expect(encodeCliPromptSubmission('p', ' from me:\r\nsecond\x1b[A line\t ')).toBe(
      'from me: second [A line \x1b[200~p\x1b[201~\r'
    )
    expect(encodeCliPromptSubmission('p', ' \n ')).toBe('\x1b[200~p\x1b[201~\r')
    expect(encodeCliPromptSubmission('p', '')).toBe('\x1b[200~p\x1b[201~\r')
  })
})

describe('isCliPromptSubmission', () => {
  it('recognizes a prompt with and without a typed lead', () => {
    expect(isCliPromptSubmission(encodeCliPromptSubmission('resolve the\nconflicts'))).toBe(true)
    expect(isCliPromptSubmission(encodeCliPromptSubmission('continue', 'This is from me:'))).toBe(
      true
    )
  })

  it('rejects keystrokes, a paste without its Enter, and input that is more than one prompt', () => {
    expect(isCliPromptSubmission('\r')).toBe(false)
    expect(isCliPromptSubmission('typed\r')).toBe(false)
    expect(isCliPromptSubmission('\x1b[200~pasted\x1b[201~')).toBe(false)
    expect(isCliPromptSubmission('first\r\x1b[200~second\x1b[201~\r')).toBe(false)
    expect(isCliPromptSubmission('\x1b[A\x1b[200~second\x1b[201~\r')).toBe(false)
  })
})
