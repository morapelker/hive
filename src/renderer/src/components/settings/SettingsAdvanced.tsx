import { useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Trash2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'

const POSIX_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateKey(key: string, allKeys: string[], currentIndex: number): string | null {
  if (!key) return null // Allow empty while editing
  if (!POSIX_KEY_REGEX.test(key))
    return 'Key must start with a letter or underscore and contain only letters, digits, and underscores'
  const isDuplicate = allKeys.some((k, i) => i !== currentIndex && k === key)
  if (isDuplicate) return 'Duplicate key'
  return null
}

export function SettingsAdvanced(): React.JSX.Element {
  // Local state for tracking validation errors per row
  const [errors, setErrors] = useState<Record<number, string | null>>({})

  // Store access
  const { environmentVariables: rawEnvVars, perfDiagnosticsEnabled, codexJsonlLoggingEnabled, codexJsonlResetPerSession, updateSetting } = useSettingsStore()
  const envVars = rawEnvVars ?? []

  const handlePerfDiagnosticsToggle = (): void => {
    const newValue = !perfDiagnosticsEnabled
    updateSetting('perfDiagnosticsEnabled', newValue)
    window.perfDiagnosticsOps.enable(newValue)
    toast.success(newValue ? 'Performance diagnostics enabled' : 'Performance diagnostics disabled')
  }

  const handleCodexJsonlLoggingToggle = (): void => {
    const newValue = !codexJsonlLoggingEnabled
    updateSetting('codexJsonlLoggingEnabled', newValue)
    window.codexDebugLoggerOps.configure(newValue, codexJsonlResetPerSession)
    toast.success(newValue ? 'Codex JSONL logging enabled' : 'Codex JSONL logging disabled')
  }

  const handleCodexJsonlResetToggle = (): void => {
    const newValue = !codexJsonlResetPerSession
    updateSetting('codexJsonlResetPerSession', newValue)
    window.codexDebugLoggerOps.configure(codexJsonlLoggingEnabled, newValue)
    toast.success(newValue ? 'Log will reset each Codex session' : 'Log will append across sessions')
  }

  const handleAdd = () => {
    updateSetting('environmentVariables', [...envVars, { key: '', value: '' }])
    toast.success('Variable added')
  }

  const handleRemove = (index: number) => {
    const updated = envVars.filter((_, i) => i !== index)
    updateSetting('environmentVariables', updated)
    // Re-index errors: shift entries above the deleted index down by 1
    const newErrors: Record<number, string | null> = {}
    for (const [k, v] of Object.entries(errors)) {
      const i = Number(k)
      if (i < index) newErrors[i] = v
      else if (i > index) newErrors[i - 1] = v
    }
    setErrors(newErrors)
    toast.success('Variable removed')
  }

  const handleChange = (index: number, field: 'key' | 'value', val: string) => {
    const updated = envVars.map((entry, i) =>
      i === index ? { ...entry, [field]: val } : entry
    )

    // Validate key
    if (field === 'key') {
      const error = validateKey(
        val,
        updated.map((e) => e.key),
        index
      )
      setErrors((prev) => ({ ...prev, [index]: error }))
    }

    updateSetting('environmentVariables', updated)
  }

  return (
    <div className="space-y-6" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div>
        <h3 className="text-base font-medium mb-1">Advanced</h3>
        <p className="text-sm text-muted-foreground">Advanced configuration options</p>
      </div>

      {/* Performance Diagnostics toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Performance Diagnostics</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Log CPU, memory, process, and handle metrics every 30s to ~/.hive/logs/perf-diagnostics.jsonl
          </p>
        </div>
        <button
          role="switch"
          aria-checked={perfDiagnosticsEnabled}
          onClick={handlePerfDiagnosticsToggle}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            perfDiagnosticsEnabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              perfDiagnosticsEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Codex JSONL Logging toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Codex JSONL Logging</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Log all Codex JSON-RPC messages to ~/.hive/logs/codex.jsonl
          </p>
        </div>
        <button
          role="switch"
          aria-checked={codexJsonlLoggingEnabled}
          onClick={handleCodexJsonlLoggingToggle}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            codexJsonlLoggingEnabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              codexJsonlLoggingEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Reset log each session sub-toggle */}
      <div className={cn('flex items-center justify-between pl-4', !codexJsonlLoggingEnabled && 'opacity-50 pointer-events-none')}>
        <div>
          <label className="text-sm font-medium">Reset log each session</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Truncate the log file when a new Codex session starts. When off, logs append across sessions.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={codexJsonlResetPerSession}
          onClick={handleCodexJsonlResetToggle}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            codexJsonlResetPerSession ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              codexJsonlResetPerSession ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Environment Variables section */}
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Environment Variables</label>
          <p className="text-xs text-muted-foreground">
            Define custom environment variables that will be injected into all new agent sessions.
          </p>
        </div>

        {/* Empty state OR variable list */}
        {envVars.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground mb-3">
              No environment variables configured. Add variables to forward them to your agent
              sessions.
            </p>
            <Button size="sm" onClick={handleAdd} data-testid="add-env-var-empty">
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Variable
            </Button>
          </div>
        ) : (
          <>
            {/* Table header row */}
            <div className="flex items-center gap-2 px-1">
              <span
                className="text-xs font-medium text-muted-foreground"
                style={{ flex: '1 1 0', minWidth: 0 }}
              >
                KEY
              </span>
              <span
                className="text-xs font-medium text-muted-foreground"
                style={{ flex: '1 1 0', minWidth: 0 }}
              >
                VALUE
              </span>
              <span className="w-8 shrink-0" /> {/* spacer for delete button */}
            </div>

            {/* Variable rows */}
            <div className="space-y-2 max-h-64 overflow-y-auto" style={{ overflowX: 'hidden' }}>
              {envVars.map((entry, index) => {
                const error = errors[index]
                return (
                  <div key={index}>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={entry.key}
                        onChange={(e) => handleChange(index, 'key', e.target.value)}
                        placeholder="VARIABLE_NAME"
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-md border bg-background font-mono',
                          error ? 'border-destructive' : 'border-border'
                        )}
                        style={{ flex: '1 1 0', minWidth: 0 }}
                        data-testid={`env-var-key-${index}`}
                      />
                      <input
                        type="text"
                        value={entry.value}
                        onChange={(e) => handleChange(index, 'value', e.target.value)}
                        placeholder="value"
                        className="px-3 py-1.5 text-sm rounded-md border border-border bg-background"
                        style={{ flex: '1 1 0', minWidth: 0 }}
                        data-testid={`env-var-value-${index}`}
                      />
                      <button
                        onClick={() => handleRemove(index)}
                        className="shrink-0 text-destructive hover:text-destructive/80 transition-colors p-1"
                        title="Remove variable"
                        data-testid={`remove-env-var-${index}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {error && <p className="text-xs text-destructive mt-1 ml-1">{error}</p>}
                  </div>
                )
              })}
            </div>

            {/* Add button */}
            <Button size="sm" variant="outline" onClick={handleAdd} data-testid="add-env-var">
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Variable
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
