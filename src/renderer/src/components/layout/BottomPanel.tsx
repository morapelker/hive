import { useMemo, useState } from 'react'
import { Globe } from 'lucide-react'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import type { BottomPanelTab } from '@/stores/useLayoutStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { extractDevServerUrl } from '@/lib/format-utils'
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'
import { SetupTab } from './SetupTab'
import { RunTab } from './RunTab'
import { toast } from 'sonner'

const tabs: { id: BottomPanelTab; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'run', label: 'Run' },
  { id: 'terminal', label: 'Terminal' }
]

export function BottomPanel(): React.JSX.Element {
  const activeTab = useLayoutStore((s) => s.bottomPanelTab)
  const setActiveTab = useLayoutStore((s) => s.setBottomPanelTab)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)

  // Open in Chrome state
  const scriptState = useScriptStore((s) =>
    selectedWorktreeId ? (s.scriptStates[selectedWorktreeId] ?? null) : null
  )
  const runOutputVersion = useScriptStore((s) =>
    selectedWorktreeId ? (s.scriptStates[selectedWorktreeId]?.runOutputVersion ?? 0) : 0
  )
  const customChromeCommand = useSettingsStore((s) => s.customChromeCommand)

  const detectedUrl = useMemo(() => {
    if (!selectedWorktreeId || !scriptState?.runRunning) return null
    const runOutput = getOrCreateBuffer(selectedWorktreeId).toArray()
    if (!runOutput.length) return null
    return extractDevServerUrl(runOutput)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorktreeId, scriptState?.runRunning, runOutputVersion])

  const [chromeConfigOpen, setChromeConfigOpen] = useState(false)
  const [chromeCommandInput, setChromeCommandInput] = useState(customChromeCommand)

  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="bottom-panel">
      <div className="flex border-b border-border" data-testid="bottom-panel-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`text-xs px-3 py-1.5 transition-colors relative ${
              activeTab === tab.id
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid={`bottom-panel-tab-${tab.id}`}
            data-active={activeTab === tab.id}
          >
            {tab.label}
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        ))}

        {/* Spacer + Open in Chrome button */}
        {detectedUrl && (
          <div className="relative ml-auto shrink-0">
            <button
              onClick={() => {
                window.systemOps.openInChrome(detectedUrl, customChromeCommand || undefined)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setChromeCommandInput(customChromeCommand)
                setChromeConfigOpen(true)
              }}
              className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title={`Open ${detectedUrl} in browser (right-click to configure)`}
              data-testid="open-in-chrome"
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="text-[11px]">{detectedUrl}</span>
            </button>
            {chromeConfigOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md p-3 w-80">
                <label className="text-xs font-medium block mb-1">Custom Chrome Command</label>
                <p className="text-[10px] text-muted-foreground mb-2">
                  Use {'{url}'} as placeholder. Leave empty for default browser.
                </p>
                <input
                  value={chromeCommandInput}
                  onChange={(e) => setChromeCommandInput(e.target.value)}
                  placeholder='open -a "Google Chrome" {url}'
                  className="w-full text-xs bg-background border rounded px-2 py-1 mb-2"
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => setChromeConfigOpen(false)}
                    className="text-xs px-2 py-1 rounded hover:bg-accent"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      useSettingsStore
                        .getState()
                        .updateSetting('customChromeCommand', chromeCommandInput)
                      setChromeConfigOpen(false)
                      toast.success('Chrome command saved')
                    }}
                    className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden" data-testid="bottom-panel-content">
        {activeTab === 'setup' && <SetupTab worktreeId={selectedWorktreeId} />}
        {activeTab === 'run' && <RunTab worktreeId={selectedWorktreeId} />}
        {activeTab === 'terminal' && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            TODO: Terminal
          </div>
        )}
      </div>
    </div>
  )
}
