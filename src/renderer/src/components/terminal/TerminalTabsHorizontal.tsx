import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TAB_ACTIVE_SURFACE_CLASS, TAB_UNDERLINE_CLASS } from '@/lib/tab-styles'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useTerminalTabActions } from '@/hooks/useTerminalTabActions'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { TerminalCloseConfirmDialog } from './TerminalCloseConfirmDialog'

interface TerminalTabsHorizontalProps {
  worktreeId: string
  isTerminalActive: boolean
}

export function TerminalTabsHorizontal({
  worktreeId,
  isTerminalActive
}: TerminalTabsHorizontalProps): React.JSX.Element {
  const {
    tabs,
    activeTabId,
    handleCreateTab,
    handleCloseTab,
    handleCloseOtherTabs,
    handleSelectTab,
    handleRenameTab,
    closeConfirmTab,
    confirmCloseTab,
    cancelCloseConfirm
  } = useTerminalTabActions(worktreeId)

  const setBottomPanelTab = useLayoutStore((s) => s.setBottomPanelTab)

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingTabId) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [renamingTabId])

  const startRename = useCallback(
    (tabId: string, currentName: string) => {
      setEditValue(currentName)
      setRenamingTabId(tabId)
    },
    []
  )

  const commitRename = useCallback(
    (tabId: string, originalName: string) => {
      const trimmed = editValue.trim()
      if (trimmed && trimmed !== originalName) {
        handleRenameTab(tabId, trimmed)
      }
      setRenamingTabId(null)
    },
    [editValue, handleRenameTab]
  )

  const cancelRename = useCallback(() => {
    setRenamingTabId(null)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, tabId: string, originalName: string) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        commitRename(tabId, originalName)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelRename()
      }
    },
    [commitRename, cancelRename]
  )

  const handleTabClick = useCallback(
    (tabId: string) => {
      setBottomPanelTab('terminal')
      handleSelectTab(tabId)
    },
    [setBottomPanelTab, handleSelectTab]
  )

  const handlePlusClick = useCallback(() => {
    setBottomPanelTab('terminal')
    handleCreateTab()
  }, [setBottomPanelTab, handleCreateTab])

  return (
    <>
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <button
              onClick={() => handleTabClick(tab.id)}
              className={cn(
                'group h-full text-[11px] px-3 rounded-none transition-colors relative flex items-center gap-1.5',
                isTerminalActive && tab.id === activeTabId
                  ? cn('text-foreground', TAB_ACTIVE_SURFACE_CLASS)
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {/* Status dot */}
              <span
                className={cn('h-1.5 w-1.5 rounded-full shrink-0', {
                  'bg-yellow-500 animate-pulse': tab.status === 'creating',
                  'bg-green-500': tab.status === 'running',
                  'bg-red-500': tab.status === 'exited' && tab.exitCode !== 0,
                  'bg-muted-foreground': tab.status === 'exited' && tab.exitCode === 0
                })}
              />

              {/* Name or inline edit */}
              {renamingTabId === tab.id ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, tab.id, tab.name)}
                  onBlur={() => commitRename(tab.id, tab.name)}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 w-16 h-4 px-0.5 text-xs bg-background border border-border rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring"
                />
              ) : (
                <span
                  className="max-w-[80px] truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    startRename(tab.id, tab.name)
                  }}
                >
                  {tab.name}
                </span>
              )}

              {/* Hover-reveal close button */}
              {renamingTabId !== tab.id && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground rounded transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCloseTab(tab.id)
                  }}
                  title="Close"
                >
                  <X className="h-3 w-3" />
                </span>
              )}

              {/* Active underline */}
              {isTerminalActive && tab.id === activeTabId && (
                <span className={TAB_UNDERLINE_CLASS} />
              )}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => startRename(tab.id, tab.name)}>
              Rename
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handleCloseTab(tab.id)}>Close</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => handleCloseOtherTabs(tab.id)}>
              Close Others
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}

      {/* Add tab button */}
      <button
        onClick={handlePlusClick}
        className="h-full px-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        title="New Terminal"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {/* Close confirmation dialog */}
      <TerminalCloseConfirmDialog
        open={closeConfirmTab !== null}
        onOpenChange={(open) => {
          if (!open) cancelCloseConfirm()
        }}
        terminalName={closeConfirmTab?.name ?? ''}
        description={
          closeConfirmTab?.mode === 'close-others'
            ? `${closeConfirmTab.name} ${closeConfirmTab.name.startsWith('1 ') ? 'has' : 'have'} a running process. Close anyway?`
            : undefined
        }
        onConfirm={confirmCloseTab}
      />
    </>
  )
}
