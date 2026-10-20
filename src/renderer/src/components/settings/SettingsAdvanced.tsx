import { useCallback, useEffect, useState } from 'react'
import { codexDebugLoggerApi } from '@/api/codex-debug-logger-api'
import { perfDiagnosticsApi, type PerfLoggingStatus } from '@/api/perf-diagnostics-api'
import { projectApi } from '@/api/project-api'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { Trash2, Plus, FolderOpen, Camera } from 'lucide-react'
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
  const {
    environmentVariables: rawEnvVars,
    perfDiagnosticsEnabled,
    claudeCliAutoResumeAfterApiError,
    codexJsonlLoggingEnabled,
    codexJsonlResetPerSession,
    updateSetting
  } = useSettingsStore()
  const envVars = rawEnvVars ?? []

  const [perfStatus, setPerfStatus] = useState<PerfLoggingStatus | null>(null)
  const [capturing, setCapturing] = useState(false)

  const refreshPerfStatus = useCallback((): void => {
    perfDiagnosticsApi
      .getStatus()
      .then(setPerfStatus)
      .catch(() => setPerfStatus(null))
  }, [])

  useEffect(() => {
    refreshPerfStatus()
  }, [refreshPerfStatus, perfDiagnosticsEnabled])

  const handlePerfDiagnosticsToggle = (): void => {
    const newValue = !perfDiagnosticsEnabled
    updateSetting('perfDiagnosticsEnabled', newValue)
    perfDiagnosticsApi
      .enable(newValue)
      .then(() => {
        toast.success(newValue ? 'Performance logging enabled' : 'Performance logging disabled')
        refreshPerfStatus()
      })
      .catch((error: unknown) => {
        updateSetting('perfDiagnosticsEnabled', !newValue)
        toast.error(
          `Could not ${newValue ? 'enable' : 'disable'} performance logging: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  }

  const handlePerfCapture = (): void => {
    if (capturing) return
    setCapturing(true)
    perfDiagnosticsApi
      .captureNow('manual')
      .then((result) => {
        toast.success(
          result.files.length > 0
            ? `Captured ${result.files.length} diagnostic file${result.files.length === 1 ? '' : 's'}`
            : 'Capture finished (no files written)'
        )
        refreshPerfStatus()
      })
      .catch((error: unknown) => {
        toast.error(
          `Capture failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => setCapturing(false))
  }

  const handleOpenPerfLogs = (): void => {
    const dir = perfStatus?.logDir
    if (!dir) return
    projectApi.openPath(dir).catch((error: unknown) => {
      toast.error(
        `Could not open logs folder: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  const perfLogBytes = (perfStatus?.files ?? []).reduce((sum, file) => sum + file.bytes, 0)

  const handleCodexJsonlLoggingToggle = (): void => {
    const newValue = !codexJsonlLoggingEnabled
    updateSetting('codexJsonlLoggingEnabled', newValue)
    codexDebugLoggerApi.configure(newValue, codexJsonlResetPerSession)
    toast.success(newValue ? 'Codex JSONL logging enabled' : 'Codex JSONL logging disabled')
  }

  const handleCodexJsonlResetToggle = (): void => {
    const newValue = !codexJsonlResetPerSession
    updateSetting('codexJsonlResetPerSession', newValue)
    codexDebugLoggerApi.configure(codexJsonlLoggingEnabled, newValue)
    toast.success(
      newValue ? 'Log will reset each Codex session' : 'Log will append across sessions'
    )
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
    const updated = envVars.map((entry, i) => (i === index ? { ...entry, [field]: val } : entry))

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

      {/* Performance logging */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Performance logging</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every 30s, record event-loop stalls, slow RPCs and SQLite statements, memory, handles,
            timers, renderer long tasks and store sizes for the app, backend, window and the Claude
            API proxy host to ~/.hive/logs/perf/ — plus every proxied API request (status, time to
            first byte, who gave up), the thread-pool heartbeat and session auto-resumes. Cheap
            enough to leave on. When the app starts lagging or sessions start failing, press
            Capture diagnostics before relaunching.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={perfDiagnosticsEnabled}
          onClick={handlePerfDiagnosticsToggle}
          data-testid="perf-logging-toggle"
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            perfDiagnosticsEnabled ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform',
              perfDiagnosticsEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {perfDiagnosticsEnabled && (
        <div className="flex items-center justify-between gap-3 pl-4">
          <p className="text-xs text-muted-foreground" data-testid="perf-logging-status">
            {perfStatus
              ? `${perfStatus.server.enabled ? 'Recording' : 'Backend not recording'} · ${perfStatus.server.samples} samples · ${perfStatus.server.alerts} alerts · ${(perfStatus.files ?? []).length} files (${(perfLogBytes / (1024 * 1024)).toFixed(1)} MB)`
              : 'Status unavailable'}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={handlePerfCapture}
              disabled={capturing}
              data-testid="perf-logging-capture"
            >
              <Camera className="h-3.5 w-3.5 mr-1" />
              {capturing ? 'Capturing…' : 'Capture diagnostics'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenPerfLogs}
              disabled={!perfStatus?.logDir}
              data-testid="perf-logging-open-folder"
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1" />
              Open logs folder
            </Button>
          </div>
        </div>
      )}

      {/* Auto-resume after API errors */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Resume sessions after API errors</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            When a Claude session's turn dies of a transient API failure (no response, connection
            lost, 5xx, the Mac slept), re-prompt it to continue once the API answers again. Sessions
            you have typed into are left alone.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={claudeCliAutoResumeAfterApiError}
          data-testid="auto-resume-toggle"
          onClick={() =>
            updateSetting('claudeCliAutoResumeAfterApiError', !claudeCliAutoResumeAfterApiError)
          }
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            claudeCliAutoResumeAfterApiError ? 'bg-primary' : 'bg-muted'
          )}
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform',
              claudeCliAutoResumeAfterApiError ? 'translate-x-4' : 'translate-x-0'
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
              'pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform',
              codexJsonlLoggingEnabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      {/* Reset log each session sub-toggle */}
      <div
        className={cn(
          'flex items-center justify-between pl-4',
          !codexJsonlLoggingEnabled && 'opacity-50 pointer-events-none'
        )}
      >
        <div>
          <label className="text-sm font-medium">Reset log each session</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Truncate the log file when a new Codex session starts. When off, logs append across
            sessions.
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
              'pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform',
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
