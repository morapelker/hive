import { describe, it, expect, vi } from 'vitest'

// Mock the logger module before importing anything that uses it
vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { CommandFilterService } from '../../src/main/services/command-filter-service'

describe('CommandFilterService - splitBashChain', () => {
  const service = new CommandFilterService()

  describe('Simple commands', () => {
    it('should split basic && commands', () => {
      const result = service.splitBashChain('echo hello && echo world')
      expect(result).toEqual(['echo hello', 'echo world'])
    })

    it('should handle multiple && operators', () => {
      const result = service.splitBashChain('cmd1 && cmd2 && cmd3 && cmd4')
      expect(result).toEqual(['cmd1', 'cmd2', 'cmd3', 'cmd4'])
    })

    it('should handle extra whitespace around &&', () => {
      const result = service.splitBashChain('echo hello   &&   echo world')
      expect(result).toEqual(['echo hello', 'echo world'])
    })

    it('should handle single command with no &&', () => {
      const result = service.splitBashChain('echo hello world')
      expect(result).toEqual(['echo hello world'])
    })
  })

  describe('Quoted strings', () => {
    it('should not split && inside single quotes', () => {
      const result = service.splitBashChain("echo 'foo && bar' && echo done")
      expect(result).toEqual(["echo 'foo && bar'", 'echo done'])
    })

    it('should not split && inside double quotes', () => {
      const result = service.splitBashChain('echo "foo && bar" && echo done')
      expect(result).toEqual(['echo "foo && bar"', 'echo done'])
    })

    it('should handle mixed quotes', () => {
      const result = service.splitBashChain(`echo "it's && complex" && echo 'done && "quoted"'`)
      expect(result).toEqual([`echo "it's && complex"`, `echo 'done && "quoted"'`])
    })

    it('should handle escaped quotes', () => {
      const result = service.splitBashChain('echo "test \\"&& escaped\\"" && echo done')
      expect(result).toEqual(['echo "test \\"&& escaped\\""', 'echo done'])
    })
  })

  describe('Command substitutions', () => {
    it('should not split && inside $(...)', () => {
      const result = service.splitBashChain('echo $(echo foo && echo bar) && echo done')
      expect(result).toEqual(['echo $(echo foo && echo bar)', 'echo done'])
    })

    it('should not split && inside backticks', () => {
      const result = service.splitBashChain('echo `echo foo && echo bar` && echo done')
      expect(result).toEqual(['echo `echo foo && echo bar`', 'echo done'])
    })

    it('should handle nested command substitutions', () => {
      const result = service.splitBashChain('echo $(echo $(echo foo && echo bar)) && echo done')
      expect(result).toEqual(['echo $(echo $(echo foo && echo bar))', 'echo done'])
    })

    it('should handle command substitution in double quotes', () => {
      const result = service.splitBashChain('echo "$(echo foo && echo bar)" && echo done')
      expect(result).toEqual(['echo "$(echo foo && echo bar)"', 'echo done'])
    })
  })

  describe('Heredocs', () => {
    it('should handle basic heredoc with && inside', () => {
      const command = `cat <<EOF
Fix issues:
- Problem A && Problem B
EOF`
      const result = service.splitBashChain(command)
      expect(result).toEqual([command])
    })

    it('should handle quoted heredoc delimiter', () => {
      const command = `cat <<'EOF'
Fix issues:
- Problem A && Problem B
EOF`
      const result = service.splitBashChain(command)
      expect(result).toEqual([command])
    })

    it('should split command after heredoc', () => {
      const heredoc = `cat <<EOF
Fix issues:
- Problem A && Problem B
EOF`
      const command = `${heredoc} && echo done`
      const result = service.splitBashChain(command)
      expect(result).toEqual([heredoc, 'echo done'])
    })

    it('should handle the user example command correctly', () => {
      const command = `git commit -m "$(cat <<'EOF'
Fix issues:
- Problem A && Problem B
EOF
)" && npm install express`
      const result = service.splitBashChain(command)
      expect(result).toEqual([
        `git commit -m "$(cat <<'EOF'
Fix issues:
- Problem A && Problem B
EOF
)"`,
        'npm install express'
      ])
    })

    it('should handle indented heredoc (<<-)', () => {
      const command = `cat <<-EOF
\tFix issues:
\t- Problem A && Problem B
\tEOF`
      const result = service.splitBashChain(command)
      expect(result).toEqual([command])
    })
  })

  describe('Escape sequences', () => {
    it('should handle escaped &&', () => {
      const result = service.splitBashChain('echo foo \\&& bar && echo done')
      expect(result).toEqual(['echo foo \\&& bar', 'echo done'])
    })

    it('should handle escaped quotes', () => {
      const result = service.splitBashChain('echo \\"test && test\\" && echo done')
      expect(result).toEqual(['echo \\"test', 'test\\"', 'echo done'])
    })

    it('should handle backslash at end of command', () => {
      const result = service.splitBashChain('echo test\\ && echo done')
      expect(result).toEqual(['echo test\\', 'echo done'])
    })
  })

  describe('Complex real-world examples', () => {
    it('should handle npm scripts with &&', () => {
      const result = service.splitBashChain('npm run build && npm test && npm publish')
      expect(result).toEqual(['npm run build', 'npm test', 'npm publish'])
    })

    it('should handle git commands with complex messages', () => {
      const command = 'git add . && git commit -m "feat: add && operator support" && git push'
      const result = service.splitBashChain(command)
      expect(result).toEqual([
        'git add .',
        'git commit -m "feat: add && operator support"',
        'git push'
      ])
    })

    it('should handle environment variables and quotes', () => {
      const command = 'NODE_ENV="production && test" npm start && echo "done && finished"'
      const result = service.splitBashChain(command)
      expect(result).toEqual([
        'NODE_ENV="production && test" npm start',
        'echo "done && finished"'
      ])
    })

    it('should handle pipes and other operators (not splitting on them)', () => {
      const result = service.splitBashChain('ls | grep foo && echo done')
      expect(result).toEqual(['ls | grep foo', 'echo done'])
    })

    it('should handle semicolons (not splitting on them)', () => {
      const result = service.splitBashChain('cd /tmp; ls && echo done')
      expect(result).toEqual(['cd /tmp; ls', 'echo done'])
    })

    it('should handle OR operators (not splitting on them)', () => {
      const result = service.splitBashChain('test -f file || touch file && echo done')
      expect(result).toEqual(['test -f file || touch file', 'echo done'])
    })
  })

  describe('Edge cases', () => {
    it('should handle empty command', () => {
      const result = service.splitBashChain('')
      expect(result).toEqual([])
    })

    it('should handle whitespace-only command', () => {
      const result = service.splitBashChain('   ')
      expect(result).toEqual([])
    })

    it('should handle only && operators', () => {
      const result = service.splitBashChain('&& && &&')
      expect(result).toEqual([])
    })

    it('should handle command starting with &&', () => {
      const result = service.splitBashChain('&& echo hello && echo world')
      expect(result).toEqual(['echo hello', 'echo world'])
    })

    it('should handle command ending with &&', () => {
      const result = service.splitBashChain('echo hello && echo world &&')
      expect(result).toEqual(['echo hello', 'echo world'])
    })

    it('should handle unclosed quotes gracefully', () => {
      const result = service.splitBashChain('echo "unclosed && echo done')
      // With unclosed quotes, && inside should not split
      expect(result).toEqual(['echo "unclosed && echo done'])
    })

    it('should handle unclosed command substitution gracefully', () => {
      const result = service.splitBashChain('echo $(echo foo && echo bar')
      // With unclosed $(), && inside should not split
      expect(result).toEqual(['echo $(echo foo && echo bar'])
    })
  })

  describe('Performance', () => {
    it('should handle very long commands efficiently', () => {
      const longCommand = Array(100).fill('echo test').join(' && ')
      const start = Date.now()
      const result = service.splitBashChain(longCommand)
      const duration = Date.now() - start

      expect(result).toHaveLength(100)
      expect(duration).toBeLessThan(100) // Should parse in less than 100ms
    })

    it('should handle deeply nested command substitutions', () => {
      let command = 'echo done'
      for (let i = 0; i < 10; i++) {
        command = `echo $(${command} && echo nested)`
      }
      command = command + ' && echo final'

      const result = service.splitBashChain(command)
      expect(result).toHaveLength(2)
      expect(result[1]).toBe('echo final')
    })
  })

  describe('Backward compatibility with legacy method', () => {
    it('should have the legacy method available', () => {
      const result = service.splitBashChainLegacy('echo hello && echo world')
      expect(result).toEqual(['echo hello', 'echo world'])
    })

    it('legacy method should split incorrectly on quoted &&', () => {
      // This demonstrates the bug in the legacy method
      const result = service.splitBashChainLegacy('echo "foo && bar" && echo done')
      expect(result).toEqual(['echo "foo', 'bar"', 'echo done'])
    })

    it('new method should handle the same command correctly', () => {
      // This shows the fix in the new method
      const result = service.splitBashChain('echo "foo && bar" && echo done')
      expect(result).toEqual(['echo "foo && bar"', 'echo done'])
    })
  })

  describe('Pattern matching with wildcards', () => {
    it('should match patterns with wildcards', () => {
      const settings = {
        enabled: true,
        defaultBehavior: 'ask' as const,
        allowlist: ['bash: git commit *'],
        blocklist: []
      }

      // Simple command should match
      const result1 = service.evaluateToolUse('bash', { command: 'git commit -m "test"' }, settings)
      expect(result1).toBe('allow')

      // Command with arguments should match
      const result2 = service.evaluateToolUse('bash', { command: 'git commit --amend' }, settings)
      expect(result2).toBe('allow')
    })

    it('should match patterns with newlines in commands (heredoc fix)', () => {
      const settings = {
        enabled: true,
        defaultBehavior: 'ask' as const,
        allowlist: ['bash: git commit *'],
        blocklist: []
      }

      // Command with heredoc (contains newlines) should match the wildcard pattern
      const commandWithNewlines = `git commit -m "$(cat <<'EOF'
Fix issues:
- Problem A && Problem B
EOF
)"`

      const result = service.evaluateToolUse('bash', { command: commandWithNewlines }, settings)
      expect(result).toBe('allow')
    })

    it('should match broader patterns', () => {
      const settings = {
        enabled: true,
        defaultBehavior: 'ask' as const,
        allowlist: ['bash: git *'],
        blocklist: []
      }

      // Any git command should match
      const result1 = service.evaluateToolUse('bash', { command: 'git status' }, settings)
      expect(result1).toBe('allow')

      const result2 = service.evaluateToolUse('bash', { command: 'git commit -m "test"' }, settings)
      expect(result2).toBe('allow')

      const result3 = service.evaluateToolUse('bash', { command: 'git push origin main' }, settings)
      expect(result3).toBe('allow')
    })
  })
})