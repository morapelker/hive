// test/custom-commands/template-replacement.test.ts
import { describe, it, expect } from 'vitest'
import { replaceTemplateVariables } from '@/lib/custom-commands'

describe('replaceTemplateVariables', () => {
  const mockProject = {
    id: 'test-id-123',
    name: 'Test Project',
    path: '/Users/test/project',
    description: 'A test project',
    tags: 'typescript,react',
    language: 'TypeScript',
    custom_icon: null,
    detected_icon: null,
    setup_script: null,
    run_script: null,
    archive_script: null,
    custom_commands: null,
    auto_assign_port: false,
    sort_order: 0,
    created_at: '2024-01-01',
    last_accessed_at: '2024-01-02'
  }

  it('should replace all project template variables', () => {
    const template = 'Analyze {{project.name}} at {{project.path}} ({{project.language}})'
    const result = replaceTemplateVariables(template, mockProject)
    expect(result).toBe('Analyze Test Project at /Users/test/project (TypeScript)')
  })

  it('should replace project.id variable', () => {
    const template = 'ID is {{project.id}}'
    const result = replaceTemplateVariables(template, mockProject)
    expect(result).toBe('ID is test-id-123')
  })

  it('should replace project.description variable', () => {
    const template = 'Description: {{project.description}}'
    const result = replaceTemplateVariables(template, mockProject)
    expect(result).toBe('Description: A test project')
  })

  it('should replace project.tags variable', () => {
    const template = 'Tags: {{project.tags}}'
    const result = replaceTemplateVariables(template, mockProject)
    expect(result).toBe('Tags: typescript,react')
  })

  it('should use "unknown" fallback for null language', () => {
    const projectWithNullLanguage = { ...mockProject, language: null }
    const template = 'Language: {{project.language}}'
    const result = replaceTemplateVariables(template, projectWithNullLanguage)
    expect(result).toBe('Language: unknown')
  })

  it('should use empty string fallback for null description', () => {
    const projectWithNullDescription = { ...mockProject, description: null }
    const template = 'Description: {{project.description}}'
    const result = replaceTemplateVariables(template, projectWithNullDescription)
    expect(result).toBe('Description: ')
  })

  it('should use empty string fallback for null tags', () => {
    const projectWithNullTags = { ...mockProject, tags: null }
    const template = 'Tags: {{project.tags}}'
    const result = replaceTemplateVariables(template, projectWithNullTags)
    expect(result).toBe('Tags: ')
  })

  it('should leave unknown template variables unchanged', () => {
    const template = 'Unknown: {{project.invalidField}}'
    const result = replaceTemplateVariables(template, mockProject)
    expect(result).toBe('Unknown: {{project.invalidField}}')
  })

  it('should replace multiple occurrences of the same variable', () => {
    const template =
      '{{project.name}} is located at {{project.path}}. The name is {{project.name}}.'
    const result = replaceTemplateVariables(template, mockProject)
    expect(result).toBe('Test Project is located at /Users/test/project. The name is Test Project.')
  })
})
