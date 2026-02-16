import { useEffect } from 'react'
import { Settings, Palette, Monitor, Code, Terminal, Keyboard, Download } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { SettingsAppearance } from './SettingsAppearance'
import { SettingsGeneral } from './SettingsGeneral'
import { SettingsEditor } from './SettingsEditor'
import { SettingsTerminal } from './SettingsTerminal'
import { SettingsShortcuts } from './SettingsShortcuts'
import { SettingsUpdates } from './SettingsUpdates'
import { cn } from '@/lib/utils'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'general', label: 'General', icon: Monitor },
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'updates', label: 'Updates', icon: Download }
] as const

export function SettingsModal(): React.JSX.Element {
  const { isOpen, activeSection, closeSettings, openSettings, setActiveSection } =
    useSettingsStore()

  // Listen for the custom event dispatched by keyboard shortcut handler
  useEffect(() => {
    const handleOpenSettings = (): void => {
      openSettings()
    }
    window.addEventListener('hive:open-settings', handleOpenSettings)
    return () => window.removeEventListener('hive:open-settings', handleOpenSettings)
  }, [openSettings])

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings()
      }}
    >
      <DialogContent
        className="max-w-3xl h-[70vh] p-0 gap-0 overflow-hidden"
        data-testid="settings-modal"
      >
        <div className="flex h-full">
          {/* Left navigation */}
          <nav className="w-48 border-r bg-muted/30 p-3 flex flex-col gap-1 shrink-0">
            <div className="flex items-center gap-2 px-2 py-1.5 mb-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              <DialogTitle className="text-sm font-semibold">Settings</DialogTitle>
            </div>
            {SECTIONS.map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left',
                    activeSection === section.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  data-testid={`settings-nav-${section.id}`}
                >
                  <Icon className="h-4 w-4" />
                  {section.label}
                </button>
              )
            })}
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeSection === 'appearance' && <SettingsAppearance />}
            {activeSection === 'general' && <SettingsGeneral />}
            {activeSection === 'editor' && <SettingsEditor />}
            {activeSection === 'terminal' && <SettingsTerminal />}
            {activeSection === 'shortcuts' && <SettingsShortcuts />}
            {activeSection === 'updates' && <SettingsUpdates />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
