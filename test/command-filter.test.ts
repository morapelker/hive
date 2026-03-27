import { describe, expect, test } from 'vitest'

// Mock logger
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
}

// Import and mock the logger before importing the service
import { vi } from 'vitest'
vi.mock('../src/main/services/logger', () => ({
  createLogger: () => mockLogger
}))

import { CommandFilterService } from '../src/main/services/command-filter-service'

describe('CommandFilterService', () => {
  const service = new CommandFilterService()

  describe('pattern matching', () => {
    test('bash: git commit * should match bash commands with git commit', () => {
      const pattern = 'bash: git commit *'

      expect(service['matchPattern']('bash: git commit -m "test"', pattern)).toBe(true)
      expect(service['matchPattern']('bash: git commit -m "Fix: Build Docker"', pattern)).toBe(true)
      expect(service['matchPattern']('bash: git commit --amend', pattern)).toBe(true)
      expect(service['matchPattern']('bash: git commit', pattern)).toBe(false) // no args
      expect(service['matchPattern']('bash: git add .', pattern)).toBe(false) // different command
    })

    test('bash: * should match any bash command', () => {
      const pattern = 'bash: *'

      expect(service['matchPattern']('bash: ls -la', pattern)).toBe(true)
      expect(service['matchPattern']('bash: git commit -m "test"', pattern)).toBe(true)
      expect(service['matchPattern']('bash: npm install', pattern)).toBe(true)
    })

    test('bash: git * should match any git command', () => {
      const pattern = 'bash: git *'

      expect(service['matchPattern']('bash: git add .', pattern)).toBe(true)
      expect(service['matchPattern']('bash: git commit -m "test"', pattern)).toBe(true)
      expect(service['matchPattern']('bash: git push', pattern)).toBe(true)
      expect(service['matchPattern']('bash: npm install', pattern)).toBe(false)
    })

    test('case insensitive matching', () => {
      const pattern = 'bash: git commit *'

      expect(service['matchPattern']('BASH: GIT COMMIT -m "test"', pattern)).toBe(true)
      expect(service['matchPattern']('Bash: Git Commit -m "test"', pattern)).toBe(true)
    })
  })

  describe('evaluateToolUse with bash chains', () => {
    test('all sub-commands must match allowlist', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Single command that matches
      const result1 = service.evaluateToolUse(
        'Bash',
        { command: 'git commit -m "test"' },
        settings
      )
      expect(result1).toBe('allow')

      // Single command that doesn't match
      const result2 = service.evaluateToolUse(
        'Bash',
        { command: 'git add .' },
        settings
      )
      expect(result2).toBe('ask')

      // Chain where only one matches (should ask)
      const result3 = service.evaluateToolUse(
        'Bash',
        { command: 'git add . && git commit -m "test"' },
        settings
      )
      expect(result3).toBe('ask')
    })

    test('chain with all commands allowed', () => {
      const settings = {
        allowlist: ['bash: git add *', 'bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      const result = service.evaluateToolUse(
        'Bash',
        { command: 'git add . && git commit -m "test"' },
        settings
      )
      expect(result).toBe('allow')
    })

    test('wildcard pattern matches all', () => {
      const settings = {
        allowlist: ['bash: *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      const result = service.evaluateToolUse(
        'Bash',
        { command: 'git add . && git commit -m "test" && git push' },
        settings
      )
      expect(result).toBe('allow')
    })
  })

  describe('splitBashChain', () => {
    test('splits on && || | and ;', () => {
      expect(service.splitBashChain('cmd1 && cmd2')).toEqual(['cmd1', 'cmd2'])
      expect(service.splitBashChain('cmd1 || cmd2')).toEqual(['cmd1', 'cmd2'])
      expect(service.splitBashChain('cmd1 | cmd2')).toEqual(['cmd1', 'cmd2'])
      expect(service.splitBashChain('cmd1; cmd2')).toEqual(['cmd1', 'cmd2'])
      expect(service.splitBashChain('cmd1 && cmd2 || cmd3')).toEqual(['cmd1', 'cmd2', 'cmd3'])
    })

    test('handles complex git commit command', () => {
      const cmd = 'git commit -m "Fix: Build Docker image for Linux/amd64 platform GKE requires Linux/amd64 images. Building on Apple Silicon without --platform flag creates arm64 images, causing \'no match for platform in manifest\' errors. Add --platform linux/amd64 to ensure the image works on GKE."'
      expect(service.splitBashChain(cmd)).toEqual([cmd])
    })

    test('does not split on pipes inside quoted strings', () => {
      // Real-world case from logs: commit message with | character
      const cmd = 'git commit -m "Fix: using | int filter to convert port"'
      expect(service.splitBashChain(cmd)).toEqual([cmd])

      // Multiple commands with pipes in quoted strings
      const cmd2 = 'echo "a | b" && echo "c | d"'
      expect(service.splitBashChain(cmd2)).toEqual(['echo "a | b"', 'echo "c | d"'])
    })

    test('handles heredocs with special characters', () => {
      const cmd = `git commit -m "$(cat <<'EOF'
Fix using | int filter
Two fixes: a && b
Changes: c || d; e
EOF
)"`
      // Should be one command, not split on |, &&, ||, or ; inside the heredoc
      expect(service.splitBashChain(cmd)).toEqual([cmd])
    })

    test('handles chained commands with heredocs', () => {
      const cmd = 'cd k8s-values && git commit -m "using | int filter"'
      expect(service.splitBashChain(cmd)).toEqual([
        'cd k8s-values',
        'git commit -m "using | int filter"'
      ])
    })

    test('handles single quotes with special characters', () => {
      const cmd = "echo 'a | b && c' && echo 'd'"
      expect(service.splitBashChain(cmd)).toEqual(["echo 'a | b && c'", "echo 'd'"])
    })

    test('handles escaped quotes', () => {
      const cmd = 'echo "a \\" b" && echo "c"'
      expect(service.splitBashChain(cmd)).toEqual(['echo "a \\" b"', 'echo "c"'])
    })
  })
})
