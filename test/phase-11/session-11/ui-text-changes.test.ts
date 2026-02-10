import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const sessionsDir = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions'
)

function readFile(fileName: string): string {
  return fs.readFileSync(path.join(sessionsDir, fileName), 'utf-8')
}

describe('Session 11: UI Text Changes', () => {
  describe('AssistantCanvas streaming text removal', () => {
    test('does not contain "Streaming..." text', () => {
      const content = readFile('AssistantCanvas.tsx')
      expect(content).not.toContain('Streaming...')
    })

    test('does not contain animate-pulse blue streaming indicator', () => {
      const content = readFile('AssistantCanvas.tsx')
      expect(content).not.toContain('text-blue-500 animate-pulse')
    })

    test('still renders StreamingCursor component', () => {
      const content = readFile('AssistantCanvas.tsx')
      expect(content).toContain('<StreamingCursor')
      expect(content).toContain("import { StreamingCursor } from './StreamingCursor'")
    })

    test('still accepts isStreaming prop', () => {
      const content = readFile('AssistantCanvas.tsx')
      expect(content).toContain('isStreaming')
    })
  })

  describe('ToolCard "Task" → "Agent" rename', () => {
    test('collapsed header shows "Agent" for task tool', () => {
      const content = readFile('ToolCard.tsx')
      // Find the Task section in CollapsedContent
      const taskSection = content.slice(content.indexOf('// Task'))
      expect(taskSection).toContain('>Agent<')
    })

    test('does not show "Task" as the label in the task tool collapsed header', () => {
      const content = readFile('ToolCard.tsx')
      // The Task section in CollapsedContent should not have ">Task<" as the label
      const taskSectionStart = content.indexOf('// Task')
      const taskSectionEnd = content.indexOf('// Default fallback')
      const taskSection = content.slice(taskSectionStart, taskSectionEnd)
      expect(taskSection).not.toContain('>Task<')
    })

    test('still maps task tool to Bot icon', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain("if (lowerName === 'task')")
      expect(content).toContain('<Bot className')
    })
  })

  describe('TaskToolView fallback text update', () => {
    test('fallback text is "Sub-agent" instead of "Agent Task"', () => {
      const content = readFile('tools/TaskToolView.tsx')
      expect(content).toContain("'Sub-agent'")
      expect(content).not.toContain("'Agent Task'")
    })

    test('still uses description when available', () => {
      const content = readFile('tools/TaskToolView.tsx')
      expect(content).toContain('description ||')
    })

    test('still renders Bot icon in header', () => {
      const content = readFile('tools/TaskToolView.tsx')
      expect(content).toContain('<Bot')
    })
  })
})
