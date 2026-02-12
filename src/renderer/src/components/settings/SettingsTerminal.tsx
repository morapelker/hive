import { useState, useEffect } from 'react'
import {
  useSettingsStore,
  type TerminalOption,
  type EmbeddedTerminalBackend
} from '@/stores/useSettingsStore'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Check, Loader2, Info } from 'lucide-react'

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
  const { defaultTerminal, customTerminalCommand, embeddedTerminalBackend, updateSetting } =
    useSettingsStore()
  const [detectedTerminals, setDetectedTerminals] = useState<DetectedTerminal[]>([])
  const [isDetecting, setIsDetecting] = useState(true)
  const [ghosttyAvailable, setGhosttyAvailable] = useState<boolean | null>(null)
  const [isMac, setIsMac] = useState(false)

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
          <div className="flex items-start gap-2 mt-3 p-2.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs">
            <Info className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />
            <p className="text-muted-foreground">
              Ghostty renders via Metal for native performance. The terminal will restart when
              switching backends. Font, colors, and cursor style are read from your Ghostty config.
            </p>
          </div>
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
    </div>
  )
}
