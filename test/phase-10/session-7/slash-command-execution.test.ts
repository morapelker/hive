import { describe, test, expect, vi } from 'vitest'

/**
 * Session 7: Slash Command Execution — Tests
 *
 * These tests verify:
 * 1. Slash command parsing (name + args extraction)
 * 2. Matched commands route to the command endpoint (not prompt)
 * 3. Unknown commands fall through to prompt
 * 4. Mode auto-switching based on command's agent field
 * 5. SlashCommandPopover shows agent badges
 * 6. OpenCodeCommand type includes new fields
 */

// Helper: simulates the slash command parsing logic from handleSend
function parseSlashCommand(input: string): { commandName: string; commandArgs: string } | null {
  const trimmedValue = input.trim()
  if (!trimmedValue.startsWith('/')) return null
  const spaceIndex = trimmedValue.indexOf(' ')
  const commandName = spaceIndex > 0 ? trimmedValue.slice(1, spaceIndex) : trimmedValue.slice(1)
  const commandArgs = spaceIndex > 0 ? trimmedValue.slice(spaceIndex + 1).trim() : ''
  return { commandName, commandArgs }
}

interface SlashCommand {
  name: string
  description?: string
  template: string
  agent?: string
}

// Helper: simulates the slash command routing logic from handleSend
async function routeMessage(
  input: string,
  slashCommands: SlashCommand[],
  callbacks: {
    command: (name: string, args: string) => Promise<{ success: boolean }>
    prompt: (message: string) => Promise<{ success: boolean }>
    setSessionMode: (mode: string) => Promise<void>
    getSessionMode: () => string
  }
): Promise<'command' | 'prompt' | 'prompt-fallback'> {
  const trimmedValue = input.trim()
  if (trimmedValue.startsWith('/')) {
    const parsed = parseSlashCommand(trimmedValue)
    if (!parsed) return 'prompt'
    const matchedCommand = slashCommands.find((c) => c.name === parsed.commandName)

    if (matchedCommand) {
      // Auto-switch mode based on command's agent field
      if (matchedCommand.agent) {
        const currentMode = callbacks.getSessionMode()
        const targetMode = matchedCommand.agent === 'plan' ? 'plan' : 'build'
        if (currentMode !== targetMode) {
          await callbacks.setSessionMode(targetMode)
        }
      }

      await callbacks.command(parsed.commandName, parsed.commandArgs)
      return 'command'
    } else {
      await callbacks.prompt(trimmedValue)
      return 'prompt-fallback'
    }
  } else {
    await callbacks.prompt(trimmedValue)
    return 'prompt'
  }
}

describe('Session 7: Slash Command Execution', () => {
  describe('Slash command parsing', () => {
    test('parses command name and args from /command-name some args', () => {
      const result = parseSlashCommand('/test-plan some args')
      expect(result).toEqual({ commandName: 'test-plan', commandArgs: 'some args' })
    })

    test('parses command with no args', () => {
      const result = parseSlashCommand('/compact')
      expect(result).toEqual({ commandName: 'compact', commandArgs: '' })
    })

    test('handles multiple spaces in args', () => {
      const result = parseSlashCommand('/review   multiple   spaces  ')
      expect(result).toEqual({ commandName: 'review', commandArgs: 'multiple   spaces' })
    })

    test('returns null for non-slash input', () => {
      const result = parseSlashCommand('regular message')
      expect(result).toBeNull()
    })

    test('returns null for empty input', () => {
      const result = parseSlashCommand('')
      expect(result).toBeNull()
    })

    test('handles command with leading/trailing whitespace', () => {
      // handleSend trims input before parsing, so leading whitespace gets stripped
      const result = parseSlashCommand('  /test-plan some args  ')
      expect(result).toEqual({ commandName: 'test-plan', commandArgs: 'some args' })
    })
  })

  describe('Command routing', () => {
    const slashCommands: SlashCommand[] = [
      { name: 'test-plan', description: 'Test plan command', template: '', agent: 'plan' },
      { name: 'compact', description: 'Compact context', template: '' },
      { name: 'review', description: 'Review code', template: '', agent: 'build' }
    ]

    test('matched command routes to command endpoint', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('build')

      const result = await routeMessage('/test-plan some args', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(result).toBe('command')
      expect(command).toHaveBeenCalledWith('test-plan', 'some args')
      expect(prompt).not.toHaveBeenCalled()
    })

    test('unknown command falls through to prompt', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('build')

      const result = await routeMessage('/unknown-cmd args', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(result).toBe('prompt-fallback')
      expect(prompt).toHaveBeenCalledWith('/unknown-cmd args')
      expect(command).not.toHaveBeenCalled()
    })

    test('regular message routes to prompt', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('build')

      const result = await routeMessage('regular message', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(result).toBe('prompt')
      expect(prompt).toHaveBeenCalledWith('regular message')
      expect(command).not.toHaveBeenCalled()
    })
  })

  describe('Mode auto-switching', () => {
    const slashCommands: SlashCommand[] = [
      { name: 'test-plan', template: '', agent: 'plan' },
      { name: 'review', template: '', agent: 'build' },
      { name: 'compact', template: '' }
    ]

    test('mode switches from build to plan when command.agent is plan', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('build')

      await routeMessage('/test-plan', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(setSessionMode).toHaveBeenCalledWith('plan')
    })

    test('mode switches from plan to build when command.agent is build', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('plan')

      await routeMessage('/review', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(setSessionMode).toHaveBeenCalledWith('build')
    })

    test('mode does not switch when agent matches current mode', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('plan')

      await routeMessage('/test-plan', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(setSessionMode).not.toHaveBeenCalled()
    })

    test('no mode switch when command has no agent field', async () => {
      const command = vi.fn().mockResolvedValue({ success: true })
      const prompt = vi.fn().mockResolvedValue({ success: true })
      const setSessionMode = vi.fn()
      const getSessionMode = vi.fn().mockReturnValue('build')

      await routeMessage('/compact', slashCommands, {
        command,
        prompt,
        setSessionMode,
        getSessionMode
      })

      expect(setSessionMode).not.toHaveBeenCalled()
    })
  })

  describe('OpenCodeCommand type fields', () => {
    test('index.d.ts includes agent, model, source, subtask, hints in OpenCodeCommand', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const typesSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.d.ts'),
        'utf-8'
      )

      // Find the OpenCodeCommand interface block
      expect(typesSource).toContain('interface OpenCodeCommand')
      expect(typesSource).toContain('agent?: string')
      expect(typesSource).toContain('model?: string')
      expect(typesSource).toContain("source?: 'command' | 'mcp' | 'skill'")
      expect(typesSource).toContain('subtask?: boolean')
      expect(typesSource).toContain('hints?: string[]')
    })

    test('OpenCodeCommand type still requires name and template', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const typesSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.d.ts'),
        'utf-8'
      )

      // Extract the OpenCodeCommand interface block
      const startIdx = typesSource.indexOf('interface OpenCodeCommand')
      const endIdx = typesSource.indexOf('}', startIdx)
      const interfaceBlock = typesSource.slice(startIdx, endIdx + 1)

      // name and template should be required (no ?)
      expect(interfaceBlock).toMatch(/\bname:\s*string/)
      expect(interfaceBlock).toMatch(/\btemplate:\s*string/)
    })
  })

  describe('IPC and preload layer (source verification)', () => {
    test('opencode:command handler registered in opencode-handlers.ts', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const handlersSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/ipc/opencode-handlers.ts'),
        'utf-8'
      )

      expect(handlersSource).toContain("'opencode:command'")
      expect(handlersSource).toContain('openCodeService.sendCommand')
    })

    test('preload exposes command() on opencodeOps', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const preloadSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.ts'),
        'utf-8'
      )

      expect(preloadSource).toContain("ipcRenderer.invoke('opencode:command'")
    })

    test('sendCommand service method exists in opencode-service.ts', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const serviceSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/main/services/opencode-service.ts'),
        'utf-8'
      )

      expect(serviceSource).toContain('async sendCommand(')
      expect(serviceSource).toContain('client.session.command(')
    })

    test('type declarations include command() on opencodeOps', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const typesSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/preload/index.d.ts'),
        'utf-8'
      )

      expect(typesSource).toContain('command: (')
      expect(typesSource).toContain('opencodeSessionId: string')
    })
  })

  describe('SlashCommandPopover agent badge', () => {
    test('SlashCommandPopover source includes agent badge rendering', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const popoverSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/sessions/SlashCommandPopover.tsx'
        ),
        'utf-8'
      )

      // Verify the agent badge rendering code is present
      expect(popoverSource).toContain('cmd.agent')
      expect(popoverSource).toContain('bg-violet-500/20')
      expect(popoverSource).toContain('bg-blue-500/20')
    })

    test('SlashCommand interface includes agent field', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const popoverSource = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../src/renderer/src/components/sessions/SlashCommandPopover.tsx'
        ),
        'utf-8'
      )

      expect(popoverSource).toContain('agent?: string')
    })
  })
})
