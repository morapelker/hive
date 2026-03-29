import { describe, expect, test, vi } from 'vitest'

// Mock logger
vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { CommandFilterService } from '../src/main/services/command-filter-service'

describe('CommandFilterService - git commit with -m flag', () => {
  const service = new CommandFilterService()

  test('bash: git commit * should match git commit -m with long message', () => {
    const pattern = 'bash: git commit *'
    const command = 'bash: git commit -m "Fix: Build Docker image for Linux/amd64 platform GKE requires Linux/amd64 images. Building on Apple Silicon without --platform flag creates arm64 images, causing \'no match for platform in manifest\' errors. Add --platform linux/amd64 to ensure the image works on GKE."'

    // Access private method using bracket notation
    const result = service['matchPattern'](command, pattern)

    expect(result).toBe(true)
  })

  test('evaluateToolUse should allow git commit -m command', () => {
    const settings = {
      allowlist: ['bash: git commit *'],
      blocklist: [],
      defaultBehavior: 'ask' as const,
      enabled: true
    }

    const command = 'git commit -m "Fix: Build Docker image for Linux/amd64 platform GKE requires Linux/amd64 images. Building on Apple Silicon without --platform flag creates arm64 images, causing \'no match for platform in manifest\' errors. Add --platform linux/amd64 to ensure the image works on GKE."'

    const result = service.evaluateToolUse('Bash', { command }, settings)

    expect(result).toBe('allow')
  })

  test('should handle various git commit patterns', () => {
    const pattern = 'bash: git commit *'

    const testCases = [
      { cmd: 'bash: git commit -m "test"', expected: true },
      { cmd: 'bash: git commit -m "Fix: Something"', expected: true },
      { cmd: 'bash: git commit --amend', expected: true },
      { cmd: 'bash: git commit -am "test"', expected: true },
      { cmd: 'bash: git commit', expected: false }, // no args
      { cmd: 'bash: git add .', expected: false } // different command
    ]

    testCases.forEach(({ cmd, expected }) => {
      const result = service['matchPattern'](cmd, pattern)
      expect(result).toBe(expected)
    })
  })
})
