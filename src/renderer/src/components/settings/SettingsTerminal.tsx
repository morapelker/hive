import { useState, useEffect } from 'react'
import {
  useSettingsStore,
  type TerminalOption,
  type EmbeddedTerminalBackend
} from '@/stores/useSettingsStore'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Check, Loader2, Info, Shield } from 'lucide-react'

interface DetectedTerminal {
  id: string
  name: string
  command: string
  available: boolean
}

const TERMINAL_OPTIONS: { id: TerminalOption; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'iterm', label: 'iTerm2' },
  { id: 'warp', label: 'Warp' },
  { id: 'alacritty', label: 'Alacritty' },
  { id: 'kitty', label: 'kitty' },
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'custom', label: 'Custom Command' }
]

const BACKEND_OPTIONS: {
  id: EmbeddedTerminalBackend
  label: string
  description: string
  macOnly?: boolean
}[] = [
  {
    id: 'xterm',
    label: 'Built-in (xterm.js)',
    description: 'Cross-platform terminal emulator. Always available.'
  },
  {
    id: 'ghostty',
    label: 'Ghostty (native)',
    description: 'Native Metal rendering on macOS. Requires Ghostty.',
    macOnly: true
  }
]

export function SettingsTerminal(): React.JSX.Element {
  const {
    defaultTerminal,
    customTerminalCommand,
    embeddedTerminalBackend,
    ghosttyFontSize,
    dockerSandboxAgent,
    dockerSandboxMountGitReadOnly,
    updateSetting
  } = useSettingsStore()
  const [detectedTerminals, setDetectedTerminals] = useState<DetectedTerminal[]>([])
  const [isDetecting, setIsDetecting] = useState(true)
  const [ghosttyAvailable, setGhosttyAvailable] = useState<boolean | null>(null)
  const [isMac, setIsMac] = useState(false)
  const [dockerSandboxStatus, setDockerSandboxStatus] = useState<{
    dockerAvailable: boolean
    sandboxAvailable: boolean
  } | null>(null)
  const [tokenStatus, setTokenStatus] = useState<boolean | null>(null)
  const [isRegenerating, setIsRegenerating] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function detect(): Promise<void> {
      try {
        if (window.settingsOps?.detectTerminals) {
          const terminals = await window.settingsOps.detectTerminals()
          if (!cancelled) {
            setDetectedTerminals(terminals)
          }
        }
      } catch {
        // Detection failed, show all options
      } finally {
        if (!cancelled) setIsDetecting(false)
      }
    }
    detect()
    return () => {
      cancelled = true
    }
  }, [])

  // Check Ghostty availability and platform
  useEffect(() => {
    let cancelled = false
    async function checkGhostty(): Promise<void> {
      try {
        const result = await window.terminalOps.ghosttyIsAvailable()
        if (!cancelled) {
          setGhosttyAvailable(result.available)
          setIsMac(result.platform === 'darwin')
        }
      } catch {
        if (!cancelled) {
          setGhosttyAvailable(false)
          setIsMac(false)
        }
      }
    }
    checkGhostty()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.worktreeOps.detectDockerSandbox().then((result) => {
      if (!cancelled) setDockerSandboxStatus(result)
    }).catch(() => {
      if (!cancelled) setDockerSandboxStatus({ dockerAvailable: false, sandboxAvailable: false })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.worktreeOps.hasSetupToken().then((result) => {
      if (!cancelled) setTokenStatus(result.hasToken)
    }).catch(() => {
      if (!cancelled) setTokenStatus(false)
    })
    return () => { cancelled = true }
  }, [])

  const handleRegenerateToken = async (): Promise<void> => {
    setIsRegenerating(true)
    try {
      await window.worktreeOps.clearSetupToken()
      const result = await window.worktreeOps.generateSetupToken()
      setTokenStatus(result.success)
    } catch {
      setTokenStatus(false)
    } finally {
      setIsRegenerating(false)
    }
  }

  const isAvailable = (id: string): boolean => {
    if (id === 'custom') return true
    const terminal = detectedTerminals.find((t) => t.id === id)
    return terminal?.available ?? false
  }

  const canSelectBackend = (id: EmbeddedTerminalBackend): boolean => {
    if (id === 'xterm') return true
    if (id === 'ghostty') return isMac && ghosttyAvailable === true
    return false
  }

  return (
    <div className="space-y-8">
      {/* Embedded Terminal Backend */}
      <div>
        <h3 className="text-base font-medium mb-1">Embedded Terminal</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Choose the rendering engine for the built-in terminal panel
        </p>

        <div className="space-y-1">
          {BACKEND_OPTIONS.map((opt) => {
            const selectable = canSelectBackend(opt.id)
            const isSelected = embeddedTerminalBackend === opt.id

            return (
              <button
                key={opt.id}
                onClick={() => {
                  if (selectable) {
                    updateSetting('embeddedTerminalBackend', opt.id)
                  }
                }}
                disabled={!selectable}
                className={cn(
                  'w-full flex items-start justify-between px-3 py-2.5 rounded-md text-sm transition-colors text-left',
                  isSelected
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-accent/50 border border-transparent',
                  !selectable && 'opacity-50 cursor-not-allowed'
                )}
                data-testid={`backend-${opt.id}`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span>{opt.label}</span>
                    {opt.macOnly && !isMac && (
                      <span className="text-xs text-muted-foreground">(macOS only)</span>
                    )}
                    {opt.id === 'ghostty' && isMac && ghosttyAvailable === false && (
                      <span className="text-xs text-muted-foreground">(not available)</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                </div>
                {isSelected && <Check className="h-4 w-4 text-primary mt-0.5 shrink-0" />}
              </button>
            )
          })}
        </div>

        {embeddedTerminalBackend === 'ghostty' && (
          <>
            <div className="flex items-start gap-2 mt-3 p-2.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs">
              <Info className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />
              <p className="text-muted-foreground">
                Ghostty renders via Metal for native performance. The terminal will restart when
                switching backends. Colors and cursor style are read from your Ghostty config.
              </p>
            </div>

            <div className="mt-4 space-y-2">
              <label className="text-sm font-medium">Font Size</label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={8}
                  max={32}
                  value={ghosttyFontSize}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val >= 8 && val <= 32) {
                      updateSetting('ghosttyFontSize', val)
                    }
                  }}
                  className="w-20 font-mono text-sm"
                  data-testid="ghostty-font-size"
                />
                <span className="text-xs text-muted-foreground">pt (8-32)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Font size for the embedded Ghostty terminal. Restart the terminal for changes to
                take effect.
              </p>
            </div>
          </>
        )}
      </div>

      {/* External Terminal (Open in Terminal) */}
      <div>
        <h3 className="text-base font-medium mb-1">External Terminal</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Choose which terminal to use for &quot;Open in Terminal&quot; actions
        </p>

        {isDetecting ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Detecting installed terminals...
          </div>
        ) : (
          <div className="space-y-1">
            {TERMINAL_OPTIONS.map((opt) => {
              const available = isAvailable(opt.id)
              return (
                <button
                  key={opt.id}
                  onClick={() => updateSetting('defaultTerminal', opt.id)}
                  disabled={!available && opt.id !== 'custom'}
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-2.5 rounded-md text-sm transition-colors text-left',
                    defaultTerminal === opt.id
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-accent/50 border border-transparent',
                    !available && opt.id !== 'custom' && 'opacity-50 cursor-not-allowed'
                  )}
                  data-testid={`terminal-${opt.id}`}
                >
                  <div className="flex items-center gap-2">
                    <span>{opt.label}</span>
                    {!available && opt.id !== 'custom' && (
                      <span className="text-xs text-muted-foreground">(not found)</span>
                    )}
                  </div>
                  {defaultTerminal === opt.id && <Check className="h-4 w-4 text-primary" />}
                </button>
              )
            })}
          </div>
        )}

        {/* Custom command input */}
        {defaultTerminal === 'custom' && (
          <div className="space-y-2 mt-3">
            <label className="text-sm font-medium">Custom Terminal Command</label>
            <Input
              value={customTerminalCommand}
              onChange={(e) => updateSetting('customTerminalCommand', e.target.value)}
              placeholder="e.g., /usr/local/bin/alacritty"
              className="font-mono text-sm"
              data-testid="custom-terminal-command"
            />
            <p className="text-xs text-muted-foreground">
              The command will be called with the worktree path as an argument.
            </p>
          </div>
        )}
      </div>

      {/* Docker Sandbox */}
      <div>
        <h3 className="text-base font-medium mb-1">Docker Sandbox</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Run AI agents inside isolated Docker sandbox microVMs. Enable per-worktree via the
          worktree context menu.
        </p>

        {/* Detection status */}
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-4 w-4 text-muted-foreground" />
          {dockerSandboxStatus === null ? (
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Detecting Docker Sandbox...
            </span>
          ) : dockerSandboxStatus.sandboxAvailable ? (
            <span className="text-sm text-green-500">Ready</span>
          ) : dockerSandboxStatus.dockerAvailable ? (
            <span className="text-sm text-amber-500">
              Docker found, but Sandbox unavailable
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Docker not found</span>
          )}
        </div>

        {/* Default agent picker */}
        <div className="space-y-2 mb-4">
          <label className="text-sm font-medium">Default Agent</label>
          <p className="text-xs text-muted-foreground">
            Which agent binary runs inside the sandbox
          </p>
          <div className="space-y-1">
            {(['claude', 'codex', 'copilot', 'gemini', 'opencode', 'shell'] as const).map(
              (agent) => (
                <button
                  key={agent}
                  onClick={() => updateSetting('dockerSandboxAgent', agent)}
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors text-left',
                    dockerSandboxAgent === agent
                      ? 'bg-primary/10 border border-primary/30'
                      : 'hover:bg-accent/50 border border-transparent'
                  )}
                >
                  <span className="capitalize">{agent}</span>
                  {dockerSandboxAgent === agent && (
                    <Check className="h-4 w-4 text-primary" />
                  )}
                </button>
              )
            )}
          </div>
        </div>

        {/* Mount .git read-only toggle */}
        <div className="flex items-center justify-between px-3 py-2.5 rounded-md border border-transparent hover:bg-accent/50">
          <div>
            <span className="text-sm">Mount project .git read-only</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              The project&apos;s .git directory is mounted as read-only inside the sandbox
            </p>
          </div>
          <button
            onClick={() =>
              updateSetting('dockerSandboxMountGitReadOnly', !dockerSandboxMountGitReadOnly)
            }
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              dockerSandboxMountGitReadOnly ? 'bg-primary' : 'bg-muted'
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg ring-0 transition-transform',
                dockerSandboxMountGitReadOnly ? 'translate-x-4' : 'translate-x-0'
              )}
            />
          </button>
        </div>

        {/* Setup Token Status */}
        <div className="flex items-center justify-between px-3 py-2.5 rounded-md border border-transparent hover:bg-accent/50 mt-2">
          <div>
            <span className="text-sm">Setup Token</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Required for authenticating Claude Code inside the sandbox
            </p>
          </div>
          <div className="flex items-center gap-2">
            {tokenStatus === null ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : tokenStatus ? (
              <span className="text-xs text-green-500">Configured</span>
            ) : (
              <span className="text-xs text-muted-foreground">Not configured</span>
            )}
            <button
              onClick={handleRegenerateToken}
              disabled={isRegenerating}
              className={cn(
                'text-xs px-2 py-1 rounded-md transition-colors',
                'hover:bg-accent border border-transparent hover:border-border',
                isRegenerating && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isRegenerating ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Generating...
                </span>
              ) : tokenStatus ? (
                'Regenerate'
              ) : (
                'Generate'
              )}
            </button>
          </div>
        </div>

        {/* Help text */}
        <div className="flex items-start gap-2 mt-3 p-2.5 rounded-md bg-muted/50 border border-border text-xs">
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-muted-foreground">
            Docker Sandbox is enabled per-worktree. Right-click a worktree and select
            &quot;Enable Sandbox&quot; to activate. The agent runs inside an isolated microVM
            where it can&apos;t access the host filesystem beyond the mounted directories.
          </p>
        </div>
      </div>
    </div>
  )
}
