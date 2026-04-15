import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTerminalTabStore } from '@/stores/useTerminalTabStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useShallow } from 'zustand/react/shallow'
import { TerminalTabEntry } from './TerminalTabEntry'
import { TerminalCloseConfirmDialog } from './TerminalCloseConfirmDialog'

interface TerminalTabSidebarProps {
  worktreeId: string
}

export function TerminalTabSidebar({ worktreeId }: TerminalTabSidebarProps): React.JSX.Element {
  const { tabs, activeTabId } = useTerminalTabStore(
    useShallow((s) => ({
      tabs: s.tabsByWorktree.get(worktreeId) ?? [],
      activeTabId: s.activeTabByWorktree.get(worktreeId)
    }))
  )

  const { createTab, setActiveTab, closeTab, renameTab, closeOtherTabs } = useTerminalTabStore(
    useShallow((s) => ({
      createTab: s.createTab,
      setActiveTab: s.setActiveTab,
      closeTab: s.closeTab,
      renameTab: s.renameTab,
      closeOtherTabs: s.closeOtherTabs
    }))
  )

  const destroyTerminal = useTerminalStore((s) => s.destroyTerminal)

  const [closeConfirmTab, setCloseConfirmTab] = useState<{ id: string; name: string } | null>(null)

  const handleCreateTab = useCallback(() => {
    createTab(worktreeId)
  }, [createTab, worktreeId])

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return

      if (tab.status === 'running') {
        setCloseConfirmTab({ id: tab.id, name: tab.name })
      } else {
        closeTab(worktreeId, tabId)
        destroyTerminal(tabId)
      }
    },
    [tabs, worktreeId, closeTab, destroyTerminal]
  )

  const confirmCloseTab = useCallback(() => {
    if (!closeConfirmTab) return
    closeTab(worktreeId, closeConfirmTab.id)
    destroyTerminal(closeConfirmTab.id)
    setCloseConfirmTab(null)
  }, [closeConfirmTab, worktreeId, closeTab, destroyTerminal])

  const handleCloseOtherTabs = useCallback(
    (keepTabId: string) => {
      const tabsToClose = tabs.filter((t) => t.id !== keepTabId)
      for (const tab of tabsToClose) {
        destroyTerminal(tab.id)
      }
      closeOtherTabs(worktreeId, keepTabId)
    },
    [tabs, worktreeId, destroyTerminal, closeOtherTabs]
  )

  // Listen for close-terminal-tab events dispatched by Cmd+W keyboard shortcut
  useEffect(() => {
    const handler = (e: CustomEvent): void => {
      const { tabId, tabName } = e.detail
      setCloseConfirmTab({ id: tabId, name: tabName })
    }
    window.addEventListener('hive:close-terminal-tab', handler as EventListener)
    return () => window.removeEventListener('hive:close-terminal-tab', handler as EventListener)
  }, [])

  return (
    <div className="w-[140px] border-l border-border flex flex-col h-full bg-background/50">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0">
        <span className="text-xs text-muted-foreground font-medium select-none">Terminals</span>
        <button
          onClick={handleCreateTab}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
          title="New Terminal"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Scrollable tab list */}
      <div className="flex-1 overflow-y-auto py-0.5">
        {tabs.map((tab) => (
          <TerminalTabEntry
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onSelect={() => setActiveTab(worktreeId, tab.id)}
            onClose={() => handleCloseTab(tab.id)}
            onRename={(name) => renameTab(worktreeId, tab.id, name)}
            onCloseOthers={() => handleCloseOtherTabs(tab.id)}
          />
        ))}
      </div>
      <TerminalCloseConfirmDialog
        open={closeConfirmTab !== null}
        onOpenChange={(open) => {
          if (!open) setCloseConfirmTab(null)
        }}
        terminalName={closeConfirmTab?.name ?? ''}
        onConfirm={confirmCloseTab}
      />
    </div>
  )
}
