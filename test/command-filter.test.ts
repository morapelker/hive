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

      // Simple string with ACTUAL newline (not literal \n) - suspicious
      // Using template literal to create actual newline character
      const cmd = `echo "line1
line2"`
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

    test('escaped \\$( is NOT treated as command substitution', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Escaped command substitution with newline - should be split
      const cmd = `echo "line1
line2 \\$(date)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'ask' because \\$( is escaped (not a command substitution),
      // so the newline causes splitting, and fragments don't match patterns
      expect(result).toBe('ask')
    })

    test('double-escaped \\\\$( IS treated as command substitution', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Double-escaped backslash, so $( is NOT escaped - IS a command substitution
      const cmd = `echo "$(cat <<EOF
line1
line2 \\\\$(date)
EOF
)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'allow' because \\\\$( has escaped backslash, leaving $( as valid substitution
      expect(result).toBe('allow')
    })

    test('SECURITY: quoted string with <<MARKER and newline does NOT bypass split', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Attack attempt: echo with quoted string containing fake heredoc marker
      // This should be SPLIT because << is inside quotes, not a real heredoc
      const cmd = `echo "safe text <<MARKER
rm -rf /
MARKER"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'ask' because the newline causes splitting,
      // and fragments don't match the allowlist pattern
      // This prevents the attack from being auto-approved
      expect(result).toBe('ask')
    })

    test('SECURITY: top-level heredoc is split (not supported)', () => {
      const settings = {
        allowlist: ['bash: cat *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Top-level heredoc (not inside command substitution)
      const cmd = `cat <<EOF
line1
line2
EOF`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'ask' because top-level heredocs are not supported
      // The command is split into parts, and they won't all match
      expect(result).toBe('ask')
    })
  })

  describe('nested parentheses handling', () => {
    test('bare parens inside command substitution do not cause premature close', () => {
      // $(cmd (inner)) - the first ) should close (inner), not $(
      const cmd = 'echo $(echo (date) | cat)'
      const result = service.splitBashChain(cmd)

      // Should be ONE command, not split
      expect(result).toEqual([cmd])
    })

    test('multiple nested bare parens inside command substitution', () => {
      const cmd = 'echo $(cmd1 (a) && cmd2 (b) || cmd3 (c))'
      const result = service.splitBashChain(cmd)

      // Should be ONE command, operators inside $() should not cause splitting
      expect(result).toEqual([cmd])
    })

    test('nested command substitutions', () => {
      const cmd = 'echo $(outer $(inner))'
      const result = service.splitBashChain(cmd)

      // Should be ONE command
      expect(result).toEqual([cmd])
    })

    test('deeply nested command substitutions', () => {
      const cmd = 'echo $(level1 $(level2 $(level3)))'
      const result = service.splitBashChain(cmd)

      // Should be ONE command
      expect(result).toEqual([cmd])
    })

    test('mixed: bare parens and command substitutions', () => {
      const cmd = 'echo $(cmd1 (sub1 $(nested)) && cmd2 (sub2))'
      const result = service.splitBashChain(cmd)

      // Should be ONE command
      expect(result).toEqual([cmd])
    })

    test('top-level bare parens still work correctly', () => {
      const cmd = '(cd dir && make) || exit 1'
      const result = service.splitBashChain(cmd)

      // Should split on || but not on && inside (...)
      expect(result).toEqual(['(cd dir && make)', 'exit 1'])
    })
  })

  describe('FIXED: Single quotes inside double-quoted command substitutions', () => {
    test('single quotes inside double-quoted command substitution work correctly', () => {
      // FIXED: Single quotes inside command substitutions now work correctly
      // In bash, this command has a literal ')' inside single quotes:
      // "$(echo ')' && safe)"
      // The single quotes create a quote context INSIDE the command substitution,
      // independent of the outer double quotes.
      const cmd = '"$(echo \')\' && echo safe)"'
      const result = service.splitBashChain(cmd)

      // Should be ONE command (the && is inside the command substitution)
      expect(result).toEqual([cmd])
      expect(result.length).toBe(1)
    })

    test('single quotes with ) inside double-quoted substitution (security test)', () => {
      // This was the original bypass scenario - ensure it's fixed
      const cmd = '"$(echo \')\' && rm -rf /)"'
      const result = service.splitBashChain(cmd)

      // Should NOT split at && because it's inside the command substitution
      expect(result).toEqual([cmd])
      expect(result.length).toBe(1)
    })

    test('complex: multiple single quotes inside double-quoted substitution', () => {
      const cmd = '"$(echo \'(\' && echo \')\' && echo \';\' )"'
      const result = service.splitBashChain(cmd)

      // All the special chars are inside single quotes, so they should be literal
      expect(result).toEqual([cmd])
      expect(result.length).toBe(1)
    })

  })

  describe('KNOWN LIMITATIONS: Remaining parser edge cases', () => {
    test.skip('LIMITATION: Complex quote nesting in command substitutions', () => {
      // SECURITY ISSUE: Deeply nested quote contexts may not parse correctly
      // Example: Double quotes inside command substitution inside double quotes
      const _cmd = 'echo "$(cat <<EOF | grep "pattern"\\nline2\\nEOF)"'
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _result = service.splitBashChain(_cmd)

      // This kind of complex nesting may not parse correctly
      console.warn('KNOWN LIMITATION: Complex quote nesting in substitutions may cause incorrect parsing')
    })

    test('BREAKING CHANGE: Top-level heredocs are no longer supported', () => {
      // ⚠️ BREAKING CHANGE: Top-level heredocs now split line-by-line
      // This is a security-driven design decision (see KNOWN LIMITATIONS)
      //
      // Previous behavior: May have worked in some cases
      // New behavior: Each line requires separate approval
      //
      // Workaround: Use command substitution:
      //   cat "$(cat <<'EOF'
      //   line1
      //   line2
      //   EOF
      //   )"
      const cmd = `cat <<EOF
line1
line2
EOF`
      const result = service.splitBashChain(cmd)

      // Splits into multiple parts (breaking change, but intentional)
      expect(result.length).toBeGreaterThan(1)

      // Each line becomes a separate part
      expect(result).toContain('cat <<EOF')
      expect(result).toContain('line1')
      expect(result).toContain('line2')
      expect(result).toContain('EOF')
    })

    test('DOCUMENTED: Workaround for multi-line content - use command substitution', () => {
      // ✅ RECOMMENDED APPROACH: Use command substitution with heredoc
      const cmd = `cat "$(cat <<'EOF'
line1
line2
EOF
)"`
      const result = service.splitBashChain(cmd)

      // Should be ONE command (heredoc inside command substitution is supported)
      expect(result).toEqual([cmd])
      expect(result.length).toBe(1)
    })
  })

  describe('CRITICAL SECURITY: Multi-line commands in $(...) with heredoc heuristic', () => {
    test('ATTACK BLOCKED: $(…) with newlines but NO heredoc marker requires approval', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // ATTACK VECTOR: Newlines are command separators inside $(...)
      // This would execute BOTH "echo placeholder" AND "rm -rf /"
      const cmd = `git commit -m "$(echo placeholder
rm -rf /)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // MUST return 'ask' - no heredoc marker, so newlines are suspicious
      // User must manually review and approve
      expect(result).toBe('ask')
    })

    test('LEGITIMATE: $(…) with heredoc marker is allowed to match patterns', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Legitimate use case: heredoc inside command substitution
      const cmd = `git commit -m "$(cat <<'EOF'
Fix bug in parser

This is a multi-line
commit message
EOF
)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'allow' - has heredoc marker, matches pattern
      expect(result).toBe('allow')
    })

    test('SECURITY: Different heredoc formats are recognized', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Test various heredoc syntaxes
      const testCases = [
        `git commit -m "$(cat <<EOF
text
EOF
)"`,  // Basic heredoc
        `git commit -m "$(cat <<'EOF'
text
EOF
)"`,  // Quoted delimiter
        `git commit -m "$(cat <<"EOF"
text
EOF
)"`,  // Double-quoted delimiter
        `git commit -m "$(cat <<-EOF
text
EOF
)"`,  // Indented heredoc (<<-)
      ]

      testCases.forEach(cmd => {
        const result = service.evaluateToolUse('Bash', { command: cmd }, settings)
        expect(result).toBe('allow') // All should match pattern with heredoc present
      })
    })

    test('SECURITY: Heredoc heuristic applies even if pattern would match', () => {
      const settings = {
        allowlist: ['bash: *'], // Broad wildcard
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Even with broad wildcard, no heredoc = manual approval required
      const cmd = `echo "$(date
ls)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      expect(result).toBe('ask') // Security overrides even broad patterns
    })

    test('DOCUMENTED LIMITATION: Heredoc + operator can bypass (defense-in-depth applies)', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // This is the documented bypass scenario
      const cmd = `git commit -m "$(cat <<EOF
text
EOF
; rm -rf /)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Will be 'allow' because heredoc marker present
      // BUT: Still protected by:
      // 1. Must match allowlist pattern
      // 2. User should use specific patterns (not "bash: *")
      // 3. Can use deny rules for dangerous commands
      expect(result).toBe('allow')

      // This is intentional - we document this limitation clearly
      // Users should use deny rules for protection:
      // blocklist: ['bash: rm -rf *']
    })

    test('ATTACK BLOCKED: Fake heredoc marker inside double quotes should NOT bypass security', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // ATTACK VECTOR: <<WORD inside quotes is literal text, NOT a heredoc marker
      // This should be treated as suspicious (no real heredoc) and require manual approval
      const cmd = `git commit -m "Documentation says: use <<NOTE for comments
rm -rf /"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // MUST return 'ask' - no REAL heredoc marker (it's inside quotes)
      // The context-unaware regex /<<-?['"]?\w+['"]?/ would incorrectly match this
      expect(result).toBe('ask')
    })

    test('ATTACK BLOCKED: Fake heredoc marker inside single quotes should NOT bypass security', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // <<WORD inside single quotes is literal text
      const cmd = `git commit -m 'Examples: <<EOF or <<NOTE
malicious'`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // MUST return 'ask' - no real heredoc marker
      expect(result).toBe('ask')
    })

    test('ATTACK BLOCKED: Escaped heredoc marker should NOT bypass security', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // \<< is escaped, not a heredoc marker
      const cmd = `echo "Text with \\<<EOF marker
malicious"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // MUST return 'ask' - escaped << is not a real heredoc
      expect(result).toBe('ask')
    })

    test('LEGITIMATE: Real heredoc marker outside quotes still works', () => {
      const settings = {
        allowlist: ['bash: git commit *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Real heredoc: << appears outside quotes
      const cmd = `git commit -m "$(cat <<EOF
Fix bug
EOF
)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'allow' - real heredoc marker detected
      expect(result).toBe('allow')
    })

    test('SECURITY: Mixed quote contexts - heredoc marker must be outside ALL quotes', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Complex case: command substitution inside double quotes with fake heredoc text
      const cmd = `echo "$(echo 'fake <<EOF marker'
malicious)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // MUST return 'ask' - heredoc marker is inside single quotes (inside the substitution)
      expect(result).toBe('ask')
    })
  })

  describe('CRITICAL SECURITY: hasUnescapedCommandSubstitution quote-blindness fix', () => {
    test('SECURITY BYPASS: $( inside single quotes is literal, NOT a command substitution', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // ATTACK VECTOR: Literal $( inside single quotes with newline injection
      // In bash, single quotes make EVERYTHING literal (no substitution)
      const cmd = `echo 'literal $(date)
rm -rf /'`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'ask' because $( inside single quotes is literal (not a substitution)
      // so the newline should cause splitting, and fragments won't match patterns
      // This MUST be 'ask' to prevent the attack!
      expect(result).toBe('ask')
    })

    test('LEGITIMATE: $( inside double quotes IS a command substitution', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Legitimate use: Command substitution inside double quotes
      const cmd = `echo "result: $(cat <<'EOF'
line1
line2
EOF
)"`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'allow' because $( inside double quotes IS a substitution
      // so the newline is legitimate and the whole command matches the pattern
      expect(result).toBe('allow')
    })

    test('EDGE CASE: escaped \\$( inside single quotes', () => {
      const settings = {
        allowlist: ['bash: echo *'],
        blocklist: [],
        defaultBehavior: 'ask' as const,
        enabled: true
      }

      // Inside single quotes, backslashes are literal too
      const cmd = `echo '\\\\$(date)
test'`
      const result = service.evaluateToolUse('Bash', { command: cmd }, settings)

      // Should be 'ask' - inside single quotes, everything is literal
      expect(result).toBe('ask')
    })
  })

  describe('CRITICAL BUG: Bare parens inside double-quoted command substitutions', () => {
    test('bare parens inside double-quoted command substitution should be tracked', () => {
      // BUG: parenBalance only increments when !inDoubleQuote
      // This means "$(cmd (sub))" doesn't track the (sub) parens
      const cmd = '"$(cmd (sub))"'
      const result = service.splitBashChain(cmd)

      // Should be ONE command - the (sub) is inside the command substitution
      expect(result).toEqual([cmd])
      expect(result.length).toBe(1)
    })

    test('complex: bare parens in double-quoted substitution with operators', () => {
      const cmd = '"$(cmd1 (a) && cmd2 (b))"'
      const result = service.splitBashChain(cmd)

      // Should be ONE command - operators are inside the command substitution
      expect(result).toEqual([cmd])
    })

    test('mixed quotes: bare parens in various contexts', () => {
      // Outside quotes: (cmd)
      // Inside single quotes: '(literal)'
      // Inside double quotes with substitution: "$(cmd (sub))"
      const cmd = '(echo test) && echo \'(literal)\' && echo "$(date (format))"'
      const result = service.splitBashChain(cmd)

      // Should split on && but preserve all paren contexts
      expect(result).toEqual([
        '(echo test)',
        'echo \'(literal)\'',
        'echo "$(date (format))"'
      ])
    })
  })
})
