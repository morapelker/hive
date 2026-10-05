import { describe, expect, it } from 'vitest'

import {
  STATUS_FOOTER_INSTRUCTIONS,
  buildConflictPrompt,
  buildContinuePrompt,
  buildFixTicket,
  buildLaunchFooter,
  buildNudgePrompt,
  type ConflictPromptInput,
  type FixTicketInput,
  type LaunchFooterInput
} from './prompts'

const launch = (overrides: Partial<LaunchFooterInput> = {}): LaunchFooterInput => ({
  key: 'A2',
  title: 'Counters',
  documentTitle: 'Factory area · Changes round 2',
  integrationBranch: 'doc-factory-area-changes-round-2',
  baseBranch: 'main',
  siblings: [
    { key: 'A1', title: 'Chinese translation' },
    { key: 'B1', title: 'Tabs' }
  ],
  mergedDependencies: [{ key: 'A3', title: 'Ramp-up rule' }],
  interactive: true,
  hasMigration: false,
  ...overrides
})

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
    expect(lines).toContain('STATUS: DONE | NEEDS_INPUT | BLOCKED')
    for (const label of ['SUMMARY', 'MIGRATIONS', 'MANUAL STEPS', 'ASSUMPTIONS', 'QUESTIONS']) {
      expect(lines.some((line) => line.startsWith(`${label}: `))).toBe(true)
    }
    expect(STATUS_FOOTER_INSTRUCTIONS).toContain('Use DONE only when')
  })
})

describe('buildLaunchFooter', () => {
  it('is appended after the ticket text behind a rule', () => {
    const footer = buildLaunchFooter(launch())
    expect(footer.startsWith('\n\n---\n')).toBe(true)
    expect(footer).toContain(
      'You are implementing task A2 of the document "Factory area · Changes round 2"'
    )
    expect(footer).toContain('Your branch was cut from `doc-factory-area-changes-round-2`')
    expect(footer).toContain('- Implement only A2.')
  })

  it('lets an interactive run ask, and tells an unattended one to decide', () => {
    const interactive = buildLaunchFooter(launch({ interactive: true }))
    expect(interactive).toContain('ask with the AskUserQuestion tool')
    expect(interactive).not.toContain('Nobody is watching this run')

    const unattended = buildLaunchFooter(launch({ interactive: false }))
    expect(unattended).toContain('Nobody is watching this run. Do not stop to ask questions')
    expect(unattended).not.toContain('AskUserQuestion')
    expect(unattended).toContain('record the decision under ASSUMPTIONS')
    expect(interactive).toContain('record the decision under ASSUMPTIONS')
  })

  it('lists siblings only when there are some', () => {
    const withSiblings = buildLaunchFooter(launch())
    expect(withSiblings).toContain(
      'merged with yours: A1 (Chinese translation), B1 (Tabs). Do not implement them.'
    )
    const alone = buildLaunchFooter(launch({ siblings: [] }))
    expect(alone).not.toContain('Other tasks of this document')
    expect(alone).not.toContain('Do not implement them')
  })

  it('lists merged dependencies only when there are some', () => {
    const withMerged = buildLaunchFooter(launch())
    expect(withMerged).toContain(
      '- Already on your branch (merged before you started): A3 (Ramp-up rule). Build on that work'
    )
    const none = buildLaunchFooter(launch({ mergedDependencies: [] }))
    expect(none).not.toContain('Already on your branch')
  })

  it('names the base branch in the line that forbids changing it', () => {
    const footer = buildLaunchFooter(launch({ baseBranch: 'release/2026-10' }))
    const line = footer.split('\n').find((candidate) => candidate.includes('Never commit to'))
    expect(line).toBe(
      '- Do not push. Do not switch branches. Never commit to, merge into, or otherwise change `release/2026-10`.'
    )
    expect(footer).not.toContain('`main`')
  })

  it('words the migration rule by whether the ticket is known to need one', () => {
    const known = buildLaunchFooter(launch({ hasMigration: true }))
    const unknown = buildLaunchFooter(launch({ hasMigration: false }))
    expect(known).toContain('- Schema or data changes: add a NEW migration')
    expect(known).toContain('Never edit an existing migration')
    expect(unknown).toContain('- If you find you need a schema or data change, add a NEW migration')
    for (const footer of [known, unknown]) {
      expect(footer).toContain('never run')
      expect(footer).toContain('under MIGRATIONS')
    }
  })

  it('asks for a commit and ends with the status footer', () => {
    const footer = buildLaunchFooter(launch())
    expect(footer).toContain('- Commit all of your work on this branch')
    expect(footer.endsWith(`\n\n${STATUS_FOOTER_INSTRUCTIONS}`)).toBe(true)
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
