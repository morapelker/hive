import { describe, expect, it } from 'vitest'
import type { ProviderModels } from '@/lib/parseProviders'
import type { DocumentRunLaunchConfig } from '@shared/types/document-flow'
import {
  dependencyReaches,
  dependencyState,
  describeLaunchConfig,
  launchConfigIssue,
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
