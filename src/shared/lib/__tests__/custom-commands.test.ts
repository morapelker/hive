import { describe, expect, it } from 'vitest'

import type { CustomProjectCommand } from '../custom-commands'
import { CUSTOM_COMMAND_EXAMPLES, lintPromptBraces, mergeCustomCommands } from '../custom-commands'

const command = (id: string, name: string, prompt = `prompt ${id}`): CustomProjectCommand => ({
  id,
  name,
  prompt
})

describe('mergeCustomCommands', () => {
  it('returns global commands when project commands are empty', () => {
    const global = [command('global-1', 'Review'), command('global-2', 'Test')]

    expect(mergeCustomCommands(global, [])).toEqual(global)
  })

  it('returns project commands when global commands are empty', () => {
    const project = [command('project-1', 'Ship'), command('project-2', 'Audit')]

    expect(mergeCustomCommands([], project)).toEqual(project)
  })

  it('lets project commands override global commands with the same normalized name', () => {
    const global = [command('global-1', 'Review', 'global prompt'), command('global-2', 'Test')]
    const project = [command('project-1', 'Review', 'project prompt')]

    expect(mergeCustomCommands(global, project)).toEqual([
      command('project-1', 'Review', 'project prompt'),
      command('global-2', 'Test')
    ])
  })

  it('matches names case-insensitively and trims whitespace', () => {
    const global = [command('global-1', '  Review  ', 'global prompt')]
    const project = [command('project-1', 'review', 'project prompt')]

    expect(mergeCustomCommands(global, project)).toEqual([
      command('project-1', 'review', 'project prompt')
    ])
  })
})

describe('lintPromptBraces', () => {
  it('returns no findings for balanced placeholders', () => {
    expect(lintPromptBraces('Run {{project.name}} in {{project.path}}')).toEqual([])
  })

  it('detects an unclosed opening token', () => {
    expect(lintPromptBraces('Run {{project.name')).toEqual([
      { from: 4, to: 6, message: 'Unclosed {{ placeholder' }
    ])
  })

  it('detects a closing token without a preceding opening token', () => {
    expect(lintPromptBraces('Run project.name}}')).toEqual([
      { from: 16, to: 18, message: 'Unexpected }} without matching {{' }
    ])
  })

  it('detects nested opening tokens as leaving the outer token unclosed', () => {
    expect(lintPromptBraces('{{project.{{name}}')).toEqual([
      { from: 0, to: 2, message: 'Unclosed {{ placeholder' }
    ])
  })

  it('allows empty placeholders because runtime leaves unknown tokens untouched', () => {
    expect(lintPromptBraces('{{}}')).toEqual([])
  })
})

describe('CUSTOM_COMMAND_EXAMPLES', () => {
  it('keeps the old template examples available as fillable presets', () => {
    expect(CUSTOM_COMMAND_EXAMPLES).toEqual([
      {
        name: 'Analyze Architecture',
        prompt:
          'Analyze the architecture of {{project.name}} ({{project.language}}). Provide insights on structure, patterns, and improvements.'
      },
      {
        name: 'Review Dependencies',
        prompt:
          'Review all dependencies in the {{project.language}} project at {{project.path}}. Check for outdated packages and security issues.'
      },
      {
        name: 'Generate Tests',
        prompt:
          'Generate comprehensive test coverage for {{project.name}}. Focus on {{project.description}}.'
      }
    ])
  })
})
