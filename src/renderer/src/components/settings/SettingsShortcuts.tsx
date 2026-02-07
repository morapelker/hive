import { useState, useCallback } from 'react'
import { useShortcutStore } from '@/stores/useShortcutStore'
import {
  DEFAULT_SHORTCUTS,
  shortcutCategoryLabels,
  shortcutCategoryOrder,
  formatBinding,
  type KeyBinding,
  type ModifierKey,
  type ShortcutCategory,
  getShortcutsByCategory
} from '@/lib/keyboard-shortcuts'
import { Button } from '@/components/ui/button'
import { RotateCcw, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

export function SettingsShortcuts(): React.JSX.Element {
  const { customBindings, setCustomBinding, removeCustomBinding, resetToDefaults, getDisplayString } = useShortcutStore()
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<string[]>([])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recordingId) return
      e.preventDefault()
      e.stopPropagation()

      // Ignore modifier-only presses
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecordingId(null)
        setConflicts([])
        return
      }

      const modifiers: ModifierKey[] = []
      if (e.metaKey) modifiers.push('meta')
      if (e.ctrlKey) modifiers.push('ctrl')
      if (e.altKey) modifiers.push('alt')
      if (e.shiftKey) modifiers.push('shift')

      // Require at least one modifier for safety
      if (modifiers.length === 0) {
        toast.error('Shortcuts must include at least one modifier key (Cmd/Ctrl/Alt/Shift)')
        return
      }

      const binding: KeyBinding = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        modifiers
      }

      const result = setCustomBinding(recordingId, binding)
      if (result.success) {
        setRecordingId(null)
        setConflicts([])
        toast.success(`Shortcut updated to ${formatBinding(binding)}`)
      } else {
        setConflicts(result.conflicts || [])
      }
    },
    [recordingId, setCustomBinding]
  )

  const handleResetShortcut = (shortcutId: string): void => {
    removeCustomBinding(shortcutId)
    toast.success('Shortcut reset to default')
  }

  const handleResetAll = (): void => {
    resetToDefaults()
    toast.success('All shortcuts reset to defaults')
  }

  return (
    <div className="space-y-6" onKeyDown={handleKeyDown}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium mb-1">Keyboard Shortcuts</h3>
          <p className="text-sm text-muted-foreground">Customize keyboard shortcuts</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetAll}
          data-testid="reset-all-shortcuts"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          Reset All
        </Button>
      </div>

      {conflicts.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-destructive">Shortcut conflict</p>
            <p className="text-muted-foreground">
              This binding is already used by: {conflicts.map((id) => {
                const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === id)
                return shortcut?.label || id
              }).join(', ')}
            </p>
          </div>
        </div>
      )}

      {shortcutCategoryOrder.map((category) => (
        <ShortcutCategorySection
          key={category}
          category={category}
          recordingId={recordingId}
          customBindings={customBindings}
          getDisplayString={getDisplayString}
          onStartRecording={(id) => { setRecordingId(id); setConflicts([]) }}
          onResetShortcut={handleResetShortcut}
        />
      ))}
    </div>
  )
}

interface ShortcutCategorySectionProps {
  category: ShortcutCategory
  recordingId: string | null
  customBindings: Record<string, KeyBinding>
  getDisplayString: (id: string) => string
  onStartRecording: (id: string) => void
  onResetShortcut: (id: string) => void
}

function ShortcutCategorySection({
  category,
  recordingId,
  customBindings,
  getDisplayString,
  onStartRecording,
  onResetShortcut
}: ShortcutCategorySectionProps): React.JSX.Element {
  const shortcuts = getShortcutsByCategory(category)

  return (
    <div>
      <h4 className="text-sm font-medium text-muted-foreground mb-2">
        {shortcutCategoryLabels[category]}
      </h4>
      <div className="space-y-1">
        {shortcuts.map((shortcut) => {
          const isRecording = recordingId === shortcut.id
          const isCustomized = shortcut.id in customBindings
          const displayString = getDisplayString(shortcut.id)

          return (
            <div
              key={shortcut.id}
              className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent/30"
              data-testid={`shortcut-${shortcut.id}`}
            >
              <div className="flex-1">
                <span className="text-sm">{shortcut.label}</span>
                {shortcut.description && (
                  <span className="text-xs text-muted-foreground ml-2">{shortcut.description}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isCustomized && (
                  <button
                    onClick={() => onResetShortcut(shortcut.id)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title="Reset to default"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => onStartRecording(shortcut.id)}
                  className={cn(
                    'min-w-[100px] px-2.5 py-1 rounded border text-xs font-mono text-right transition-colors',
                    isRecording
                      ? 'border-primary bg-primary/10 text-primary animate-pulse'
                      : isCustomized
                        ? 'border-primary/50 bg-primary/5 text-foreground hover:border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  )}
                  data-testid={`shortcut-binding-${shortcut.id}`}
                >
                  {isRecording ? 'Press keys...' : displayString}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
