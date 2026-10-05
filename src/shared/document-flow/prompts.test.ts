import { describe, expect, it } from 'vitest'

import {
  STATUS_FOOTER_INSTRUCTIONS,
  buildConflictPrompt,
  buildContinuePrompt,
  buildFixTicket,
  buildLaunchPrompt,
  buildNudgePrompt,
  buildQuestionModeNotice,
  isQuestionModeNotice,
  statusFooterInstructions,
  toFileUrl,
  type ConflictPromptInput,
  type FixTicketInput,
  type LaunchPromptInput
} from './prompts'

const launch = (overrides: Partial<LaunchPromptInput> = {}): LaunchPromptInput => ({
  key: '11',
  title: 'Counters',
  sourcePath: '/Users/mor/Desktop/brand-os-bugs (2).html',
  promptStyle: 'full',
  interactive: true,
  sdk: 'claude-code',
  ...overrides
})

const GUARD_LINE =
  'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.'

const conflict = (overrides: Partial<ConflictPromptInput> = {}): ConflictPromptInput => ({
  integrationBranch: 'doc-factory',
  integrationCommit: 'abc123def456',
  conflictedFiles: ['src/i18n/en.json', 'drizzle/meta/_journal.json'],
  mergedTickets: [{ key: 'A1', title: 'Chinese translation' }],
  attempt: 1,
  ...overrides
})

const fix = (overrides: Partial<FixTicketInput> = {}): FixTicketInput => ({
  documentTitle: 'Factory area · Changes round 2',
  key: 'A2',
  title: 'Counters',
  integrationBranch: 'doc-factory',
  verifyCommand: 'pnpm typecheck && pnpm test',
  verifyOutput: '\nsrc/a.ts(3,1): error TS2304: Cannot find name "x".\n',
  attempt: 1,
  ...overrides
})

describe('STATUS_FOOTER_INSTRUCTIONS', () => {
  it('asks for the block the classifier and the footer parser read', () => {
    const lines = STATUS_FOOTER_INSTRUCTIONS.split('\n')
    expect(lines).toContain('STATUS: DONE | BLOCKED')
    for (const label of ['SUMMARY', 'MIGRATIONS', 'MANUAL STEPS', 'ASSUMPTIONS']) {
      expect(lines.some((line) => line.startsWith(`${label}: `))).toBe(true)
    }
    expect(STATUS_FOOTER_INSTRUCTIONS).toContain('Use DONE only when')
  })

  it('sends questions to the question tool instead of offering a way to end on one', () => {
    expect(STATUS_FOOTER_INSTRUCTIONS).toContain(
      'ask through your question tool rather than in the text of your message'
    )
    expect(STATUS_FOOTER_INSTRUCTIONS).not.toContain('NEEDS_INPUT')
    expect(STATUS_FOOTER_INSTRUCTIONS).not.toContain('QUESTIONS')
  })
})

describe('toFileUrl', () => {
  it.each([
    [
      '/Users/mor/Desktop/brand-os-bugs (2).html',
      'file:///Users/mor/Desktop/brand-os-bugs%20(2).html'
    ],
    ['/docs/checkout.html', 'file:///docs/checkout.html'],
    ['/docs/what? #1 100%.md', 'file:///docs/what%3F%20%231%20100%25.md'],
    ['/docs/מפרט é.html', 'file:///docs/%D7%9E%D7%A4%D7%A8%D7%98%20%C3%A9.html'],
    ['C:\\Users\\mor\\spec v2.html', 'file:///C:/Users/mor/spec%20v2.html']
  ])('encodes %s', (path, url) => {
    expect(toFileUrl(path)).toBe(url)
  })
})

describe('buildLaunchPrompt', () => {
  it('is the brief a person would type, plus one guard line', () => {
    expect(buildLaunchPrompt(launch())).toBe(
      [
        'implement task 11 ("Counters") from the file:///Users/mor/Desktop/brand-os-bugs%20(2).html',
        'use subagents to research and read the spec attached there, read the description of it, understand the requirements, research best practices regarding it',
        'if you have any clarifications you might need - use the AskUserQuestion tool to ask me.',
        'then - implement this',
        GUARD_LINE
      ].join('\n\n')
    )
  })

  it('drops only the subagents paragraph in the small style', () => {
    const full = buildLaunchPrompt(launch()).split('\n\n')
    const small = buildLaunchPrompt(launch({ promptStyle: 'small' })).split('\n\n')
    expect(small).toEqual(full.filter((paragraph) => !paragraph.startsWith('use subagents')))
    expect(small).toHaveLength(full.length - 1)
  })

  it('tells an unattended run to pick the recommended approach instead of asking', () => {
    for (const promptStyle of ['full', 'small'] as const) {
      const asking = buildLaunchPrompt(launch({ promptStyle })).split('\n\n')
      const unattended = buildLaunchPrompt(launch({ promptStyle, interactive: false }))
      expect(unattended.split('\n\n')).toEqual(
        asking.map((paragraph) =>
          paragraph.startsWith('if you have any clarifications')
            ? "do not ask me anything - i won't be next to the computer to answer you. if you need a clarification, pick the recommended approach and keep going. only if a decision is too pivotal to make on your own: skip that part, leave it as a gap, and document the gap and the decisions you made in your final message."
            : paragraph
        )
      )
      expect(unattended).not.toContain('AskUserQuestion')
    }
  })

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['claude-code-cli', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['codex-cli', 'request_user_input'],
    ['opencode', 'question']
  ] as const)('names the question tool of %s', (sdk, tool) => {
    expect(buildLaunchPrompt(launch({ sdk }))).toContain(
      `\n\nif you have any clarifications you might need - use the ${tool} tool to ask me.\n\n`
    )
  })

  it('keeps the title on the first line', () => {
    const prompt = buildLaunchPrompt(launch({ key: 'T3', title: ' Export\n dialog ' }))
    expect(prompt.split('\n')[0]).toBe(
      'implement task T3 ("Export dialog") from the file:///Users/mor/Desktop/brand-os-bugs%20(2).html'
    )
    expect(buildLaunchPrompt(launch({ title: '  ' })).split('\n')[0]).toBe(
      'implement task 11 from the file:///Users/mor/Desktop/brand-os-bugs%20(2).html'
    )
  })

  it('leaves the how to the agent: no status block, no file lists, no sibling tickets', () => {
    for (const promptStyle of ['full', 'small'] as const) {
      for (const interactive of [true, false]) {
        const prompt = buildLaunchPrompt(launch({ promptStyle, interactive }))
        expect(prompt).not.toContain('STATUS')
        expect(prompt).not.toContain('QUESTIONS')
        expect(prompt).not.toContain('<ticket')
        expect(prompt.endsWith(`\n\n${GUARD_LINE}`)).toBe(true)
      }
    }
  })
})

describe('buildConflictPrompt', () => {
  it('names the branch, the verified commit, the files and what was merged', () => {
    const prompt = buildConflictPrompt(conflict())
    expect(prompt).toContain('your branch conflicts with `doc-factory`')
    expect(prompt).toContain('Merged into it so far: A1 (Chinese translation).')
    expect(prompt).toContain(
      'Conflicting files:\n- src/i18n/en.json\n- drizzle/meta/_journal.json\n'
    )
    expect(prompt).toContain(
      '1. Run `git merge abc123def456` in this worktree (that is the current verified commit of `doc-factory`; merge that commit, not the branch name'
    )
    expect(prompt).toContain('When `git status` is clean and the merge is committed, you are done.')
    expect(prompt).not.toContain('This is attempt')
  })

  it('falls back to the branch name when no commit is known', () => {
    const prompt = buildConflictPrompt(conflict({ integrationCommit: null }))
    expect(prompt).toContain('1. Run `git merge doc-factory` in this worktree.')
    expect(prompt).not.toContain('verified commit')
  })

  it('copes with unknown files and unknown merged tickets', () => {
    const prompt = buildConflictPrompt(conflict({ conflictedFiles: [], mergedTickets: [] }))
    expect(prompt).toContain('Conflicting files:\n- (run the merge to see them)\n')
    expect(prompt).toContain('Other tasks were merged into it.')
    expect(prompt).not.toContain('Merged into it so far')
  })

  it('says so on a repeated attempt', () => {
    const prompt = buildConflictPrompt(conflict({ attempt: 2 }))
    expect(prompt).toContain('This is attempt 2: the previous resolution still conflicted.')
    expect(prompt).not.toContain('you are done.')
  })

  it('ends with the status footer', () => {
    expect(buildConflictPrompt(conflict()).endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
    expect(
      buildConflictPrompt(conflict({ attempt: 3 })).endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)
    ).toBe(true)
  })
})

describe('buildFixTicket', () => {
  it('describes the failing check', () => {
    const { title, description } = buildFixTicket(fix())
    expect(title).toBe('Fix checks after merging A2 (Factory area · Changes round 2)')
    expect(description).toContain(
      'Task A2 (Counters) was just merged into `doc-factory`, the branch checked out in this worktree.'
    )
    expect(description).toContain('Command:\n```\npnpm typecheck && pnpm test\n```')
    expect(description).toContain(
      'Output (tail):\n```\nsrc/a.ts(3,1): error TS2304: Cannot find name "x".\n```'
    )
    expect(description).not.toContain('This is attempt')
    expect(description).not.toContain('\n\n\n')
  })

  it('keeps quotes, angle brackets and line breaks out of the title', () => {
    const { title } = buildFixTicket(
      fix({ key: 'A"2"', documentTitle: 'Round "2"\r\nsecond <b>line</b>\n' })
    )
    expect(title).not.toMatch(/["<>\r\n]/)
    expect(title).toBe('Fix checks after merging A 2 (Round 2 second b line /b )')
  })

  it('keeps its code fences closed when the output contains one', () => {
    const { description } = buildFixTicket(
      fix({ verifyOutput: 'expected:\n```ts\nconst a = 1\n```\nreceived: nothing' })
    )
    expect(description).toContain(
      'Output (tail):\n`````\nexpected:\n```ts\nconst a = 1\n```\nreceived: nothing\n`````'
    )
    expect(description).toContain('Command:\n`````\n')
  })

  it('says so when the command printed nothing', () => {
    expect(buildFixTicket(fix({ verifyOutput: '  \n' })).description).toContain(
      'Output (tail):\n```\n(no output)\n```'
    )
  })

  it('mentions a repeated attempt', () => {
    const { description } = buildFixTicket(fix({ attempt: 2 }))
    expect(description).toContain(
      '\n\nThis is attempt 2; the previous fix did not make the command pass.\n'
    )
  })

  it('ends with the status footer', () => {
    for (const attempt of [1, 2]) {
      const { description } = buildFixTicket(fix({ attempt }))
      expect(description.endsWith(`\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
      expect(description).toContain('- Commit the fix on this branch.')
    }
  })
})

describe('buildNudgePrompt', () => {
  it('quotes the reason and ends with the status footer', () => {
    const prompt = buildNudgePrompt({ reason: 'The export dialog is listed as still to do.' })
    expect(
      prompt.startsWith(
        'Your last message reads as only partly done:\nThe export dialog is listed as still to do.\n\nContinue until'
      )
    ).toBe(true)
    expect(prompt.endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
  })
})

describe('buildContinuePrompt', () => {
  it('names why the turn ended and ends with the status footer', () => {
    const apiError = buildContinuePrompt('api_error')
    const interrupted = buildContinuePrompt('interrupted')
    expect(
      apiError.startsWith('Your last turn ended on an API error. Continue where you left off')
    ).toBe(true)
    expect(
      interrupted.startsWith('Your last turn was interrupted before it finished. Continue where')
    ).toBe(true)
    for (const prompt of [apiError, interrupted]) {
      expect(prompt).toContain('check `git status` and your earlier progress first')
      expect(prompt.endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
    }
  })
})

describe('statusFooterInstructions', () => {
  it('is the asking footer when agents may ask', () => {
    expect(statusFooterInstructions(true)).toBe(STATUS_FOOTER_INSTRUCTIONS)
  })

  it('swaps only the question line when agents may not ask', () => {
    const asking = statusFooterInstructions(true).split('\n')
    const unattended = statusFooterInstructions(false).split('\n')
    expect(unattended.slice(1)).toEqual(asking.slice(1))
    expect(unattended[0]).toContain('Do not ask me anything')
    expect(unattended[0]).toContain('pick the recommended approach')
    expect(unattended[0]).toContain('leave it as a gap')
    expect(statusFooterInstructions(false)).not.toContain('ask through your question tool')
  })

  it('reaches every follow-up of a run that may not ask', () => {
    const footer = statusFooterInstructions(false)
    const prompts = [
      buildConflictPrompt(conflict({ interactive: false })),
      buildFixTicket(fix({ interactive: false })).description,
      buildNudgePrompt({ reason: 'Tests are still failing.' }, false),
      buildContinuePrompt('api_error', false),
      buildContinuePrompt('interrupted', false)
    ]
    for (const prompt of prompts) {
      expect(prompt.endsWith(`\n${footer}`)).toBe(true)
      expect(prompt).not.toContain('ask through your question tool')
    }
  })
})

describe('buildQuestionModeNotice', () => {
  it('tells a running session to stop asking and how to decide instead', () => {
    const notice = buildQuestionModeNotice({ interactive: false, sdk: 'claude-code' })
    expect(notice).toContain("do not ask me anything - I won't be next to the computer")
    expect(notice).toContain('Do not use the AskUserQuestion tool')
    expect(notice).toContain('pick the recommended approach')
    expect(notice).toContain('too pivotal')
    expect(notice).toContain('leave it as a gap, and document the gap')
  })

  it('tells a running session it may ask again', () => {
    const notice = buildQuestionModeNotice({ interactive: true, sdk: 'claude-code' })
    expect(notice).toContain('use the AskUserQuestion tool to ask me')
    expect(notice).not.toContain('do not ask me anything')
  })

  it.each([
    ['claude-code-cli', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['codex-cli', 'request_user_input'],
    ['opencode', 'question']
  ])('names the question tool of %s in both directions', (sdk, tool) => {
    expect(buildQuestionModeNotice({ interactive: true, sdk })).toContain(`the ${tool} tool`)
    expect(buildQuestionModeNotice({ interactive: false, sdk })).toContain(`the ${tool} tool`)
  })

  it.each([true, false])(
    'is one paragraph that keeps the task going (interactive: %s)',
    (interactive) => {
      const notice = buildQuestionModeNotice({ interactive, sdk: 'claude-code-cli' })
      // Pasted into a CLI's terminal: a line break would submit it early.
      expect(notice).not.toMatch(/[\r\n]/)
      expect(notice).toContain('not a new task')
      expect(notice).toContain('repeat your final message unchanged')
    }
  )
})

describe('isQuestionModeNotice', () => {
  it('recognises the notice of either direction and nothing a user would type', () => {
    for (const sdk of ['claude-code', 'codex', 'opencode']) {
      expect(isQuestionModeNotice(buildQuestionModeNotice({ interactive: true, sdk }))).toBe(true)
      expect(isQuestionModeNotice(buildQuestionModeNotice({ interactive: false, sdk }))).toBe(true)
    }
    expect(isQuestionModeNotice('Change of plans: use the other endpoint instead')).toBe(false)
    expect(isQuestionModeNotice('also add a test')).toBe(false)
  })
})
