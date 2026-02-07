import { useState, useEffect } from 'react'
import { useSettingsStore, type TerminalOption } from '@/stores/useSettingsStore'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Check, Loader2 } from 'lucide-react'

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

export function SettingsTerminal(): React.JSX.Element {
  const { defaultTerminal, customTerminalCommand, updateSetting } = useSettingsStore()
  const [detectedTerminals, setDetectedTerminals] = useState<DetectedTerminal[]>([])
  const [isDetecting, setIsDetecting] = useState(true)

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
    return () => { cancelled = true }
  }, [])

  const isAvailable = (id: string): boolean => {
    if (id === 'custom') return true
    const terminal = detectedTerminals.find((t) => t.id === id)
    return terminal?.available ?? false
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Terminal</h3>
        <p className="text-sm text-muted-foreground">
          Choose which terminal to use for &quot;Open in Terminal&quot; actions
        </p>
      </div>

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
                {defaultTerminal === opt.id && (
                  <Check className="h-4 w-4 text-primary" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Custom command input */}
      {defaultTerminal === 'custom' && (
        <div className="space-y-2">
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
  )
}
