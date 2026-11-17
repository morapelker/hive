// @vitest-environment node
// The parts of the opt-in live test of Code Mode usage that decide how it fails
// (code-mode-live-session.ts), without a CLI or an account: what a session's screen says about
// Code Mode, what of a screen may be shown in a report, and a wait that ends with a reason.
import { afterEach, describe, expect, it } from 'vitest'
import {
  LiveSessionScreen,
  readCodeModeScreen,
  redactForReport,
  waitForLive
} from './code-mode-live-session'

// As CLI 2.1.326 prints them: the notice in a session started with the Code Mode variable,
// and the refusal for a session that has an API address of its own (ANTHROPIC_BASE_URL).
const ON_NOTICE =
  'Code Mode (experimental) is on · this session can be resumed only with Code Mode on'
const REFUSAL =
  "Code Mode (experimental) isn't available: for now it only works directly with the " +
  'Anthropic API (not through a cloud provider such as Bedrock, a gateway or another ' +
  'address in ANTHROPIC_BASE_URL). Starting with the ordinary tools.'
/** The rows of a 120-column screen that showed the refusal, from a real session. */
const REFUSAL_SCREEN = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.326',
  '▝▜██████▀  Haiku 5.5 · Claude API',
  ' ▝▝   ▝▝   ~/code/project',
  '',
  "⚠ Code Mode (experimental) isn't available: for now it only works directly with the Anthropic API (not through a cloud",
  '  provider such as Bedrock, a gateway or another address in ANTHROPIC_BASE_URL). Starting with the ordinary tools.',
  '',
  '',
  '                                                                                                    ◐ medium · /effort',
  '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '❯ Try "create a util logging.py that…"',
  '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  Haiku 5.5 | ctx n/a | project',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'
].join('\n')
/** The rows around the notice, from a real session on a 120-column screen. */
const ON_SCREEN = [
  ' ▐▛███▛█   Claude Code v2.1.326',
  '▝▜██████▀  Haiku 5.5 · Claude API',
  ' ▝▝   ▝▝   /private/var/folders/bt/x/T/code-mode-usage-live-W6OvR4/project',
  '⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on',
  '▎ Debug mode enabled · logging to /private/var/folders/bt/x/T/code-mode-usage-live-W6OvR4/d',
  '▎ ata/claude-cli-debug/code-mode-live-mwktmqtp-49303-83010309c2420b7e/usage.log',
  '❯ Join these letters into one word and reply with that word only, in capitals: Z E B R A F I S H',
  '⏺ ZEBRAFISH'
].join('\n')

describe('readCodeModeScreen', () => {
  it('reads the notice that Code Mode is on', () => {
    expect(readCodeModeScreen(`Welcome back\n\n ${ON_NOTICE}\n\n> `)).toEqual({ kind: 'on' })
  })

  it('reads the screen of a real session in Code Mode', () => {
    expect(readCodeModeScreen(ON_SCREEN)).toEqual({ kind: 'on' })
  })

  it("reads the screen of a real session that was refused Code Mode, with the CLI's sentence", () => {
    expect(readCodeModeScreen(REFUSAL_SCREEN)).toEqual({ kind: 'unavailable', notice: REFUSAL })
  })

  it('reads the notice when it is wrapped over two rows', () => {
    const screen = ' Code Mode (experimental) is\n on · this session can be resumed only with'
    expect(readCodeModeScreen(screen)).toEqual({ kind: 'on' })
  })

  it("reads a refusal with the CLI's own sentence, up to the end of its paragraph", () => {
    const wrapped = REFUSAL.replace('directly with the ', 'directly with the\n  ').replace(
      'a gateway ',
      'a gateway\n  '
    )
    const reading = readCodeModeScreen(`Debug mode enabled\n\n  ${wrapped}\n\n> Reply with OK`)
    expect(reading).toEqual({ kind: 'unavailable', notice: REFUSAL })
  })

  it('reads a refusal written with a typographic apostrophe', () => {
    const reading = readCodeModeScreen('Code Mode (experimental) isn’t available for this account')
    expect(reading).toEqual({
      kind: 'unavailable',
      notice: 'Code Mode (experimental) isn’t available for this account'
    })
  })

  it('cuts a refusal that has no end in sight', () => {
    const reading = readCodeModeScreen(`${REFUSAL} ${'more '.repeat(200)}`)
    expect(reading.kind).toBe('unavailable')
    if (reading.kind !== 'unavailable') return
    expect(reading.notice.length).toBe(401)
    expect(reading.notice.endsWith('…')).toBe(true)
  })

  it('reads the consent dialog as a question that waits for an answer', () => {
    const screen = [
      ' Turn on Code Mode?',
      ' ❯ 1. No, start without it',
      '   2. Yes, turn on Code Mode'
    ].join('\n')
    expect(readCodeModeScreen(screen)).toEqual({ kind: 'consent-needed' })
  })

  it('lets the notice that it is on count over everything else on the screen', () => {
    const screen = `${REFUSAL}\n\n2. Yes, turn on Code Mode\n\n${ON_NOTICE}`
    expect(readCodeModeScreen(screen)).toEqual({ kind: 'on' })
  })

  it('knows nothing from a screen that does not speak of Code Mode', () => {
    expect(readCodeModeScreen('')).toEqual({ kind: 'unknown' })
    expect(readCodeModeScreen('Debug mode enabled · logging to /x/usage.log\n> ')).toEqual({
      kind: 'unknown'
    })
    // Not the notice: a sentence about Code Mode that says something else.
    expect(readCodeModeScreen('Code Mode (experimental) is only for some plans')).toEqual({
      kind: 'unknown'
    })
  })
})

describe('redactForReport', () => {
  it('takes out e-mail addresses and tokens, and keeps eight characters of an id', () => {
    const text =
      'Signed in as Some.One+test@example.co.uk · org 3ccde938-1a2b-4c3d-8e9f-0123456789ab ' +
      '· key sk-ant-oat01-AbC_dEf-123'
    expect(redactForReport(text)).toBe('Signed in as <email> · org 3ccde938… · key <token>')
  })

  it('leaves ordinary screen text as it is', () => {
    const text = 'Debug mode enabled · logging to /private/var/folders/x/usage.log @ 12:01'
    expect(redactForReport(text)).toBe(text)
  })
})

describe('LiveSessionScreen', () => {
  let screen: LiveSessionScreen | null = null
  afterEach(() => {
    screen?.dispose()
    screen = null
  })

  it('lays the output of a terminal program out as rows of text', async () => {
    screen = new LiveSessionScreen(40, 6)
    // Two rows written out of order with cursor moves, and a gap made by moving the cursor
    // forward instead of printing spaces.
    screen.feed('\x1b[2;1Hsecond\x1b[3Crow')
    screen.feed('\x1b[1;1H\x1b[1mfirst\x1b[0m row')
    await screen.settled()
    expect(screen.text()).toBe('first row\nsecond   row')
  })

  it('keeps a line the terminal broke at its right edge as one row', async () => {
    screen = new LiveSessionScreen(10, 4)
    screen.feed('one two three four\r\nnext')
    await screen.settled()
    expect(screen.text()).toBe('one two three four\nnext')
  })

  it('reads Code Mode from a notice that arrives in pieces and is repainted', async () => {
    screen = new LiveSessionScreen(120, 10)
    screen.feed('\x1b[?1049h\x1b[2J\x1b[H')
    screen.feed('\x1b[3;2HCode\x1b[1CMode\x1b[1C(experi')
    await screen.settled()
    expect(screen.codeModeReading()).toEqual({ kind: 'unknown' })
    screen.feed('mental)\x1b[1Cis\x1b[1Con \xb7 this session can be resumed only with Code Mode on')
    await screen.settled()
    expect(screen.codeModeReading()).toEqual({ kind: 'on' })
  })

  it('keeps "on" after the notice has been painted over', async () => {
    screen = new LiveSessionScreen(120, 10)
    screen.feed(`\x1b[2;1H${ON_NOTICE}`)
    await screen.settled()
    screen.feed('\x1b[2J\x1b[HOK')
    await screen.settled()
    expect(screen.text()).toBe('OK')
    expect(screen.codeModeReading()).toEqual({ kind: 'on' })
  })

  it('keeps a refusal after it has been painted over, and forgets an answered dialog', async () => {
    screen = new LiveSessionScreen(200, 10)
    screen.feed('\x1b[2;1H   2. Yes, turn on Code Mode')
    await screen.settled()
    expect(screen.codeModeReading()).toEqual({ kind: 'consent-needed' })
    screen.feed('\x1b[2J\x1b[HRestarting')
    await screen.settled()
    expect(screen.codeModeReading()).toEqual({ kind: 'unknown' })

    screen.feed(`\x1b[2J\x1b[H${REFUSAL}`)
    await screen.settled()
    screen.feed('\x1b[2J\x1b[HOK')
    await screen.settled()
    expect(screen.codeModeReading()).toEqual({ kind: 'unavailable', notice: REFUSAL })
  })

  it('says how long the screen has stood still, whatever was printed meanwhile', async () => {
    let time = 10_000
    screen = new LiveSessionScreen(40, 6, () => time)
    expect(screen.quietFor()).toBe(0)
    time += 400
    screen.feed('working')
    await screen.settled()
    expect(screen.quietFor()).toBe(0)
    time += 700
    // Output that leaves every row as it was: colours, a cursor that moves and comes back.
    screen.feed('\x1b[0m\x1b[1A\x1b[1B')
    await screen.settled()
    expect(screen.quietFor()).toBe(700)
    time += 900
    expect(screen.quietFor()).toBe(1_600)
    screen.feed('\rworked.')
    await screen.settled()
    expect(screen.quietFor()).toBe(0)
  })

  it('reports the last rows of the screen without what must not be shown', async () => {
    screen = new LiveSessionScreen(100, 8)
    screen.feed('Welcome someone@example.com\r\n\r\n> Reply with OK   \r\n')
    await screen.settled()
    expect(screen.report()).toBe('  | Welcome <email>\n  | > Reply with OK')
  })

  it('says so when the screen is empty', () => {
    screen = new LiveSessionScreen(80, 24)
    expect(screen.report()).toBe('  (the screen is empty)')
  })

  it('takes no more output once it is disposed of', async () => {
    screen = new LiveSessionScreen(80, 24)
    screen.dispose()
    screen.feed('late')
    await screen.settled()
    expect(screen.text()).toBe('')
  })
})

describe('waitForLive', () => {
  /** A clock that only moves when the wait sleeps. */
  const clock = (): {
    now: () => number
    sleep: (ms: number) => Promise<void>
    slept: number[]
  } => {
    let time = 1_000
    const slept: number[] = []
    return {
      now: () => time,
      sleep: async (ms) => {
        slept.push(ms)
        time += ms
      },
      slept
    }
  }

  it('returns the value as soon as there is one', async () => {
    const { now, sleep, slept } = clock()
    let looks = 0
    const value = await waitForLive({
      what: 'the third look',
      timeoutMs: 1_000,
      look: () => (++looks === 3 ? 'there' : undefined),
      now,
      sleep
    })
    expect(value).toBe('there')
    expect(slept).toEqual([100, 100])
  })

  it('takes a value that is falsy but not undefined', async () => {
    const { now, sleep } = clock()
    expect(await waitForLive({ what: 'zero', timeoutMs: 10, look: () => 0, now, sleep })).toBe(0)
  })

  it('runs out saying what it waited for, for how long, and what was known', async () => {
    const { now, sleep, slept } = clock()
    const waiting = waitForLive({
      what: 'the session to report "Code Mode (experimental) is on"',
      timeoutMs: 2_250,
      intervalMs: 1_000,
      look: async () => undefined,
      context: () => 'The screen:\n  | > ',
      now,
      sleep
    })
    await expect(waiting).rejects.toThrow(
      'Gave up after 2 s waiting for the session to report "Code Mode (experimental) is on".\n' +
        'The screen:\n  | > '
    )
    // Never past its limit: the last sleep is what was left of it.
    expect(slept).toEqual([1_000, 1_000, 250])
  })

  it('runs out without a context when none was given', async () => {
    const { now, sleep } = clock()
    await expect(
      waitForLive({ what: 'nothing', timeoutMs: 0, look: () => undefined, now, sleep })
    ).rejects.toThrow(/^Gave up after 0 s waiting for nothing\.$/)
  })

  it('ends at once with the error of a look that gives up', async () => {
    const { now, sleep, slept } = clock()
    let looks = 0
    const waiting = waitForLive({
      what: 'a response',
      timeoutMs: 60_000,
      look: () => {
        if (++looks === 2) throw new Error('The Claude CLI ended (exit code 1)')
        return undefined
      },
      context: () => 'never asked for',
      now,
      sleep
    })
    await expect(waiting).rejects.toThrow(/^The Claude CLI ended \(exit code 1\)$/)
    expect(slept).toEqual([100])
  })
})
