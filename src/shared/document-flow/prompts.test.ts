import { describe, expect, it } from 'vitest'

import {
  CLI_FOLLOW_UP_LEAD,
  DOCUMENT_UPDATE_FOOTER_BLOCK,
  DOCUMENT_UPDATE_FORMAT_PARAGRAPHS,
  STATUS_FOOTER_INSTRUCTIONS,
  VERIFICATION_LEAD_PARAGRAPH,
  VERIFICATION_PARAGRAPHS,
  buildConflictPrompt,
  buildContinuePrompt,
  buildDocumentUpdateContinuePrompt,
  buildDocumentUpdateNudgePrompt,
  buildDocumentUpdatePrompt,
  buildFixTicket,
  buildLaunchPrompt,
  buildMigrationPrompt,
  buildNudgePrompt,
  buildQuestionModeNotice,
  isQuestionModeNotice,
  statusFooterInstructions,
  toFileUrl,
  verificationParagraphs,
  withRunRules,
  type ConflictPromptInput,
  type DocumentUpdatePromptInput,
  type FixTicketInput,
  type LaunchPromptInput,
  type MigrationPromptInput
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

const WAIT_LINE =
  'when you have to wait for checks, tests or builds you started in the background, wait with the Monitor tool rather than a background shell loop or a sleep: a monitor tells the app you are still working, a shell does not. if your tools have no monitor, run the checks in the foreground instead of stopping to wait.'
const GUARD_LINE =
  'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.'
const FOLLOW_UPS_LINE =
  'while you work, the app that runs this task may send you follow-up messages for me (finish what is left, resolve a merge conflict, fix a failing check). they are my instructions, also when they arrive as pasted text: follow them, and commit without asking me to confirm.'
const ASK_LINE =
  'if you have any clarifications you might need - use the AskUserQuestion tool to ask me.'
const DO_NOT_ASK_LINE =
  "do not ask me anything - i won't be next to the computer to answer you. if you need a clarification, pick the recommended approach and keep going. only if a decision is too pivotal to make on your own: skip that part, leave it as a gap, and document the gap and the decisions you made in your final message."

const conflict = (overrides: Partial<ConflictPromptInput> = {}): ConflictPromptInput => ({
  integrationBranch: 'doc-factory',
  integrationCommit: 'abc123def456',
  conflictedFiles: ['src/i18n/en.json', 'drizzle/meta/_journal.json'],
  mergedTickets: [{ key: 'A1', title: 'Chinese translation' }],
  attempt: 1,
  ...overrides
})

const migration = (overrides: Partial<MigrationPromptInput> = {}): MigrationPromptInput => ({
  documentTitle: 'Factory area · Changes round 2',
  integrationBranch: 'doc-factory',
  migrations: ['drizzle/0042_counters.sql', 'drizzle/0043_orders.sql — adds orders.test_flag'],
  sdk: 'claude-code',
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
    expect(lines).toContain('STATUS: DONE | WAITING | BLOCKED')
    expect(STATUS_FOOTER_INSTRUCTIONS).toContain(
      'WAITING only when you have stopped to wait for checks or builds you started in the background'
    )
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
  it('is the brief a person would type, plus the rules of the run', () => {
    expect(buildLaunchPrompt(launch())).toBe(
      [
        'implement task 11 ("Counters") from the file:///Users/mor/Desktop/brand-os-bugs%20(2).html',
        'use subagents to research and read the spec attached there, read the description of it, understand the requirements, research best practices regarding it',
        ASK_LINE,
        'then - implement this',
        WAIT_LINE,
        GUARD_LINE,
        FOLLOW_UPS_LINE
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
          paragraph.startsWith('if you have any clarifications') ? DO_NOT_ASK_LINE : paragraph
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
        expect(prompt.endsWith(`\n\n${WAIT_LINE}\n\n${GUARD_LINE}\n\n${FOLLOW_UPS_LINE}`)).toBe(
          true
        )
      }
    }
  })
})

describe('withRunRules', () => {
  it('leaves a brief that already carries the rules of the run as it is', () => {
    for (const interactive of [true, false]) {
      const brief = buildLaunchPrompt(launch({ interactive }))
      expect(withRunRules(brief, { interactive, sdk: 'claude-code' })).toBe(brief)
    }
  })

  it('follows the setting as it is now, not as it was when the brief was written', () => {
    const asking = buildLaunchPrompt(launch())
    const unattended = buildLaunchPrompt(launch({ interactive: false }))
    expect(withRunRules(asking, { interactive: false, sdk: 'claude-code' })).toBe(unattended)
    expect(withRunRules(unattended, { interactive: true, sdk: 'claude-code' })).toBe(asking)
  })

  it('names the question tool of the agent the ticket is launched with', () => {
    const brief = buildLaunchPrompt(launch({ sdk: 'claude-code' }))
    expect(withRunRules(brief, { interactive: true, sdk: 'codex-cli' })).toBe(
      buildLaunchPrompt(launch({ sdk: 'codex-cli' }))
    )
  })

  it('adds the rules to a brief that has none: an edited one, or one of an older run', () => {
    const brief = 'Implement task 14 — Test orders — from the spec document "Factory area".'
    expect(withRunRules(`\n${brief}\n`, { interactive: false, sdk: 'claude-code-cli' })).toBe(
      [brief, DO_NOT_ASK_LINE, WAIT_LINE, GUARD_LINE, FOLLOW_UPS_LINE].join('\n\n')
    )
    expect(withRunRules(`${brief}\n\n${GUARD_LINE}`, { interactive: true, sdk: 'opencode' })).toBe(
      [
        brief,
        GUARD_LINE,
        'if you have any clarifications you might need - use the question tool to ask me.',
        WAIT_LINE,
        FOLLOW_UPS_LINE
      ].join('\n\n')
    )
  })

  it('keeps one asking paragraph when the brief holds both', () => {
    const brief = ['do the task', ASK_LINE, DO_NOT_ASK_LINE, WAIT_LINE, GUARD_LINE, FOLLOW_UPS_LINE]
    expect(withRunRules(brief.join('\n\n'), { interactive: false, sdk: 'claude-code' })).toBe(
      ['do the task', DO_NOT_ASK_LINE, WAIT_LINE, GUARD_LINE, FOLLOW_UPS_LINE].join('\n\n')
    )
  })
})

describe('buildMigrationPrompt', () => {
  it('names the branch, production and the document the work came from', () => {
    const [first] = buildMigrationPrompt(migration()).split('\n\n')
    expect(first).toBe(
      'execute the migrations of this branch (doc-factory) against production. the branch holds the merged work of the document run "Factory area · Changes round 2"; these are the migrations it added or changed:'
    )
  })

  it('lists every migration as a bullet of its own, in the order of the report', () => {
    const paragraphs = buildMigrationPrompt(migration()).split('\n\n')
    expect(paragraphs[1]).toBe(
      '- drizzle/0042_counters.sql\n- drizzle/0043_orders.sql — adds orders.test_flag'
    )
  })

  it('keeps each migration on one line and drops the blank ones', () => {
    const prompt = buildMigrationPrompt(
      migration({
        migrations: ['  drizzle/0042_counters.sql\n   adds\tthe counters table  ', ' \n ', 'b.sql']
      })
    )
    expect(prompt.split('\n\n')[1]).toBe(
      '- drizzle/0042_counters.sql adds the counters table\n- b.sql'
    )
  })

  it('has the agent read what production already has before it runs anything', () => {
    const paragraphs = buildMigrationPrompt(migration()).split('\n\n')
    const check = paragraphs.findIndex((paragraph) =>
      paragraph.includes(
        'check against production which of these migrations have already been applied'
      )
    )
    const run = paragraphs.findIndex((paragraph) =>
      paragraph.startsWith('then run the ones that have not been applied yet, in order')
    )
    expect(check).toBeGreaterThan(1)
    expect(run).toBeGreaterThan(check)
    expect(paragraphs[check]).toContain("do not take the list's word for it")
    expect(paragraphs[check]).toContain('read the production migration state')
    expect(paragraphs[run]).toContain('never re-run a migration that is already applied')
    expect(paragraphs[run]).toContain('do not edit the migration files')
  })

  it('tells the agent to stop and report instead of guessing or working around a failure', () => {
    const prompt = buildMigrationPrompt(migration())
    expect(prompt).toContain(
      'if you cannot reach production, cannot tell whether a migration was applied, or a migration fails: stop there and tell me, do not guess and do not work around it.'
    )
    expect(prompt.split('\n\n').at(-1)).toBe(
      'when you are done, tell me which migrations were already applied, which ones you ran, and anything that failed or is left for me.'
    )
  })

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['claude-code-cli', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['codex-cli', 'request_user_input'],
    ['opencode', 'question']
  ] as const)('names the question tool of %s', (sdk, tool) => {
    expect(buildMigrationPrompt(migration({ sdk }))).toContain(
      `if you have any clarifications you might need - use the ${tool} tool to ask me.\n\n`
    )
  })

  it('keeps the title on the first line, and leaves it out when there is none', () => {
    const titled = buildMigrationPrompt(migration({ documentTitle: ' Factory\n area ' }))
    expect(titled.split('\n')[0]).toContain('the document run "Factory area"; these are')

    for (const documentTitle of ['', '  \n ']) {
      const [first] = buildMigrationPrompt(migration({ documentTitle })).split('\n')
      expect(first).toBe(
        'execute the migrations of this branch (doc-factory) against production. the branch holds the merged work of the document run; these are the migrations it added or changed:'
      )
      expect(first).not.toContain('""')
    }
  })

  it('is the whole prompt: neither the rules of a ticket of the run nor its status footer', () => {
    const prompt = buildMigrationPrompt(migration())
    // A ticket of the run is told never to run migrations; this session is told to.
    expect(prompt).not.toContain('do not run migrations against any database')
    expect(prompt).not.toContain('implement only this task')
    expect(prompt).not.toContain('STATUS')
    expect(withRunRules(prompt, { interactive: true, sdk: 'claude-code' })).not.toBe(prompt)
  })
})

describe('CLI_FOLLOW_UP_LEAD', () => {
  it('is one line of plain words, safe to type into a terminal', () => {
    expect(CLI_FOLLOW_UP_LEAD).toMatch(/^[A-Za-z][A-Za-z ,.]+:$/)
    expect(CLI_FOLLOW_UP_LEAD).toContain('my own instructions')
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
  it('tells an agent whose wait for background work ran out to check on it and finish', () => {
    const reason = 'It waits for the typecheck, the tests and the lint it started.'
    const prompt = buildNudgePrompt({ status: 'waiting', reason })
    expect(
      prompt.startsWith(
        `Your last message said you were waiting for background work you started:\n${reason}\n\nNothing has come back since`
      )
    ).toBe(true)
    expect(prompt).toContain('Do not stop to wait again unless you have started a Monitor')
    expect(prompt.endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
    // The same when the wait was read without the classifier: it does say something.
    expect(buildNudgePrompt({ status: 'waiting', reason, source: 'fallback' })).toBe(prompt)
  })

  it('quotes the reason and ends with the status footer', () => {
    const prompt = buildNudgePrompt({ reason: 'The export dialog is listed as still to do.' })
    expect(
      prompt.startsWith(
        'Your last message reads as only partly done:\nThe export dialog is listed as still to do.\n\nContinue until'
      )
    ).toBe(true)
    expect(prompt.endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
  })

  it('tells an agent that waits for an answer to decide and commit on its own', () => {
    const prompt = buildNudgePrompt(
      {
        status: 'needs_input',
        reason: 'The agent waits for a go-ahead to commit.',
        question: 'reply "commit" and I\'ll run the verify step and commit.'
      },
      false
    )
    expect(
      prompt.startsWith(
        'Your last message waits for an answer or a go-ahead from me:\nreply "commit" and I\'ll run the verify step and commit.\n\nNobody will answer: I am not at the computer. Decide it yourself'
      )
    ).toBe(true)
    expect(prompt).toContain('You do not need my go-ahead to commit on this branch.')
    expect(prompt.endsWith(`\n\n${statusFooterInstructions(false)}`)).toBe(true)
    // Without a quoted question the reason stands in for it.
    expect(
      buildNudgePrompt({ status: 'needs_input', reason: 'It asks which API to use.' }, false)
    ).toContain('go-ahead from me:\nIt asks which API to use.\n\n')
  })

  it.each(['blocked', 'failed'] as const)(
    'tells an agent that reported %s to work around it and commit what it can',
    (status) => {
      const prompt = buildNudgePrompt({ status, reason: 'The staging database is down.' }, false)
      expect(
        prompt.startsWith(
          'Your last message reads as stopped short of done:\nThe staging database is down.\n\nNobody is here to unblock it.'
        )
      ).toBe(true)
      expect(prompt).toContain('Report BLOCKED only if no part of the task can be done.')
    }
  )

  it('does not quote a reason that only says the message could not be judged', () => {
    const prompt = buildNudgePrompt(
      {
        status: 'blocked',
        source: 'fallback',
        reason: 'The final message could not be judged (timeout), and it may report a problem.'
      },
      false
    )
    expect(
      prompt.startsWith(
        'I could not tell from your last message whether the task is finished.\n\nIf it is not, continue'
      )
    ).toBe(true)
    expect(prompt).not.toContain('could not be judged')
    // A closing question is something the fallback did read in the message.
    expect(
      buildNudgePrompt(
        { status: 'needs_input', source: 'fallback', reason: 'r', question: 'Which one?' },
        false
      )
    ).toContain('go-ahead from me:\nWhich one?')
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

describe('verification paragraphs', () => {
  const LEAD = VERIFICATION_LEAD_PARAGRAPH
  const TCU = VERIFICATION_PARAGRAPHS.tcu
  const PLAYWRIGHT = VERIFICATION_PARAGRAPHS.playwright
  const TESTS = VERIFICATION_PARAGRAPHS.tests

  it('says nothing about verification when no method is chosen', () => {
    expect(verificationParagraphs([])).toEqual([])
    expect(verificationParagraphs(undefined)).toEqual([])
    expect(verificationParagraphs(null)).toEqual([])
    expect(buildLaunchPrompt(launch())).toBe(buildLaunchPrompt(launch({ verification: [] })))
    expect(buildLaunchPrompt(launch())).not.toContain('verify')
  })

  it('puts the lead and the chosen methods, in canonical order, before the rules of the run', () => {
    expect(verificationParagraphs(['tests', 'tcu'])).toEqual([LEAD, TCU, TESTS])
    const prompt = buildLaunchPrompt(launch({ verification: ['tests', 'playwright'] }))
    expect(prompt.split('\n\n')).toEqual([
      'implement task 11 ("Counters") from the file:///Users/mor/Desktop/brand-os-bugs%20(2).html',
      'use subagents to research and read the spec attached there, read the description of it, understand the requirements, research best practices regarding it',
      ASK_LINE,
      'then - implement this',
      LEAD,
      PLAYWRIGHT,
      TESTS,
      WAIT_LINE,
      GUARD_LINE,
      FOLLOW_UPS_LINE
    ])
  })

  it('tells the agent how each channel works, and to report what it checked', () => {
    expect(LEAD).toContain('say what you checked and how')
    expect(LEAD).toContain('never describe a check you did not run')
    expect(TCU).toContain('tcu state')
    expect(TCU).toContain('--diff')
    expect(PLAYWRIGHT).toContain(
      'playwright-cli -s=<a unique session name> attach --cdp=http://127.0.0.1:9222'
    )
    expect(PLAYWRIGHT).toContain('--remote-debugging-port=9222')
    expect(TESTS).toContain('add or update unit, integration or end-to-end tests')
    expect(TESTS).toContain("run those first, then the project's test suite")
  })

  it('withRunRules writes the choice of the launch over whatever the brief carried', () => {
    const written = buildLaunchPrompt(launch({ verification: ['tcu'] }))
    // The run now skips verification: every verification paragraph goes.
    const skipped = withRunRules(written, {
      interactive: true,
      sdk: 'claude-code',
      verification: []
    })
    expect(skipped).toBe(buildLaunchPrompt(launch()))
    // Another choice replaces the old one, in place.
    const changed = withRunRules(written, {
      interactive: true,
      sdk: 'claude-code',
      verification: ['playwright', 'tests']
    })
    expect(changed).toBe(buildLaunchPrompt(launch({ verification: ['playwright', 'tests'] })))
    expect(changed.split(LEAD)).toHaveLength(2)
    // The same choice leaves the brief as it is.
    expect(
      withRunRules(written, { interactive: true, sdk: 'claude-code', verification: ['tcu'] })
    ).toBe(written)
  })

  it('withRunRules adds the choice to a brief that has none, before the rules', () => {
    const edited = `do task 11 your way\n\n${GUARD_LINE}\n\n${FOLLOW_UPS_LINE}`
    const result = withRunRules(edited, {
      interactive: false,
      sdk: 'codex',
      verification: ['tests']
    })
    expect(result.split('\n\n')).toEqual([
      'do task 11 your way',
      LEAD,
      TESTS,
      GUARD_LINE,
      FOLLOW_UPS_LINE,
      DO_NOT_ASK_LINE,
      WAIT_LINE
    ])
    // A brief without the rules gets the choice, then the rules.
    expect(
      withRunRules('do task 11', { interactive: true, sdk: 'claude-code', verification: ['tcu'] })
    ).toBe(['do task 11', LEAD, TCU, ASK_LINE, WAIT_LINE, GUARD_LINE, FOLLOW_UPS_LINE].join('\n\n'))
  })
})

const documentUpdate = (
  overrides: Partial<DocumentUpdatePromptInput> = {}
): DocumentUpdatePromptInput => ({
  key: 'A2',
  title: 'Checkout redesign',
  sourcePath: '/Users/me/docs/checkout-redesign.html',
  format: 'html',
  encoding: 'utf-8',
  insideRepo: false,
  integrationBranch: 'doc-factory',
  branchName: 'tedooo/a2-checkout-redesign',
  mergeSha: 'abc123def456',
  verdict: {
    status: 'done',
    reason: 'The agent says the task is implemented and committed.',
    summary: 'Rebuilt the checkout page as a two-column layout.',
    migrations: [],
    manualSteps: []
  },
  verification: ['tests', 'playwright'],
  verifyCommand: 'pnpm check',
  fixAttempts: 0,
  assetsDir: '/Users/me/docs/checkout-redesign.assets',
  otherTasks: ['A1', 'A3'],
  today: '2026-10-19',
  interactive: true,
  ...overrides
})

describe('buildDocumentUpdatePrompt', () => {
  it('names the source document by its absolute path and forbids the worktree copy and commits', () => {
    const prompt = buildDocumentUpdatePrompt(documentUpdate())
    expect(prompt).toContain('The document: `/Users/me/docs/checkout-redesign.html`')
    expect(prompt).not.toContain('file://')
    expect(prompt).toContain(
      'do not edit a copy of it inside your worktree (a file there with the same name is a different file)'
    )
    expect(prompt).toContain('do not commit it, stage it or run git in its directory')
    expect(prompt).toContain('no code changes and no commits')
    expect(prompt).toContain('never by rewriting the whole file')
    expect(prompt).toContain('Read the file right before you edit it')
  })

  it("lifts the ticket's read-only note for the document, but not for the run's text copy", () => {
    const prompt = buildDocumentUpdatePrompt(
      documentUpdate({ documentCopyPath: '/Users/me/.hive/document-runs/r1/document.md' })
    )
    expect(prompt).toContain(
      "Your task listed the spec files as read-only: that no longer holds for this file, which you now edit, but it still holds for the run's text copy of it (`/Users/me/.hive/document-runs/r1/document.md`): do not edit that one."
    )
    expect(buildDocumentUpdatePrompt(documentUpdate())).toContain(
      'that no longer holds for this file, which you now edit.'
    )
  })

  it('says what was merged, where, and how it was checked', () => {
    const prompt = buildDocumentUpdatePrompt(documentUpdate())
    expect(prompt.split('\n', 1)[0]).toBe(
      'Your task A2 ("Checkout redesign") is merged into `doc-factory` (merge commit `abc123def456`). One last step: record in the document this run was made from what was done, how it was verified, and what is left.'
    )
    expect(prompt).toContain(
      '   - Merged: `tedooo/a2-checkout-redesign` into `doc-factory` at `abc123def456`'
    )
    expect(prompt).toContain('   - Status: Done | Partially done | Not done (2026-10-19)')
    expect(prompt).toContain('- Summary: Rebuilt the checkout page as a two-column layout.')
    expect(prompt).toContain('- Verification asked for: tests, playwright')
    expect(prompt).toContain('- Checks after the merge: `pnpm check` passed on `doc-factory`')
    expect(prompt).toContain('Other tasks of this document (A1, A3) update it too, one at a time')
    expect(prompt).toContain('3. Edit only the section(s) of task A2.')
    expect(prompt).toContain('into `/Users/me/docs/checkout-redesign.assets/A2/` (create it)')
    expect(prompt).toContain('Strike through titles and list items only')
  })

  it('mentions the fix attempts the checks took, and verification that was not asked for', () => {
    const prompt = buildDocumentUpdatePrompt(
      documentUpdate({ fixAttempts: 2, verification: [], verifyCommand: 'pnpm test' })
    )
    expect(prompt).toContain(
      '- Checks after the merge: `pnpm test` passed on `doc-factory` after 2 fix attempts in the integration worktree'
    )
    expect(prompt).toContain('- Verification asked for: none (say what you did check, if anything)')
    expect(buildDocumentUpdatePrompt(documentUpdate({ verifyCommand: null }))).not.toContain(
      'Checks after the merge'
    )
  })

  it.each(['markdown', 'html', 'text'] as const)(
    'gives the %s paragraph for a %s file',
    (format) => {
      const prompt = buildDocumentUpdatePrompt(documentUpdate({ format }))
      expect(prompt).toContain(`6. ${DOCUMENT_UPDATE_FORMAT_PARAGRAPHS[format]}`)
      for (const other of ['markdown', 'html', 'text'] as const) {
        if (other !== format) expect(prompt).not.toContain(DOCUMENT_UPDATE_FORMAT_PARAGRAPHS[other])
      }
    }
  )

  it("keeps the file's encoding, and leaves the git checkout it sits in alone", () => {
    const prompt = buildDocumentUpdatePrompt(
      documentUpdate({ encoding: 'windows-1252', insideRepo: true })
    )
    expect(prompt).toContain("Keep the file's encoding (`windows-1252`) and its line endings.")
    expect(prompt).toContain('(it sits inside a git checkout, whose git state stays as it is)')
    expect(buildDocumentUpdatePrompt(documentUpdate())).not.toContain('sits inside a git checkout')
  })

  it('adds the merged-as-is caveat only when the verdict was not done', () => {
    expect(buildDocumentUpdatePrompt(documentUpdate())).not.toContain('Caveat')
    const prompt = buildDocumentUpdatePrompt(
      documentUpdate({
        verdict: {
          status: 'partial',
          reason: 'The e2e test is still failing.',
          summary: 'Mostly done.',
          migrations: ['drizzle/0042_cart.sql'],
          manualSteps: ['Set CHECKOUT_V2=1']
        }
      })
    )
    expect(prompt).toContain(
      '- Caveat: it was merged although your last message read as not done: The e2e test is still failing. Mark the task ⚠️ PARTIAL unless that was resolved'
    )
    expect(prompt).toContain('- Migrations: drizzle/0042_cart.sql')
    expect(prompt).toContain('- Manual steps: Set CHECKOUT_V2=1')
  })

  it('says an already implemented task had nothing to merge', () => {
    const prompt = buildDocumentUpdatePrompt(
      documentUpdate({ alreadyImplemented: true, mergeSha: null, verifyCommand: null })
    )
    expect(prompt.split('\n', 1)[0]).toBe(
      'Your task A2 ("Checkout redesign") is closed without a merge: your branch had nothing new to merge: the task was already implemented on `doc-factory`. One last step: record in the document this run was made from what was done, how it was verified, and what is left.'
    )
    expect(prompt).toContain(
      '   - Merged: nothing new, the task was already implemented on `doc-factory`'
    )
    expect(prompt).toContain('Your branch stays as it is')
    expect(prompt).not.toContain('is merged into')
  })

  it("lists each member repository's merge on a connection run", () => {
    const prompt = buildDocumentUpdatePrompt(
      documentUpdate({
        mergeSha: null,
        memberMerges: [
          { symlinkName: 'web', mergeSha: 'aaa111' },
          { symlinkName: 'api', mergeSha: null }
        ]
      })
    )
    expect(prompt).toContain(
      'is merged into `doc-factory` (`web/` at `aaa111`, `api/` (nothing new)).'
    )
    expect(prompt).toContain(
      '   - Merged: `tedooo/a2-checkout-redesign` into `doc-factory`: `web/` at `aaa111`, `api/` (nothing new)'
    )
  })

  it('ends with the DOCUMENT footer, not the status footer', () => {
    const prompt = buildDocumentUpdatePrompt(documentUpdate())
    expect(prompt.endsWith(`\n\n${DOCUMENT_UPDATE_FOOTER_BLOCK}`)).toBe(true)
    expect(prompt).not.toContain('STATUS: DONE')
    expect(DOCUMENT_UPDATE_FOOTER_BLOCK.split('\n').slice(2)).toEqual([
      'DOCUMENT: UPDATED | UNCHANGED | FAILED',
      'VERIFIED: one line — how the task was verified (methods and results), or "not verified"',
      'FOLLOW-UPS: none, or a semicolon-separated list',
      'NOTES: one sentence on what you changed in the document, or why you could not'
    ])
  })

  it('differs between interactive and unattended runs only in the asking line', () => {
    const asking = buildDocumentUpdatePrompt(documentUpdate()).split('\n')
    const unattended = buildDocumentUpdatePrompt(documentUpdate({ interactive: false })).split('\n')
    expect(asking).toHaveLength(unattended.length)
    const differing = asking
      .map((line, index) => [line, unattended[index]])
      .filter(([a, b]) => a !== b)
    expect(differing).toEqual([
      [
        'If you need an answer from me, ask through your question tool rather than in the text of your message.',
        'Do not ask me anything - I am not next to the computer to answer. If something is unclear, make the edit you would recommend and say so in NOTES.'
      ]
    ])
  })
})

describe('document update follow-ups', () => {
  it('nudges about an unchanged document, and about a copy edited in the worktree', () => {
    const clean = buildDocumentUpdateNudgePrompt('/docs/a.md', false)
    expect(clean).toContain(
      'The document at `/docs/a.md` is unchanged since I asked you to update it.'
    )
    expect(clean).not.toContain('you edited a copy in your worktree')
    // Whether or not the worktree is known to be dirty, a copy edited there is to be undone.
    expect(clean).toContain('If you changed a copy of it in your worktree instead, undo that change')
    const dirty = buildDocumentUpdateNudgePrompt('/docs/a.md', true)
    expect(dirty).toContain('you edited a copy in your worktree, not the document')
    for (const prompt of [clean, dirty]) {
      expect(prompt.endsWith(`\n\n${DOCUMENT_UPDATE_FOOTER_BLOCK}`)).toBe(true)
    }
    expect(buildDocumentUpdateNudgePrompt('/docs/a.md', false, false)).toContain(
      'Do not ask me anything'
    )
  })

  it('resumes the document edit, never the task', () => {
    for (const reason of ['api_error', 'interrupted'] as const) {
      const prompt = buildDocumentUpdateContinuePrompt(reason)
      expect(prompt).toContain('Continue updating the document where you left off')
      expect(prompt).toContain('Do not commit anything')
      expect(prompt).not.toContain('finish the task and commit')
      expect(prompt.endsWith(`\n\n${DOCUMENT_UPDATE_FOOTER_BLOCK}`)).toBe(true)
    }
    expect(buildDocumentUpdateContinuePrompt('api_error')).toMatch(
      /^Your last turn ended on an API error\./
    )
    expect(buildDocumentUpdateContinuePrompt('interrupted', false)).toContain(
      'Do not ask me anything'
    )
  })
})
