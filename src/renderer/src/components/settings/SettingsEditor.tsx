import { useState, useEffect } from 'react'
import { useSettingsStore, type EditorOption } from '@/stores/useSettingsStore'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Check, Loader2 } from 'lucide-react'

interface DetectedEditor {
  id: string
  name: string
  command: string
  available: boolean
}

const EDITOR_OPTIONS: { id: EditorOption; label: string }[] = [
  { id: 'vscode', label: 'Visual Studio Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'sublime', label: 'Sublime Text' },
  { id: 'webstorm', label: 'WebStorm' },
  { id: 'zed', label: 'Zed' },
  { id: 'custom', label: 'Custom Command' }
]

export function SettingsEditor(): React.JSX.Element {
  const { defaultEditor, customEditorCommand, updateSetting } = useSettingsStore()
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([])
  const [isDetecting, setIsDetecting] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function detect(): Promise<void> {
      try {
        if (window.settingsOps?.detectEditors) {
          const editors = await window.settingsOps.detectEditors()
          if (!cancelled) {
            setDetectedEditors(editors)
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

  const isAvailable = (id: string): boolean => {
    if (id === 'custom') return true
    const editor = detectedEditors.find((e) => e.id === id)
    return editor?.available ?? false
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Editor</h3>
        <p className="text-sm text-muted-foreground">
          Choose which editor to use for &quot;Open in Editor&quot; actions
        </p>
      </div>

      {isDetecting ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Detecting installed editors...
        </div>
      ) : (
        <div className="space-y-1">
          {EDITOR_OPTIONS.map((opt) => {
            const available = isAvailable(opt.id)
            return (
              <button
                key={opt.id}
                onClick={() => updateSetting('defaultEditor', opt.id)}
                disabled={!available && opt.id !== 'custom'}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2.5 rounded-md text-sm transition-colors text-left',
                  defaultEditor === opt.id
                    ? 'bg-primary/10 border border-primary/30'
                    : 'hover:bg-accent/50 border border-transparent',
                  !available && opt.id !== 'custom' && 'opacity-50 cursor-not-allowed'
                )}
                data-testid={`editor-${opt.id}`}
              >
                <div className="flex items-center gap-2">
                  <span>{opt.label}</span>
                  {!available && opt.id !== 'custom' && (
                    <span className="text-xs text-muted-foreground">(not found)</span>
                  )}
                </div>
                {defaultEditor === opt.id && <Check className="h-4 w-4 text-primary" />}
              </button>
            )
          })}
        </div>
      )}

      {/* Custom command input */}
      {defaultEditor === 'custom' && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Custom Editor Command</label>
          <Input
            value={customEditorCommand}
            onChange={(e) => updateSetting('customEditorCommand', e.target.value)}
            placeholder="e.g., /usr/local/bin/code"
            className="font-mono text-sm"
            data-testid="custom-editor-command"
          />
          <p className="text-xs text-muted-foreground">
            The command will be called with the worktree path as an argument.
          </p>
        </div>
      )}
    </div>
  )
}
