import { useEffect, useState } from 'react'
import { Globe, ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isMac, isLinux } from '@/lib/platform'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import type { BottomPanelTab } from '@/stores/useLayoutStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { TerminalPosition } from '@/stores/useSettingsStore'
import { extractDevServerUrl } from '@/lib/format-utils'
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'
import { SetupTab } from './SetupTab'
import { RunTab } from './RunTab'
import { toast } from '@/lib/toast'
import { useGhosttyPromotion } from '@/hooks/useGhosttyPromotion'

const tabs: { id: BottomPanelTab; label: string; keybind: string }[] = [
  { id: 'setup', label: 'Setup', keybind: 'S' },
  { id: 'run', label: 'Run', keybind: 'R' },
  { id: 'terminal', label: 'Terminal', keybind: 'T' }
]

interface BottomPanelProps {
  /** Callback ref to register the terminal portal target container */
  terminalContainerRef: (el: HTMLDivElement | null) => void
  /** Current terminal position setting */
  terminalPosition: TerminalPosition
  /** When true, only the terminal tab is shown (setup/run are worktree-specific) */
  isConnectionMode?: boolean
  /** When true, the panel content is hidden (but kept mounted to preserve PTY state) */
  isCollapsed?: boolean
  /** Called when the user clicks the collapse/expand chevron */
  onToggleCollapse?: () => void
}

export function BottomPanel({
  terminalContainerRef,
  terminalPosition,
  isConnectionMode,
  isCollapsed,
  onToggleCollapse
}: BottomPanelProps): React.JSX.Element {
  const activeTab = useLayoutStore((s) => s.bottomPanelTab)
  const effectiveTab = isConnectionMode ? 'terminal' : activeTab
  const setActiveTab = useLayoutStore((s) => s.setBottomPanelTab)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const visibleTabs = terminalPosition === 'bottom'
    ? tabs.filter((t) => t.id !== 'terminal')
    : isConnectionMode
      ? tabs.filter((t) => t.id === 'terminal')
      : tabs

  // If terminal tab was active but is now hidden (moved to bottom panel), fall back
  const resolvedTab = (terminalPosition === 'bottom' && effectiveTab === 'terminal') ? 'run' : effectiveTab
  useGhosttyPromotion(resolvedTab === 'terminal')

  // Open in Chrome state
  const scriptState = useScriptStore((s) =>
    selectedWorktreeId ? (s.scriptStates[selectedWorktreeId] ?? null) : null
  )
  const runOutputVersion = useScriptStore((s) =>
    selectedWorktreeId ? (s.scriptStates[selectedWorktreeId]?.runOutputVersion ?? 0) : 0
  )
  const customChromeCommand = useSettingsStore((s) => s.customChromeCommand)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  // Per-worktree detected URLs so switching worktrees shows the correct port instantly.
  const [detectedUrls, setDetectedUrls] = useState<Record<string, string>>({})
  const detectedUrl = selectedWorktreeId ? (detectedUrls[selectedWorktreeId] ?? null) : null

  // Scan for dev server URL only while running and not yet found.
  // Once a URL is detected for a worktree, scanning stops (zero cost per subsequent version bump).
  // When runRunning becomes false, the URL for that worktree is cleared so the next run can detect a new one.
  useEffect(() => {
    if (!selectedWorktreeId || !scriptState?.runRunning) {
      if (selectedWorktreeId) {
        setDetectedUrls((prev) => {
          if (!(selectedWorktreeId in prev)) return prev
          const { [selectedWorktreeId]: _, ...rest } = prev
          return rest
        })
      }
      return
    }
    // Already found for this worktree — stop scanning
    if (detectedUrl) return

    const output = getOrCreateBuffer(selectedWorktreeId).toRecentArray(80)
    if (!output.length) return
    const url = extractDevServerUrl(output)
    if (url) setDetectedUrls((prev) => ({ ...prev, [selectedWorktreeId]: url }))
  }, [selectedWorktreeId, scriptState?.runRunning, runOutputVersion, detectedUrl])

  const [chromeConfigOpen, setChromeConfigOpen] = useState(false)
  const [chromeCommandInput, setChromeCommandInput] = useState(customChromeCommand)

  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="bottom-panel">
      <div className="flex border-b border-border" data-testid="bottom-panel-tabs">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`text-xs px-3 py-1.5 transition-colors relative ${
              resolvedTab === tab.id
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid={`bottom-panel-tab-${tab.id}`}
            data-active={resolvedTab === tab.id}
          >
            {vimModeEnabled ? (
              <>
                <span className="text-primary">{tab.keybind}</span>
                {tab.label.slice(1)}
              </>
            ) : (
              tab.label
            )}
            {resolvedTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
            )}
          </button>
        ))}

        {/* Flex spacer pushes Chrome URL button and chevron to the right */}
        <div className="flex-1" />

        {/* Open in Chrome button */}
        {detectedUrl && (
          <div className="relative shrink-0">
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
                  placeholder={isMac() ? 'open -a "Google Chrome" {url}' : isLinux() ? 'xdg-open {url}' : 'start chrome {url}'}
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

        {/* Collapse/expand chevron */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="p-1 text-muted-foreground hover:text-foreground rounded"
            aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
          >
            {isCollapsed ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      {/* Use CSS hidden (not conditional rendering) to keep TerminalManager mounted and preserve PTY state */}
      <div className={cn("flex-1 min-h-0 overflow-hidden", isCollapsed && "hidden")} data-testid="bottom-panel-content">
        {resolvedTab === 'setup' && <SetupTab worktreeId={selectedWorktreeId} />}
        {resolvedTab === 'run' && <RunTab worktreeId={selectedWorktreeId} />}
        {/* Terminal portal target — always mounted when in sidebar mode to preserve PTY state */}
        <div
          ref={terminalContainerRef}
          className={resolvedTab === 'terminal' ? 'h-full w-full' : 'hidden'}
        />
      </div>
    </div>
  )
}
