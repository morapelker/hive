import { describe, expect, test, vi } from 'vitest'

// Import and mock the logger before importing the service
vi.mock('../src/main/services/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
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
      // Heredocs inside command substitutions $() should be kept intact (not split on newlines)
      // This is the correct behavior - heredocs are legitimate multi-line constructs
      const result = service.splitBashChain(cmd)
      expect(result).toEqual([cmd]) // Should be ONE command, not split
    })

    test('real-world: git commit with heredoc (user reported issue)', () => {
      // This is the exact scenario reported: should NOT ask for approval for each line
      const cmd = `git commit -m "$(cat <<'EOF'
Fix HealthCheckPolicy port rendering
Problem: - Previous fix used | int filter
Solution: - Apply | int filter
EOF
)"`
      const result = service.splitBashChain(cmd)
      expect(result).toEqual([cmd]) // Must be ONE command
      expect(result.length).toBe(1) // NOT split into multiple parts
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

    // Security: Newline injection prevention tests
    test('splits on unquoted newlines (security)', () => {
      // Newlines at top level should split to prevent injection attacks
      const cmd = 'ls\nrm -rf /'
      expect(service.splitBashChain(cmd)).toEqual(['ls', 'rm -rf /'])

      const cmd2 = 'echo "safe"\nmalicious command'
      expect(service.splitBashChain(cmd2)).toEqual(['echo "safe"', 'malicious command'])
    })

    test('defensively splits simple quoted strings with newlines (security)', () => {
      // Simple strings with newlines (no command substitutions) are split for security
      // This prevents hiding malicious commands in quoted strings
      const cmd = 'echo "line1\nline2"'
      expect(service.splitBashChain(cmd)).toEqual(['echo "line1', 'line2"'])

      const cmd2 = "echo 'line1\nline2'"
      expect(service.splitBashChain(cmd2)).toEqual(["echo 'line1", "line2'"])
    })

    // Command substitution tests
    test('preserves operators inside command substitutions $()', () => {
      // Operators inside $(...) should NOT split
      const cmd = 'echo $(cmd1 && cmd2)'
      expect(service.splitBashChain(cmd)).toEqual([cmd])

      const cmd2 = 'echo $(cmd1 | cmd2 || cmd3)'
      expect(service.splitBashChain(cmd2)).toEqual([cmd2])
    })

    test('preserves newlines inside command substitutions (legitimate multi-line commands)', () => {
      // Command substitutions with newlines are legitimate - keep intact
      // This allows heredocs and multi-line commands inside $()
      const cmd = 'echo $(cmd1\ncmd2)'
      expect(service.splitBashChain(cmd)).toEqual([cmd])
    })

    test('splits on operators outside command substitutions', () => {
      const cmd = 'cmd1 && echo $(cmd2 | cmd3) && cmd4'
      expect(service.splitBashChain(cmd)).toEqual([
        'cmd1',
        'echo $(cmd2 | cmd3)',
        'cmd4'
      ])
    })

    test('handles nested command substitutions', () => {
      const cmd = 'echo $(outer $(inner))'
      expect(service.splitBashChain(cmd)).toEqual([cmd])

      const cmd2 = 'echo $(echo $(echo "test"))'
      expect(service.splitBashChain(cmd2)).toEqual([cmd2])
    })

    test('handles command substitutions inside double quotes', () => {
      const cmd = 'echo "$(cmd1 && cmd2)"'
      expect(service.splitBashChain(cmd)).toEqual([cmd])

      const cmd2 = 'echo "prefix $(cmd1 | cmd2) suffix"'
      expect(service.splitBashChain(cmd2)).toEqual([cmd2])
    })

    test('distinguishes between $() and bare parentheses', () => {
      // $(cmd) is a command substitution - preserve operators inside
      const cmd1 = 'echo $(cmd1 && cmd2)'
      expect(service.splitBashChain(cmd1)).toEqual([cmd1])

      // (cmd1 && cmd2) is a bare subshell - preserve operators inside
      const cmd2 = '(cmd1 && cmd2)'
      expect(service.splitBashChain(cmd2)).toEqual([cmd2])

      // But split outside the subshell
      const cmd3 = 'cmd0 && (cmd1 && cmd2) && cmd3'
      expect(service.splitBashChain(cmd3)).toEqual([
        'cmd0',
        '(cmd1 && cmd2)',
        'cmd3'
      ])
    })

    // Bare subshell tests
    test('preserves operators inside bare subshells ()', () => {
      const cmd = '(cmd1 && cmd2 || cmd3)'
      expect(service.splitBashChain(cmd)).toEqual([cmd])

      const cmd2 = '(cmd1; cmd2)'
      expect(service.splitBashChain(cmd2)).toEqual([cmd2])
    })

    test('splits on operators outside bare subshells', () => {
      const cmd = 'cmd1 && (cmd2 | cmd3) || cmd4'
      expect(service.splitBashChain(cmd)).toEqual([
        'cmd1',
        '(cmd2 | cmd3)',
        'cmd4'
      ])
    })

    test('handles nested bare subshells', () => {
      const cmd = '(cmd1 && (cmd2 || cmd3))'
      expect(service.splitBashChain(cmd)).toEqual([cmd])
    })

    test('handles mixed bare subshells and command substitutions', () => {
      const cmd = '(cmd1 && $(cmd2 | cmd3)) || cmd4'
      expect(service.splitBashChain(cmd)).toEqual([
        '(cmd1 && $(cmd2 | cmd3))',
        'cmd4'
      ])
    })

    // Complex real-world scenarios
    test('handles complex mixed command with all features', () => {
      // Command substitution inside quotes, with operators outside
      const cmd = 'git add . && git commit -m "$(date): Changes $(git status | grep modified)" && git push'
      expect(service.splitBashChain(cmd)).toEqual([
        'git add .',
        'git commit -m "$(date): Changes $(git status | grep modified)"',
        'git push'
      ])
    })

    test('handles escaped dollar signs', () => {
      const cmd = 'echo "\\$HOME" && echo $HOME'
      expect(service.splitBashChain(cmd)).toEqual(['echo "\\$HOME"', 'echo $HOME'])
    })

    test('handles multiple pipes in different contexts', () => {
      // Pipe inside $() should not split, pipe outside should
      const cmd = 'echo $(ls | grep test) | cat'
      expect(service.splitBashChain(cmd)).toEqual([
        'echo $(ls | grep test)',
        'cat'
      ])
    })

    // Edge cases and defensive fallback
    test('defensive fallback: parts with newlines after parsing are re-split', () => {
      // This tests the defensive fallback for parser limitations
      // If a part somehow contains a newline after parsing, it should be split
      // Note: This is hard to trigger with correct parser, but tests the safety net
      const result = service.splitBashChain('cmd1\ncmd2')
      expect(result).toEqual(['cmd1', 'cmd2'])
      // Each part should NOT contain newlines
      result.forEach(part => {
        expect(part).not.toMatch(/\n/)
      })
    })
  })

  describe('pattern matching normalizes heredocs but not suspicious newlines', () => {
    test('heredocs in command substitutions match wildcard patterns', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Heredoc inside command substitution should match "bash: git commit *"
      const cmd = `git commit -m "$(cat <<'EOF'
Fix HealthCheckPolicy port rendering
Problem: - Previous fix used | int filter
Solution: - Apply | int filter
EOF
)"`

      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)
      // Should be 'allow' - heredoc is normalized for pattern matching
      expect(result).toBe('allow')
    })

    test('suspicious simple strings with newlines do NOT match patterns', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Simple string with newline (no command substitution) - suspicious
      const cmd = 'echo "line1\nline2"'
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'ask' because the command is split into parts that don't match individually
      // After splitting: ['echo "line1', 'line2"'] - neither matches 'bash: echo *' cleanly
      expect(result).toBe('ask')
    })

    test('command with newline injection is split and checked separately', () => {
      const settings = {
        allowlist: ['bash: ls *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Injection attempt: ls\nrm -rf /
      const result = service.evaluateToolUse(
        'Bash',
        { command: 'ls\nrm -rf /' },
        settings
      )

      // Should be 'ask' because 'rm -rf /' doesn't match 'bash: ls *'
      expect(result).toBe('ask')
    })

    test('all parts must match allowlist for multi-command chains', () => {
      const settings = {
        allowlist: ['bash: git *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Both commands match the pattern
      const result1 = service.evaluateToolUse(
        'Bash',
        { command: 'git add . && git commit -m "test"' },
        settings
      )
      expect(result1).toBe('allow')

      // Only one command matches
      const result2 = service.evaluateToolUse(
        'Bash',
        { command: 'git add . && npm install' },
        settings
      )
      expect(result2).toBe('ask')
    })
  })
})
