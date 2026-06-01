// test/custom-commands/validation.test.ts

import { describe, it, expect } from 'vitest'
import { validateCustomCommand } from '@/lib/custom-commands'

describe('validateCustomCommand', () => {
  it('should validate a valid command', () => {
    const validCommand = {
      id: 'cmd-123',
      name: 'Test Command',
      prompt: 'Do something with {{project.name}}'
    }

    const result = validateCustomCommand(validCommand)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('should reject invalid commands with appropriate error messages', () => {
    const testCases = [
      {
        command: null,
        expectedErrors: ['Command must be an object']
      },
      {
        command: { id: 123, name: 'Test', prompt: 'Test prompt' },
        expectedErrors: ['id must be a non-empty string']
      },
      {
        command: { id: 'cmd-1', name: '', prompt: 'Test prompt' },
        expectedErrors: ['name must be a non-empty string']
      },
      {
        command: { id: 'cmd-1', name: '   ', prompt: 'Test prompt' },
        expectedErrors: ['name must be a non-empty string']
      },
      {
        command: { id: 'cmd-1', name: 'Test', prompt: '' },
        expectedErrors: ['prompt must be a non-empty string']
      },
      {
        command: { id: 'cmd-1', name: 'Test', prompt: '   ' },
        expectedErrors: ['prompt must be a non-empty string']
      },
      {
        command: { name: 'Test', prompt: 'Test prompt' },
        expectedErrors: ['id must be a non-empty string']
      },
      {
        command: { id: 'cmd-1', prompt: 'Test prompt' },
        expectedErrors: ['name must be a non-empty string']
      },
      {
        command: { id: 'cmd-1', name: 'Test' },
        expectedErrors: ['prompt must be a non-empty string']
      }
    ]

    testCases.forEach(({ command, expectedErrors }) => {
      const result = validateCustomCommand(command)
      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expectedErrors)
    })
  })

  it('should accept any string as id (not just UUID format)', () => {
    const commands = [
      { id: 'simple-id', name: 'Test', prompt: 'Test prompt' },
      { id: '123', name: 'Test', prompt: 'Test prompt' },
      { id: 'any-string-works', name: 'Test', prompt: 'Test prompt' }
    ]

    commands.forEach(command => {
      const result = validateCustomCommand(command)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })
})
