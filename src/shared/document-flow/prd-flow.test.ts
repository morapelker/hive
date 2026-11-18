import { describe, expect, it } from 'vitest'

import {
  PRD_FLOW_CLI_LEAD,
  PRD_FLOW_PREFIX_MAX_LENGTH,
  PRD_NO_IMPLEMENTATION_PARAGRAPH,
  PRD_RESEARCH_PARAGRAPH,
  buildPrdFlowRepromptPrompt,
  buildPrdPrompt,
  buildTasksPrompt,
  prdClarifyParagraph,
  prdCreateParagraph,
  prdFileName,
  prdFlowPrefix,
  tasksFileName,
  type PrdPromptInput
} from './prd-flow'

// What "New PRD → orchestrator ticket…" says to its session, word for word: the file-name
// prefix a ticket name gives, the first prompt for every combination of the form's two
// checkmarks, the tasks prompt in the person's own wording, and the prompts that ask again for
// a document the session did not write. The expected texts are written out here, not built
// from the module's own constants: a changed word must be changed in both places.

const RESEARCH_LINE =
  'use subagents to research on the requirements, security considerations, best practices and in general what we want to implement.'
const CLARIFY_LINE =
  'For any clarifications you might need - use the AskUserQuestion tool to ask me'
const NO_IMPLEMENTATION_LINE =
  'Do not implement anything yet - this session only produces the document.'
const CREATE_LINE =
  "Create CODE_MODE_PRD.html standalone, darkmode html file, containing everything discussed, research conclusions, and all decisions we've made"

const prd = (overrides: Partial<PrdPromptInput> = {}): PrdPromptInput => ({
  prompt: 'i want a code mode for the composer',
  prefix: 'CODE_MODE',
  research: true,
  clarify: true,
  sdk: 'claude-code-cli',
  ...overrides
})

describe('prdFlowPrefix', () => {
  it.each([
    ['code mode', 'CODE_MODE'],
    ['prd -> tasks -> orchestrator route', 'PRD_TASKS_ORCHESTRATOR_ROUTE'],
    ['Checkout', 'CHECKOUT'],
    ['already_SNAKE_case', 'ALREADY_SNAKE_CASE'],
    ['v2 api, 3rd pass', 'V2_API_3RD_PASS']
  ])('turns the name "%s" into %s', (name, prefix) => {
    expect(prdFlowPrefix(name)).toBe(prefix)
  })

  it.each([
    ['  code   mode  ', 'CODE_MODE'],
    ['code\tmode\nagain', 'CODE_MODE_AGAIN'],
    ['code -- mode', 'CODE_MODE'],
    ['code/mode\\v2', 'CODE_MODE_V2'],
    ['../../etc/passwd', 'ETC_PASSWD'],
    ['"quotes" & <tags> | pipes?', 'QUOTES_TAGS_PIPES'],
    ['file.name.html', 'FILE_NAME_HTML'],
    ['(code mode)', 'CODE_MODE'],
    ['__code__mode__', 'CODE_MODE'],
    ['rocket 🚀 launch', 'ROCKET_LAUNCH']
  ])('makes one underscore of every run of anything else, none at the ends: %j', (name, prefix) => {
    expect(prdFlowPrefix(name)).toBe(prefix)
  })

  it.each([
    ['מצב קוד', 'מצב_קוד'],
    ['代码 模式', '代码_模式'],
    ['режим кода', 'РЕЖИМ_КОДА'],
    ['über straße', 'ÜBER_STRASSE'],
    ['وضع الكود', 'وضع_الكود'],
    ['٣ مهام', '٣_مهام']
  ])('keeps the letters and digits of any script: %s', (name, prefix) => {
    expect(prdFlowPrefix(name)).toBe(prefix)
  })

  it('keeps an accent typed as a separate mark with its letter', () => {
    // "café" with the accent as U+0301 after a plain e, as some keyboards and pastes give it.
    expect(prdFlowPrefix('cafe\u0301 menu')).toBe('CAF\u00c9_MENU')
  })

  it.each([
    ['हिन्दी मोड', 'हिन्दी_मोड'],
    ['โหมด โค้ด', 'โหมด_โค้ด'],
    ['ที่ดิน ใหม่', 'ที่ดิน_ใหม่'],
    ['কোড মোড', 'কোড_মোড']
  ])('keeps the vowel signs and tone marks that are part of a written word: %s', (name, prefix) => {
    expect(prdFlowPrefix(name)).toBe(prefix)
  })

  it('drops a mark that has no letter before it', () => {
    expect(prdFlowPrefix('\u0301code \u0301\u0300mode')).toBe('CODE_MODE')
    expect(prdFlowPrefix('code -\u0301- mode')).toBe('CODE_MODE')
  })

  it.each([[''], ['   '], ['-> ... !?'], ['___'], ['🚀🚀'], ['\u0301\u0300']])(
    'is empty for a name with no letter or digit: %j',
    (name) => {
      expect(prdFlowPrefix(name)).toBe('')
    }
  )

  // Written as escapes throughout: these characters draw nothing, in an editor either.
  it.each([
    ['HANGUL FILLER', '\u3164'],
    ['HANGUL CHOSEONG FILLER', '\u115F'],
    ['HANGUL JUNGSEONG FILLER', '\u1160'],
    ['HALFWIDTH HANGUL FILLER', '\uFFA0'],
    ['several fillers and spaces', ' \u3164\u3164 \uFFA0 '],
    ['a zero width joiner and a variation selector', '\u200D\uFE0F']
  ])(
    'is empty for a name of invisible characters alone, though some count as letters: %s',
    (_label, name) => {
      expect(prdFlowPrefix(name)).toBe('')
    }
  )

  it('makes a separator of the keycap around an emoji digit, and keeps the digit', () => {
    // "Phase 1" with the digit as the keycap emoji: 1, a variation selector, the enclosing keycap.
    expect(prdFlowPrefix('Phase 1\uFE0F\u20E3')).toBe('PHASE_1')
    expect(prdFlowPrefix('Phase 1\uFE0F\u20E3 plan')).toBe('PHASE_1_PLAN')
    // Any other enclosing mark separates in the same way.
    expect(prdFlowPrefix('a\u20DDb')).toBe('A_B')
  })

  it.each([
    ['a variation selector', 'a\uFE0Fb'],
    ['a combining grapheme joiner', 'a\u034Fb'],
    ['a zero width joiner', 'a\u200Db'],
    ['a zero width non-joiner', 'a\u200Cb'],
    ['a zero width space', 'a\u200Bb'],
    ['a filler that counts as a letter', 'a\u3164b']
  ])('gives a name with %s inside it the prefix of the name it looks like', (_label, name) => {
    expect(prdFlowPrefix(name)).toBe('AB')
    expect(prdFlowPrefix(name)).toBe(prdFlowPrefix('ab'))
  })

  it('leaves nothing invisible in a prefix, whatever the name was made of', () => {
    const prefix = prdFlowPrefix('co\u200Dde\uFE0F \u3164mo\u034Fde\u20E3\u2060')

    expect(prefix).toBe('CODE_MODE')
    expect(prefix).toMatch(/^[A-Z_]+$/)
  })

  it('cuts a long name at 60 characters', () => {
    expect(PRD_FLOW_PREFIX_MAX_LENGTH).toBe(60)
    expect(prdFlowPrefix('a'.repeat(61))).toBe('A'.repeat(60))
    expect(prdFlowPrefix('a'.repeat(60))).toBe('A'.repeat(60))
    expect(prdFlowPrefix('word '.repeat(40))).toBe(`${'WORD_'.repeat(11)}WORD`)
  })

  it('leaves no underscore where a long name was cut', () => {
    // The 60th character is the separator between the two words.
    expect(prdFlowPrefix(`${'a'.repeat(59)} tail`)).toBe('A'.repeat(59))
    expect(prdFlowPrefix(`${'a'.repeat(59)} -> tail`)).toBe('A'.repeat(59))
  })

  it('never cuts a character in half', () => {
    // Letters outside the basic plane take two UTF-16 units each: a cut between the two would
    // leave a file name no file system can hold.
    const prefix = prdFlowPrefix(`a${'𠮷'.repeat(70)}`)

    expect(prefix).toBe(`A${'𠮷'.repeat(59)}`)
    expect(Array.from(prefix)).toHaveLength(PRD_FLOW_PREFIX_MAX_LENGTH)
  })

  it('gives the same prefix for the prefix itself', () => {
    for (const name of ['code mode', 'prd -> tasks -> orchestrator route', 'über straße']) {
      const prefix = prdFlowPrefix(name)
      expect(prdFlowPrefix(prefix)).toBe(prefix)
    }
  })
})

describe('the file names', () => {
  it('are the prefix with _PRD.html and _TASKS.html', () => {
    expect(prdFileName('CODE_MODE')).toBe('CODE_MODE_PRD.html')
    expect(tasksFileName('CODE_MODE')).toBe('CODE_MODE_TASKS.html')
  })
})

describe('the paragraphs of the form', () => {
  it('are the texts the person asked for', () => {
    expect(PRD_RESEARCH_PARAGRAPH).toBe(RESEARCH_LINE)
    expect(prdClarifyParagraph('claude-code-cli')).toBe(CLARIFY_LINE)
    expect(PRD_NO_IMPLEMENTATION_PARAGRAPH).toBe(NO_IMPLEMENTATION_LINE)
    expect(prdCreateParagraph('CODE_MODE')).toBe(CREATE_LINE)
  })

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['claude-code-cli', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['codex-cli', 'request_user_input'],
    ['opencode', 'question']
  ])('names the question tool of %s as %s', (sdk, tool) => {
    expect(prdClarifyParagraph(sdk)).toBe(
      `For any clarifications you might need - use the ${tool} tool to ask me`
    )
  })
})

describe('buildPrdPrompt', () => {
  it('adds both paragraphs when both checkmarks are ticked, research first', () => {
    expect(buildPrdPrompt(prd())).toBe(
      [
        'i want a code mode for the composer',
        RESEARCH_LINE,
        CLARIFY_LINE,
        NO_IMPLEMENTATION_LINE,
        CREATE_LINE
      ].join('\n\n')
    )
  })

  it('adds only the research paragraph with "Ask me for clarifications" unticked', () => {
    expect(buildPrdPrompt(prd({ clarify: false }))).toBe(
      [
        'i want a code mode for the composer',
        RESEARCH_LINE,
        NO_IMPLEMENTATION_LINE,
        CREATE_LINE
      ].join('\n\n')
    )
  })

  it('adds only the asking paragraph with "Research with subagents first" unticked', () => {
    expect(buildPrdPrompt(prd({ research: false }))).toBe(
      [
        'i want a code mode for the composer',
        CLARIFY_LINE,
        NO_IMPLEMENTATION_LINE,
        CREATE_LINE
      ].join('\n\n')
    )
  })

  it('adds neither with both unticked: the prompt, no implementation, and the file', () => {
    expect(buildPrdPrompt(prd({ research: false, clarify: false }))).toBe(
      ['i want a code mode for the composer', NO_IMPLEMENTATION_LINE, CREATE_LINE].join('\n\n')
    )
  })

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false]
  ])(
    'always ends on the request for the PRD file (research %s, clarify %s)',
    (research, clarify) => {
      const prompt = buildPrdPrompt(
        prd({ research, clarify, prefix: 'PRD_TASKS_ORCHESTRATOR_ROUTE' })
      )

      expect(prompt.split('\n\n').at(-1)).toBe(
        "Create PRD_TASKS_ORCHESTRATOR_ROUTE_PRD.html standalone, darkmode html file, containing everything discussed, research conclusions, and all decisions we've made"
      )
      // And says, whatever is ticked, that this session builds nothing.
      expect(prompt.split('\n\n').at(-2)).toBe(NO_IMPLEMENTATION_LINE)
    }
  )

  it.each([
    ['claude-code', 'AskUserQuestion'],
    ['codex', 'request_user_input'],
    ['codex-cli', 'request_user_input'],
    ['opencode', 'question']
  ])('asks through the question tool of the provider the session runs on: %s', (sdk, tool) => {
    const paragraphs = buildPrdPrompt(prd({ sdk })).split('\n\n')

    expect(paragraphs[2]).toBe(
      `For any clarifications you might need - use the ${tool} tool to ask me`
    )
    // Unticked, no provider's tool is named at all.
    expect(buildPrdPrompt(prd({ sdk, clarify: false }))).not.toContain(tool)
  })

  it("sends the person's prompt as typed, paragraphs and all, without the space around it", () => {
    const typed = '\n  a code mode.\n\nit should have:\n- a toggle\n- a shortcut  \n\n'

    expect(buildPrdPrompt(prd({ prompt: typed, research: false, clarify: false }))).toBe(
      [
        'a code mode.\n\nit should have:\n- a toggle\n- a shortcut',
        NO_IMPLEMENTATION_LINE,
        CREATE_LINE
      ].join('\n\n')
    )
  })

  it('starts with no blank paragraph when the prompt is empty', () => {
    expect(buildPrdPrompt(prd({ prompt: '   ', research: false, clarify: false }))).toBe(
      [NO_IMPLEMENTATION_LINE, CREATE_LINE].join('\n\n')
    )
  })
})

describe('buildTasksPrompt', () => {
  const prompt = buildTasksPrompt({ prefix: 'CODE_MODE', prdPath: '/repo/app/CODE_MODE_PRD.html' })

  it("opens with the person's own wording, with the tasks file named", () => {
    const own = `Perfect. lets create CODE_MODE_TASKS.html now. this should be a standalone html file, based on everything we've discussed.

it should contain a list of tickets, each being a task we need to implement in the road to implementing this entire project.

each ticket should have:
- serial number
- short title
- projects it should most likely touch
- description of the ticket and what needs to be implemented
- dependencies it needs before beginning to implement (other ticket numbers that must be implemented before and that this relies on)
- verification steps to verify its completed and implemented properly
no implementation details should be there

the idea i have is that we run this task file, giving tickets to individual agents which would implement them in parallel, respecting the dependency list of the tickets so we implement them in the correct order with max concurrency available.

each ticket provided to an agent - should give the agent what it needs for it to implement the ticket and verify it.

by the time we're done with all tasks - this should be feature complete and verified`

    expect(prompt.startsWith(`${own}\n\n`)).toBe(true)
  })

  it('then asks for a document the extraction can read, and names the PRD by its absolute path', () => {
    expect(prompt.split('\n\n').slice(6)).toEqual([
      'write it as plain static html: the text of every ticket is in the markup itself, nothing is rendered by javascript and nothing is hidden or collapsed by default.',
      'give each ticket its own section that starts with a heading holding its serial number and its title as plain text (for example "T01 · Short title"), label its fields (Projects, Description, Dependencies, Verification), and write the dependencies as a comma-separated list of serial numbers, or "None".',
      'the agents work in fresh checkouts where CODE_MODE_PRD.html is not present: wherever a ticket needs the PRD, refer to it by its absolute path, /repo/app/CODE_MODE_PRD.html'
    ])
    expect(prompt.split('\n\n')).toHaveLength(9)
  })

  it('names the files of the prefix it is given, and the PRD where it was found', () => {
    const other = buildTasksPrompt({
      prefix: 'PRD_TASKS_ORCHESTRATOR_ROUTE',
      // An agent may write the PRD inside a member repository of a connection directory.
      prdPath: '/connections/shop/web/PRD_TASKS_ORCHESTRATOR_ROUTE_PRD.html'
    })

    expect(other.split('\n\n')[0]).toBe(
      "Perfect. lets create PRD_TASKS_ORCHESTRATOR_ROUTE_TASKS.html now. this should be a standalone html file, based on everything we've discussed."
    )
    expect(other.split('\n\n').at(-1)).toBe(
      'the agents work in fresh checkouts where PRD_TASKS_ORCHESTRATOR_ROUTE_PRD.html is not present: wherever a ticket needs the PRD, refer to it by its absolute path, /connections/shop/web/PRD_TASKS_ORCHESTRATOR_ROUTE_PRD.html'
    )
    expect(other).not.toContain('CODE_MODE')
  })
})

describe('buildPrdFlowRepromptPrompt', () => {
  const PRD_PATH = '/repo/app/CODE_MODE_PRD.html'
  const TASKS_PATH = '/repo/app/CODE_MODE_TASKS.html'
  const PRD_ASK =
    "a standalone, darkmode html file, containing everything discussed, research conclusions, and all decisions we've made. Do not implement anything."
  const TASKS_ASK =
    'the standalone html file with the list of tickets, exactly as I asked for it in my previous message.'

  it('asks for the PRD again when the turn ended without it', () => {
    expect(
      buildPrdFlowRepromptPrompt({
        document: 'prd',
        reason: 'missing',
        prefix: 'CODE_MODE',
        path: PRD_PATH
      })
    ).toBe(
      `Your turn ended, but CODE_MODE_PRD.html was not created. Create it now at \`${PRD_PATH}\`: ${PRD_ASK}`
    )
  })

  it('asks for the tasks document again when the turn ended without it', () => {
    expect(
      buildPrdFlowRepromptPrompt({
        document: 'tasks',
        reason: 'missing',
        prefix: 'CODE_MODE',
        path: TASKS_PATH
      })
    ).toBe(
      `Your turn ended, but CODE_MODE_TASKS.html was not created. Create it now at \`${TASKS_PATH}\`: ${TASKS_ASK}`
    )
  })

  it('asks a session whose turn ended on an API error to continue and finish with the file', () => {
    expect(
      buildPrdFlowRepromptPrompt({
        document: 'prd',
        reason: 'api_error',
        prefix: 'CODE_MODE',
        path: PRD_PATH
      })
    ).toBe(
      `Your last turn ended on an API error. Continue where you left off, and finish by creating CODE_MODE_PRD.html at \`${PRD_PATH}\`: ${PRD_ASK}`
    )
    expect(
      buildPrdFlowRepromptPrompt({
        document: 'tasks',
        reason: 'api_error',
        prefix: 'CODE_MODE',
        path: TASKS_PATH
      })
    ).toBe(
      `Your last turn ended on an API error. Continue where you left off, and finish by creating CODE_MODE_TASKS.html at \`${TASKS_PATH}\`: ${TASKS_ASK}`
    )
  })

  it('asks a session whose turn was cut off to continue and finish with the file', () => {
    expect(
      buildPrdFlowRepromptPrompt({
        document: 'prd',
        reason: 'interrupted',
        prefix: 'CODE_MODE',
        path: PRD_PATH
      })
    ).toBe(
      `Your last turn was interrupted before it finished. Continue where you left off, and finish by creating CODE_MODE_PRD.html at \`${PRD_PATH}\`: ${PRD_ASK}`
    )
    expect(
      buildPrdFlowRepromptPrompt({
        document: 'tasks',
        reason: 'interrupted',
        prefix: 'CODE_MODE',
        path: TASKS_PATH
      })
    ).toBe(
      `Your last turn was interrupted before it finished. Continue where you left off, and finish by creating CODE_MODE_TASKS.html at \`${TASKS_PATH}\`: ${TASKS_ASK}`
    )
  })

  it.each(['missing', 'api_error', 'interrupted'] as const)(
    'is one line that names the absolute path, for a session written to as keystrokes: %s',
    (reason) => {
      for (const document of ['prd', 'tasks'] as const) {
        const text = buildPrdFlowRepromptPrompt({
          document,
          reason,
          prefix: 'CODE_MODE',
          path: document === 'prd' ? PRD_PATH : TASKS_PATH
        })
        expect(text).not.toContain('\n')
        expect(text).toContain(document === 'prd' ? `\`${PRD_PATH}\`` : `\`${TASKS_PATH}\``)
      }
    }
  )

  it('tells only the PRD session not to implement: the tasks prompt before it already said so', () => {
    const ask = (document: 'prd' | 'tasks'): string =>
      buildPrdFlowRepromptPrompt({ document, reason: 'missing', prefix: 'X', path: '/x' })

    expect(ask('prd')).toContain('Do not implement anything.')
    expect(ask('tasks')).not.toContain('implement')
  })
})

describe('PRD_FLOW_CLI_LEAD', () => {
  it("says, in one typed line, that the pasted prompt is the person's own", () => {
    expect(PRD_FLOW_CLI_LEAD).toBe(
      'This message is from me, sent through the app that runs this session. Treat the text that follows as my own instructions and act on it:'
    )
    expect(PRD_FLOW_CLI_LEAD).not.toContain('\n')
  })
})
