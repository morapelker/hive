import { describe, expect, it } from 'vitest'
import type { ProviderModels } from '@/lib/parseProviders'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import {
  dependencyReaches,
  dependencyState,
  describeLaunchConfig,
  launchConfigIssue,
  mergeLaunchConfigs,
  quickLaunchChoices,
  sameLaunchConfig,
  validateLaunch
} from './document-flow-launch'
import { makeItem } from './test-fixtures'

// Opus exposes xhigh (ultracode-eligible on the CLI); Sonnet stops at high.
const CLAUDE_CATALOG: ProviderModels[] = [
  {
    providerID: 'anthropic',
    providerName: 'Anthropic',
    models: [
      {
        id: 'opus',
        providerID: 'anthropic',
        variants: { low: {}, medium: {}, high: {}, xhigh: {} }
      },
      { id: 'sonnet', providerID: 'anthropic', variants: { low: {}, medium: {}, high: {} } }
    ]
  }
]

const launch = (
  sdk: DocumentRunLaunchConfig['sdk'],
  modelID: string,
  variant?: string
): DocumentRunLaunchConfig => ({
  sdk,
  model: { providerID: 'anthropic', modelID, variant },
  codexFastMode: false
})

describe('launchConfigIssue', () => {
  it('accepts no config, no model and no variant', () => {
    expect(launchConfigIssue(null, CLAUDE_CATALOG)).toBeNull()
    expect(
      launchConfigIssue({ sdk: 'codex', model: null, codexFastMode: false }, CLAUDE_CATALOG)
    ).toBeNull()
    expect(launchConfigIssue(launch('claude-code', 'opus'), CLAUDE_CATALOG)).toBeNull()
  })

  it('rejects ultracode on anything but the Claude CLI, catalog or not', () => {
    for (const sdk of ['claude-code', 'codex', 'codex-cli', 'opencode'] as const) {
      expect(launchConfigIssue(launch(sdk, 'opus', 'ultracode'), null), sdk).toMatch(
        /ultracode only works with the Claude CLI/
      )
    }
    expect(launchConfigIssue(launch('claude-code-cli', 'opus', 'ultracode'), null)).toBeNull()
  })

  it('checks the variant against what the SDK offers for that model', () => {
    expect(
      launchConfigIssue(launch('claude-code-cli', 'opus', 'ultracode'), CLAUDE_CATALOG)
    ).toBeNull()
    // Sonnet has no xhigh, so the CLI does not offer ultracode for it.
    expect(
      launchConfigIssue(launch('claude-code-cli', 'sonnet', 'ultracode'), CLAUDE_CATALOG)
    ).toMatch(/not available for sonnet/)
    expect(launchConfigIssue(launch('claude-code', 'sonnet', 'xhigh'), CLAUDE_CATALOG)).toMatch(
      /"xhigh" is not available/
    )
    expect(launchConfigIssue(launch('claude-code', 'sonnet', 'high'), CLAUDE_CATALOG)).toBeNull()
  })

  it('does not judge models the catalog does not list, nor custom providers', () => {
    expect(
      launchConfigIssue(launch('opencode', 'unknown-model', 'high'), CLAUDE_CATALOG)
    ).toBeNull()
    expect(
      launchConfigIssue(
        { ...launch('claude-code-cli', 'my-proxy-model', 'max'), customProviderId: 'custom-1' },
        CLAUDE_CATALOG
      )
    ).toBeNull()
    expect(
      launchConfigIssue(
        { ...launch('claude-code-cli', 'opus', 'ultracode'), customProviderId: 'custom-1' },
        CLAUDE_CATALOG
      )
    ).toMatch(/custom provider/)
  })
})

describe('describeLaunchConfig', () => {
  it('spells out SDK, model and effort', () => {
    expect(describeLaunchConfig(null)).toBe('App default')
    expect(describeLaunchConfig(launch('claude-code-cli', 'opus', 'ultracode'))).toBe(
      'Claude CLI · opus · ultracode'
    )
    expect(describeLaunchConfig({ sdk: 'codex', model: null, codexFastMode: false })).toBe(
      'Codex · default model'
    )
  })

  it('names a custom provider when it is told the name', () => {
    const custom = { ...launch('claude-code-cli', 'glm-4.6'), customProviderId: 'provider-1' }
    expect(describeLaunchConfig(custom)).toBe('Claude CLI (custom provider) · glm-4.6')
    expect(describeLaunchConfig(custom, 'Z.ai')).toBe('Claude CLI (Z.ai) · glm-4.6')
    // The name of a provider only matters for a config that uses one.
    expect(describeLaunchConfig(launch('claude-code-cli', 'opus'), 'Z.ai')).toBe(
      'Claude CLI · opus'
    )
  })
})

describe('dependencies', () => {
  const items = [
    makeItem({ key: 'A1' }),
    makeItem({ key: 'A2', depends_on: ['A1'] }),
    makeItem({ key: 'A3', depends_on: ['A2'], selected: false })
  ]

  it('classifies a dependency as fine, excluded or unknown', () => {
    expect(dependencyState('A1', items)).toBe('ok')
    expect(dependencyState('A3', items)).toBe('excluded')
    expect(dependencyState('Z9', items)).toBe('unknown')
  })

  it('follows dependencies transitively', () => {
    expect(dependencyReaches('A3', 'A1', items)).toBe(true)
    expect(dependencyReaches('A1', 'A3', items)).toBe(false)
    expect(dependencyReaches('A1', 'A1', items)).toBe(false)
  })
})

describe('validateLaunch', () => {
  const noCatalog = (): null => null

  it('blocks a launch with no ticket selected', () => {
    const items = [makeItem({ key: 'A1', selected: false })]
    expect(validateLaunch(items, null, noCatalog)).toEqual({
      selectedCount: 0,
      blockers: ['Select at least one ticket.'],
      notes: []
    })
  })

  it('notes, without blocking, a dependency on a ticket that is left out', () => {
    const items = [
      makeItem({ key: 'A2', depends_on: ['A3', 'Z9'] }),
      makeItem({ key: 'A3', selected: false })
    ]
    const result = validateLaunch(items, null, noCatalog)
    expect(result.blockers).toEqual([])
    expect(result.notes).toEqual([
      'A2 will not wait for A3 (not included)',
      'A2 will not wait for Z9 (no such ticket)'
    ])
  })

  it('blocks an invalid ultracode combination on a ticket', () => {
    const items = [
      makeItem({ key: 'A1' }),
      makeItem({ key: 'A2', launch_config: launch('claude-code', 'opus', 'ultracode') })
    ]
    const result = validateLaunch(items, null, noCatalog)
    expect(result.blockers).toEqual([
      'A2: ultracode only works with the Claude CLI, not Claude Code.'
    ])
  })

  it('reports an invalid run default once, however many tickets inherit it', () => {
    const items = [makeItem({ key: 'A1' }), makeItem({ key: 'A2' })]
    const result = validateLaunch(items, launch('codex', 'gpt', 'ultracode'), noCatalog)
    expect(result.blockers).toEqual([
      'Default model: ultracode only works with the Claude CLI, not Codex.'
    ])
  })

  it('ignores the configuration of tickets that are not selected', () => {
    const items = [
      makeItem({ key: 'A1' }),
      makeItem({
        key: 'A2',
        selected: false,
        launch_config: launch('claude-code', 'opus', 'ultracode')
      })
    ]
    expect(validateLaunch(items, null, noCatalog).blockers).toEqual([])
  })

  it('uses the model catalog when it is loaded', () => {
    const items = [
      makeItem({ key: 'A1', launch_config: launch('claude-code-cli', 'sonnet', 'ultracode') })
    ]
    expect(validateLaunch(items, null, noCatalog).blockers).toEqual([])
    expect(validateLaunch(items, null, () => CLAUDE_CATALOG).blockers).toHaveLength(1)
  })

  it('blocks a ticket that depends on itself', () => {
    const items = [makeItem({ key: 'A1', depends_on: ['A1'] })]
    expect(validateLaunch(items, null, noCatalog).blockers).toEqual([
      'A1 depends on itself; remove the dependency.'
    ])
  })

  it('does not call it a cycle when the chain runs through a ticket that is left out', () => {
    const items = [
      makeItem({ key: 'A1', depends_on: ['A2'] }),
      makeItem({ key: 'A2', depends_on: ['A1'], selected: false })
    ]
    expect(validateLaunch(items, null, noCatalog).blockers).toEqual([])
  })

  it('blocks tickets that would wait for each other and tickets without a title', () => {
    const items = [
      makeItem({ key: 'A1', depends_on: ['A2'] }),
      makeItem({ key: 'A2', depends_on: ['A1'], title: '  ' })
    ]
    expect(validateLaunch(items, null, noCatalog).blockers).toEqual([
      'A1 and A2 depend on each other; remove one of the dependencies.',
      'A2 needs a title.'
    ])
  })
})

describe('sameLaunchConfig', () => {
  it('compares against "no config"', () => {
    expect(sameLaunchConfig(null, null)).toBe(true)
    expect(sameLaunchConfig(null, launch('claude-code', 'opus'))).toBe(false)
    expect(sameLaunchConfig(launch('claude-code', 'opus'), null)).toBe(false)
  })

  it('treats a missing variant or custom provider like an empty one', () => {
    // The picker writes `variant: undefined` and `customProviderId: null`; stored rows omit both.
    expect(
      sameLaunchConfig(
        {
          sdk: 'codex',
          model: { providerID: 'codex', modelID: 'gpt-5.5', variant: undefined },
          codexFastMode: false,
          customProviderId: null
        },
        { sdk: 'codex', model: { providerID: 'codex', modelID: 'gpt-5.5' }, codexFastMode: false }
      )
    ).toBe(true)
  })

  it('tells apart everything a ticket launches with', () => {
    const base = launch('claude-code-cli', 'opus', 'high')
    expect(sameLaunchConfig(base, launch('claude-code-cli', 'opus', 'high'))).toBe(true)
    expect(sameLaunchConfig(base, launch('claude-code', 'opus', 'high'))).toBe(false)
    expect(sameLaunchConfig(base, launch('claude-code-cli', 'sonnet', 'high'))).toBe(false)
    expect(sameLaunchConfig(base, launch('claude-code-cli', 'opus', 'xhigh'))).toBe(false)
    expect(sameLaunchConfig(base, launch('claude-code-cli', 'opus'))).toBe(false)
    expect(sameLaunchConfig(base, { ...base, customProviderId: 'provider-1' })).toBe(false)
    expect(
      sameLaunchConfig(base, { ...base, model: { ...base.model!, providerID: 'bedrock' } })
    ).toBe(false)
    expect(sameLaunchConfig(base, { ...base, model: null })).toBe(false)
  })

  it('counts fast mode only where it exists, on Codex', () => {
    const codex = launch('codex', 'gpt-5.5')
    expect(sameLaunchConfig(codex, { ...codex, codexFastMode: true })).toBe(false)
    const cli = launch('claude-code-cli', 'opus')
    expect(sameLaunchConfig(cli, { ...cli, codexFastMode: true })).toBe(true)
  })
})

describe('mergeLaunchConfigs', () => {
  const sonnet = launch('claude-code-cli', 'sonnet', 'high')
  const opus = launch('claude-code-cli', 'opus', 'xhigh')

  it('appends the configs it has not seen yet, in the order they come', () => {
    expect(mergeLaunchConfigs([], [null, sonnet, null, opus])).toEqual([sonnet, opus])
    expect(mergeLaunchConfigs([opus], [sonnet, opus])).toEqual([opus, sonnet])
  })

  it('skips duplicates, also within what it is given', () => {
    expect(
      mergeLaunchConfigs([], [sonnet, launch('claude-code-cli', 'sonnet', 'high'), sonnet])
    ).toEqual([sonnet])
  })

  it('returns the known list itself when nothing is new', () => {
    const known = [sonnet, opus]
    expect(mergeLaunchConfigs(known, [])).toBe(known)
    expect(mergeLaunchConfigs(known, [null, launch('claude-code-cli', 'opus', 'xhigh')])).toBe(
      known
    )
  })
})

describe('quickLaunchChoices', () => {
  const sonnet = launch('claude-code-cli', 'sonnet', 'high')
  const opus = launch('claude-code-cli', 'opus', 'xhigh')
  const codex = launch('codex', 'gpt-5.5')

  it('offers nothing until a ticket has a model of its own', () => {
    expect(quickLaunchChoices([], null)).toEqual([])
    expect(quickLaunchChoices([], sonnet)).toEqual([])
  })

  it('offers the known configs, oldest first', () => {
    const choices = quickLaunchChoices([sonnet, opus], null)
    expect(choices.map((choice) => choice.config)).toEqual([sonnet, opus])
    expect(choices.map((choice) => choice.sdkLabel)).toEqual([null, null])
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(2)
  })

  it('keeps the latest two', () => {
    expect(quickLaunchChoices([sonnet, opus, codex], null).map((choice) => choice.config)).toEqual([
      opus,
      codex
    ])
    expect(
      quickLaunchChoices([sonnet, opus, codex], null, 1).map((choice) => choice.config)
    ).toEqual([codex])
  })

  it('leaves out the run default, which "default" already stands for', () => {
    expect(
      quickLaunchChoices([sonnet, opus, codex], launch('codex', 'gpt-5.5')).map(
        (choice) => choice.config
      )
    ).toEqual([sonnet, opus])
  })

  it('names the SDK only for choices that would read the same without it', () => {
    const onSdk = launch('claude-code', 'sonnet', 'high')
    expect(quickLaunchChoices([sonnet, onSdk], null).map((choice) => choice.sdkLabel)).toEqual([
      'Claude CLI',
      'Claude Code'
    ])
    // The same model reads the same whichever provider id the SDK files it under.
    expect(
      quickLaunchChoices(
        [codex, { ...codex, sdk: 'opencode', model: { providerID: 'openai', modelID: 'gpt-5.5' } }],
        null
      ).map((choice) => choice.sdkLabel)
    ).toEqual(['Codex', 'OpenCode'])
    // A custom provider goes by its own name instead, also next to another one.
    expect(
      quickLaunchChoices([sonnet, { ...sonnet, customProviderId: 'provider-1' }], null).map(
        (choice) => choice.sdkLabel
      )
    ).toEqual(['Claude CLI', null])
    const custom = quickLaunchChoices(
      [
        { ...sonnet, customProviderId: 'provider-1' },
        { ...sonnet, customProviderId: 'provider-2' }
      ],
      null
    )
    expect(custom.map((choice) => choice.sdkLabel)).toEqual([null, null])
    expect(custom[0].key).not.toBe(custom[1].key)
    // Fast mode is part of the label already.
    expect(
      quickLaunchChoices([codex, { ...codex, codexFastMode: true }], null).map(
        (choice) => choice.sdkLabel
      )
    ).toEqual([null, null])
  })
})
