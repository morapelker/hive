import { useState } from 'react'

type TabId = 'setup' | 'run' | 'terminal'

const tabs: { id: TabId; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'run', label: 'Run' },
  { id: 'terminal', label: 'Terminal' }
]

export function BottomPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('setup')

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
      </div>
      <div className="flex-1 min-h-0 overflow-auto" data-testid="bottom-panel-content">
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          TODO: {tabs.find((t) => t.id === activeTab)?.label}
        </div>
      </div>
    </div>
  )
}
