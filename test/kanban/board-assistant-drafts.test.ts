import { describe, expect, test } from 'vitest'
import { parseBoardAssistantDraftSet } from '../../src/renderer/src/lib/board-assistant-drafts'

describe('board assistant draft parsing', () => {
  test('parses dependency-aware draft proposals', () => {
    const parsed = parseBoardAssistantDraftSet(
      [
        '```board-ticket-drafts',
        JSON.stringify({
          drafts: [
            {
              draftKey: 'schema',
              title: 'Create schema',
              description: 'Add persistence',
              projectId: 'project-1',
              dependsOn: [],
              warnings: []
            },
            {
              draftKey: 'ui',
              title: 'Build UI',
              description: null,
              projectId: 'project-1',
              dependsOn: ['schema'],
              warnings: ['Depends on backend readiness']
            }
          ]
        }),
        '```'
      ].join('\n'),
      {
        fallbackProjectId: 'project-1',
        strictProjectId: 'project-1',
        requireExplicitDraftKeys: true
      }
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.dependencyCount).toBe(1)
    expect(parsed!.hasValidationErrors).toBe(false)
    expect(parsed!.drafts[1].dependsOn).toEqual(['schema'])
  })

  test('flags invalid references and cycles', () => {
    const parsed = parseBoardAssistantDraftSet(
      [
        '```board-ticket-drafts',
        JSON.stringify({
          drafts: [
            {
              draftKey: 'a',
              title: 'Draft A',
              projectId: 'project-1',
              dependsOn: ['b']
            },
            {
              draftKey: 'b',
              title: 'Draft B',
              projectId: 'project-1',
              dependsOn: ['a', 'missing']
            }
          ]
        }),
        '```'
      ].join('\n'),
      {
        fallbackProjectId: 'project-1',
        strictProjectId: 'project-1',
        requireExplicitDraftKeys: true
      }
    )

    expect(parsed).not.toBeNull()
    expect(parsed!.hasValidationErrors).toBe(true)
    expect(parsed!.drafts[0].validationIssues.join(' ')).toMatch(/cycle/i)
    expect(parsed!.drafts[1].validationIssues.join(' ')).toMatch(/unknown draftkey|cycle/i)
  })
})
