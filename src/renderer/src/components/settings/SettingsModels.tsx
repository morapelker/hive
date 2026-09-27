import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { Info } from 'lucide-react'

export function SettingsModels(): React.JSX.Element {
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'opencode'
  // Show the effective model for the current SDK (what new sessions will actually use)
  const effectiveModel = useSettingsStore((s) =>
    resolveModelForSdk(defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk, s)
  )
  const defaultModels = useSettingsStore((state) => state.defaultModels)
  const prContentModel = useSettingsStore((state) => state.prContentModel)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const setSelectedModel = useSettingsStore((state) => state.setSelectedModel)
  const setSelectedModelForSdk = useSettingsStore((state) => state.setSelectedModelForSdk)
  const setModeDefaultModel = useSettingsStore((state) => state.setModeDefaultModel)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Default Models</h3>
        <p className="text-sm text-muted-foreground">
          Configure which AI models to use for different modes and commands
        </p>
      </div>

      {/* Info box explaining priority */}
      <div className="flex gap-2 p-3 rounded-md bg-muted/30 border border-border">
        <Info className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <strong>Model selection priority:</strong>
          </p>
          <ol className="list-decimal list-inside space-y-0.5 ml-2">
            <li>Worktree's last-used model (if any)</li>
            <li>Mode-specific default (configured below)</li>
            <li>Global default model</li>
            <li>System fallback (Claude Opus 4.5)</li>
          </ol>
          <p>
            Defaults only change here. Sending a ticket or switching a session&apos;s model never
            rewrites them.
          </p>
        </div>
      </div>

      {/* Global default */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Global Default Model</label>
        <p className="text-xs text-muted-foreground">
          Model used for new sessions and tickets when no mode-specific default applies
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={effectiveModel}
            onChange={(model) => {
              // Update both legacy selectedModel and per-SDK entry so
              // resolveModelForSdk returns the new model for new sessions
              const sdk = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
              setSelectedModel(model)
              setSelectedModelForSdk(sdk, model)
            }}
          />
          {effectiveModel && (
            <button
              onClick={() => {
                const sdk = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
                setSelectedModel(null)
                setSelectedModelForSdk(sdk, null)
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="border-t pt-4" />

      <p className="text-xs text-muted-foreground">
        Mode defaults apply only when they belong to the default agent SDK selected on the General
        tab. A mode default picked for another SDK is ignored, so new sessions and tickets never
        switch SDK on their own.
      </p>

      {/* Build mode */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Build Mode Default</label>
        <p className="text-xs text-muted-foreground">
          Model used for new build mode sessions (normal coding)
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={defaultModels?.build || null}
            onChange={(model) => setModeDefaultModel('build', model)}
            allowAgentSdkSelection
          />
          {defaultModels?.build && (
            <button
              onClick={() => setModeDefaultModel('build', null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Use global
            </button>
          )}
        </div>
      </div>

      {/* Plan mode */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Plan Mode Default</label>
        <p className="text-xs text-muted-foreground">
          Model used for new plan mode sessions (design and planning)
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={defaultModels?.plan || null}
            onChange={(model) => setModeDefaultModel('plan', model)}
            allowAgentSdkSelection
          />
          {defaultModels?.plan && (
            <button
              onClick={() => setModeDefaultModel('plan', null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Use global
            </button>
          )}
        </div>
      </div>

      {/* Ask command */}
      <div className="space-y-2">
        <label className="text-sm font-medium">/ask Command Default</label>
        <p className="text-xs text-muted-foreground">
          Model used when you run the /ask command for quick questions
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={defaultModels?.ask || null}
            onChange={(model) => setModeDefaultModel('ask', model)}
            allowAgentSdkSelection
          />
          {defaultModels?.ask && (
            <button
              onClick={() => setModeDefaultModel('ask', null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Use global
            </button>
          )}
        </div>
      </div>

      {/* Review */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Review Default</label>
        <p className="text-xs text-muted-foreground">
          Model used when starting a Code Review session
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={defaultModels?.review || null}
            onChange={(model) => setModeDefaultModel('review', model)}
            allowAgentSdkSelection
          />
          {defaultModels?.review && (
            <button
              onClick={() => setModeDefaultModel('review', null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Use global
            </button>
          )}
        </div>
      </div>

      <div className="border-t pt-4" />

      {/* PR content generation */}
      <div className="space-y-2">
        <label className="text-sm font-medium">PR Content Generation</label>
        <p className="text-xs text-muted-foreground">
          Model and effort used to generate pull request titles and descriptions
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={prContentModel || null}
            onChange={(model) => updateSetting('prContentModel', model)}
            allowAgentSdkSelection
          />
          {prContentModel && (
            <button
              onClick={() => updateSetting('prContentModel', null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Use default
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
