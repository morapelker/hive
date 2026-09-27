import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCodexTerminalTitleOverride,
  extractCodexTitles,
  parseCodexTerminalTitle,
  resetAllCodexTitleState
} from '../codex-cli-title'

describe('parseCodexTerminalTitle', () => {
  it('reads run-state, truncated thread id and thread title', () => {
    const info = parseCodexTerminalTitle('Working | 01a07dbd-6a11-7982-a2b6-ceaa4... | Fix flaky test')
    expect(info.runState).toBe('Working')
    expect(info.threadIdPrefix).toBe('01a07dbd-6a11-7982-a2b6-ceaa4')
    expect(info.threadIdIsComplete).toBe(false)
    expect(info.threadTitle).toBe('Fix flaky test')
    expect(info.actionRequired).toBe(false)
  })

  it('treats an unnamed thread (title item falling back to the id) as having no title', () => {
    const info = parseCodexTerminalTitle('Ready | 01a07dbd-6a11-7982-a2b6-ceaa4... | 01a07dbd-6a11-7982-a2b6-ceaa4...')
    expect(info.runState).toBe('Ready')
    expect(info.threadTitle).toBeNull()
  })

  it('completes a truncated thread id from the untruncated title fallback', () => {
    // Observed on codex 0.153.4: the thread-id item is cut to 32 graphemes but the
    // thread-title fallback prints the full 36-char uuid.
    const info = parseCodexTerminalTitle(
      'Working | 01a07df8-e5b1-76d3-8c61-e2ee5... | 01a07df8-e5b1-76d3-8c61-e2ee5fc90528'
    )
    expect(info.threadIdPrefix).toBe('01a07df8-e5b1-76d3-8c61-e2ee5fc90528')
    expect(info.threadIdIsComplete).toBe(true)
    expect(info.threadTitle).toBeNull()
  })

  it('handles a full uuid, the startup state and a missing thread', () => {
    expect(parseCodexTerminalTitle('Starting').runState).toBe('Starting')
    expect(parseCodexTerminalTitle('Starting').threadIdPrefix).toBeNull()
    const full = parseCodexTerminalTitle('Ready | 01a07dbd-6a11-7982-a2b6-ceaa43736708')
    expect(full.threadIdPrefix).toBe('01a07dbd-6a11-7982-a2b6-ceaa43736708')
    expect(full.threadIdIsComplete).toBe(true)
  })

  it('recognizes the action-required prefix in both blink phases', () => {
    expect(parseCodexTerminalTitle('[ ! ] Action Required | 01a07dbd-6a11-7982-a2b6-ceaa4...').actionRequired).toBe(
      true
    )
    const hidden = parseCodexTerminalTitle('[ . ] Action Required | 01a07dbd-6a11-7982-a2b6-ceaa4... | My thread')
    expect(hidden.actionRequired).toBe(true)
    expect(hidden.threadTitle).toBe('My thread')
    expect(hidden.runState).toBeNull()
  })

  it('strips the activity spinner frames that trail title parts while a turn runs', () => {
    const info = parseCodexTerminalTitle('Working | 01a07dbd-6a11-7982-a2b6-ceaa4... | Fix flaky test ⠙')
    expect(info.runState).toBe('Working')
    expect(info.threadIdPrefix).toBe('01a07dbd-6a11-7982-a2b6-ceaa4')
    expect(info.threadTitle).toBe('Fix flaky test')
    expect(parseCodexTerminalTitle('Thinking ⠋').runState).toBe('Thinking')
    expect(parseCodexTerminalTitle('Working | 01a07dbd-6a11-7982-a2b6-ceaa4... ● ⠏').threadIdPrefix).toBe(
      '01a07dbd-6a11-7982-a2b6-ceaa4'
    )
    // Observed on codex 0.154.0 while the thread is being named: the frame also
    // trails the thread-id and thread-title items, and the untruncated id
    // fallback still completes the truncated id.
    const naming = parseCodexTerminalTitle(
      'Working | 01a09797-935a-71d3-88b1-cb182... ⠹ | 01a09797-935a-71d3-88b1-cb182c71017b ⠹ ⠹'
    )
    expect(naming.runState).toBe('Working')
    expect(naming.threadIdPrefix).toBe('01a09797-935a-71d3-88b1-cb182c71017b')
    expect(naming.threadIdIsComplete).toBe(true)
    expect(naming.threadTitle).toBeNull()
    expect(parseCodexTerminalTitle('Ready | 01a07dbd-6a11-7982-a2b6-ceaa4...').runState).toBe('Ready')
    // A part that is nothing but frames is not a thread title.
    expect(parseCodexTerminalTitle('Working | ⠋').threadTitle).toBeNull()
  })

  it('reads the action-required title exactly as codex 0.154.0 emits it around a question', () => {
    // A pending request_user_input: the run-state item is dropped, the prefix
    // blinks, and spinner frames may still trail the thread items.
    const pending = parseCodexTerminalTitle(
      '[ ! ] Action Required | 01a09797-935a-71d3-88b1-cb182... ⠧ | 01a09797-935a-71d3-88b1-cb182c71017b ⠧'
    )
    expect(pending.actionRequired).toBe(true)
    expect(pending.runState).toBeNull()
    expect(pending.threadIdPrefix).toBe('01a09797-935a-71d3-88b1-cb182c71017b')
    expect(pending.threadTitle).toBeNull()
    const named = parseCodexTerminalTitle('[ . ] Action Required | 01a09797-935a-71d3-88b1-cb182... | Ask color preference')
    expect(named.actionRequired).toBe(true)
    expect(named.threadTitle).toBe('Ask color preference')
    // Answered: the turn resumes with the spinner, then idles without it.
    const resumed = parseCodexTerminalTitle('Working | 01a09797-935a-71d3-88b1-cb182... | Ask color preference ⠋')
    expect(resumed.actionRequired).toBe(false)
    expect(resumed.runState).toBe('Working')
    expect(resumed.threadTitle).toBe('Ask color preference')
  })

  it('does not mistake ordinary claude-style titles for codex state', () => {
    const info = parseCodexTerminalTitle('✳ Refactoring the parser')
    expect(info.runState).toBeNull()
    expect(info.threadIdPrefix).toBeNull()
    expect(info.threadTitle).toBe('✳ Refactoring the parser')
  })
})

describe('extractCodexTitles', () => {
  afterEach(() => resetAllCodexTitleState())

  it('returns every complete OSC 0/2 title in a chunk, in order', () => {
    const chunk = 'noise\x1b]0;Starting\x07more\x1b]2;Ready | abc\x1b\\tail'
    expect(extractCodexTitles('s', chunk)).toEqual(['Starting', 'Ready | abc'])
  })

  it('completes a title split across two chunks', () => {
    expect(extractCodexTitles('s', 'x\x1b]0;Work')).toEqual([])
    expect(extractCodexTitles('s', 'ing | id\x07y')).toEqual(['Working | id'])
    // The tail was consumed; unrelated later output yields nothing.
    expect(extractCodexTitles('s', 'plain text')).toEqual([])
  })

  it('keeps sessions independent', () => {
    expect(extractCodexTitles('a', '\x1b]0;Rea')).toEqual([])
    expect(extractCodexTitles('b', 'dy\x07')).toEqual([])
    expect(extractCodexTitles('a', 'dy\x07')).toEqual(['Ready'])
  })
})

describe('buildCodexTerminalTitleOverride', () => {
  it('turns on the run-state / thread-id / thread-title / activity items', () => {
    expect(buildCodexTerminalTitleOverride()).toBe(
      'tui.terminal_title=["run-state","thread-id","thread-title","activity"]'
    )
  })
})
