import { describe, expect, it } from 'vitest'
import { TicketAutocompleteModel, tokenize } from './model'

const times = (n: number, text: string): string[] => Array.from({ length: n }, () => text)

describe('tokenize', () => {
  it('splits words on whitespace and keeps newlines as tokens', () => {
    expect(tokenize('fix  the\tbug\n\nthen, deploy')).toEqual([
      'fix',
      'the',
      'bug',
      '\n',
      '\n',
      'then,',
      'deploy'
    ])
  })
})

describe('TicketAutocompleteModel', () => {
  it('completes a partially typed word and continues the phrase', () => {
    const model = new TicketAutocompleteModel(
      times(3, 'implement task 6 and ask me any clarifying questions you might have')
    )
    expect(model.suggest('please ask me any clar')?.text).toBe('ifying questions you might have')
  })

  it('predicts the next words right after a space', () => {
    const model = new TicketAutocompleteModel(times(3, 'use subagents to read the task first'))
    const suggestion = model.suggest('now use subagents to ')
    expect(suggestion?.text).toBe('read the task first')
    expect(suggestion?.confidence).toBe(1)
    expect(suggestion?.support).toBe(3)
  })

  it('continues a complete word with a leading space', () => {
    const model = new TicketAutocompleteModel(times(3, 'open a pull request when done'))
    expect(model.suggest('then open a pull')?.text).toBe(' request when done')
  })

  it('matches context case-insensitively and uses the usual spelling', () => {
    const model = new TicketAutocompleteModel([
      ...times(3, 'I want the Settings page redesigned'),
      'i want the Settings page redesigned'
    ])
    expect(model.suggest('I WANT THE ')?.text).toBe('Settings page redesigned')
  })

  it('stops at the end of the line', () => {
    const model = new TicketAutocompleteModel(times(3, 'fix the login bug\nthen deploy it'))
    expect(model.suggest('fix the ')?.text).toBe('login bug')
  })

  it('stays silent when past tickets disagree', () => {
    const model = new TicketAutocompleteModel([
      ...times(3, 'press the red button'),
      ...times(3, 'press the blue button')
    ])
    expect(model.suggest('press the ')).toBeNull()
  })

  it('trusts a single past occurrence of a long, specific context', () => {
    const model = new TicketAutocompleteModel(['send a new email to all shop owners'])
    expect(model.suggest('please send a new email to ')?.text).toBe('all shop owners')
    // A short context seen once is not enough.
    expect(model.suggest('email to ')).toBeNull()
  })

  it('does not run on from the end of one ticket into the next', () => {
    const model = new TicketAutocompleteModel([
      ...times(3, 'this is the end'),
      ...times(3, 'banana split recipe')
    ])
    expect(model.suggest('this is the end ')).toBeNull()
  })

  it('caps the suggestion length', () => {
    const model = new TicketAutocompleteModel(times(3, 'one two three four five six seven eight'))
    expect(model.suggest('one ', { maxTokens: 3 })?.text).toBe('two three four')
  })

  it('only looks at the tail of a long document', () => {
    const model = new TicketAutocompleteModel(times(3, 'ask me any clarifying questions'))
    const filler = 'lorem ipsum dolor sit amet '.repeat(200)
    expect(model.suggest(`${filler}ask me any `)?.text).toBe('clarifying questions')
  })

  it('returns null with nothing learned or nothing typed that it knows', () => {
    expect(new TicketAutocompleteModel([]).suggest('anything ')).toBeNull()
    const model = new TicketAutocompleteModel(times(3, 'implement the ticket'))
    expect(model.suggest('zzz')).toBeNull()
    expect(model.suggest('something unrelated ')).toBeNull()
  })

  it('reports corpus statistics', () => {
    const model = new TicketAutocompleteModel(['a b c', '', 'c d'])
    expect(model.stats).toEqual({ documents: 2, tokens: 5, vocabulary: 4 })
  })
})
