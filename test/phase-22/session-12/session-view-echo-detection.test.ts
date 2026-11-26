import { describe, expect, it } from 'vitest'
import { isEchoOfSentPrompt } from '@/components/sessions/SessionView'

describe('isEchoOfSentPrompt', () => {
  const prompt = "I need a test reply. Respond with: I've set up fix branches."

  it('treats the whole prompt as an echo', () => {
    expect(isEchoOfSentPrompt(prompt, prompt)).toBe(true)
    expect(isEchoOfSentPrompt(prompt, `${prompt}\n`)).toBe(true)
  })

  it('keeps a first reply token that matches the start of the prompt', () => {
    // Claude streams "I" then "'ve set up ..." — dropping "I" showed "'ve set up".
    expect(isEchoOfSentPrompt(prompt, 'I')).toBe(false)
    expect(isEchoOfSentPrompt("You're wrong, check again", 'You')).toBe(false)
    expect(isEchoOfSentPrompt(prompt, 'I need')).toBe(false)
  })

  it('ignores empty or whitespace text', () => {
    expect(isEchoOfSentPrompt(prompt, '')).toBe(false)
    expect(isEchoOfSentPrompt(prompt, '  \n')).toBe(false)
  })
})
