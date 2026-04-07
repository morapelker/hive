import { useEffect } from 'react'
import {
  Settings,
  Palette,
  Monitor,
  Code,
  Terminal,
  Keyboard,
  Download,
  Shield,
  Eye,
  Wrench,
  Sparkles,
  LogOut,
  Plug
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useGhosttySuppression } from '@/hooks'
import { useIsWebMode } from '@/hooks/useIsWebMode'
import { clearWebAuth } from '@/transport/graphql/auth'
import { SettingsAppearance } from './SettingsAppearance'
import { SettingsGeneral } from './SettingsGeneral'
import { SettingsModels } from './SettingsModels'
import { SettingsEditor } from './SettingsEditor'
import { SettingsTerminal } from './SettingsTerminal'
import { SettingsShortcuts } from './SettingsShortcuts'
import { SettingsUpdates } from './SettingsUpdates'
import { SettingsSecurity } from './SettingsSecurity'
import { SettingsPrivacy } from './SettingsPrivacy'
import { SettingsIntegrations } from './SettingsIntegrations'
import { SettingsAdvanced } from './SettingsAdvanced'
import { cn } from '@/lib/utils'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, electronOnly: false },
  { id: 'general', label: 'General', icon: Monitor, electronOnly: false },
  { id: 'models', label: 'Models', icon: Sparkles, electronOnly: false },
  { id: 'editor', label: 'Editor', icon: Code, electronOnly: false },
  { id: 'terminal', label: 'Terminal', icon: Terminal, electronOnly: true },
  { id: 'integrations', label: 'Integrations', icon: Plug, electronOnly: false },
  { id: 'security', label: 'Security', icon: Shield, electronOnly: false },
  { id: 'privacy', label: 'Privacy', icon: Eye, electronOnly: false },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, electronOnly: false },
  { id: 'advanced', label: 'Advanced', icon: Wrench, electronOnly: false },
  { id: 'updates', label: 'Updates', icon: Download, electronOnly: true }
] as const

export function SettingsModal(): React.JSX.Element {
  const isWebMode = useIsWebMode()
  const { isOpen, activeSection, closeSettings, openSettings, setActiveSection } =
    useSettingsStore()
  useGhosttySuppression('settings-modal', isOpen)

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
        <div className="flex h-full min-h-0">
          {/* Left navigation */}
          <nav className="w-48 border-r bg-muted/30 p-3 flex flex-col gap-1 shrink-0">
            <div className="flex items-center gap-2 px-2 py-1.5 mb-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              <DialogTitle className="text-sm font-semibold">Settings</DialogTitle>
            </div>
            {SECTIONS.filter((s) => !s.electronOnly || !isWebMode).map((section) => {
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
            {isWebMode && (
              <div className="mt-auto pt-3 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2 text-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    clearWebAuth()
                    window.location.reload()
                  }}
                  data-testid="settings-disconnect"
                >
                  <LogOut className="h-4 w-4" />
                  Disconnect
                </Button>
              </div>
            )}
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeSection === 'appearance' && <SettingsAppearance />}
            {activeSection === 'general' && <SettingsGeneral />}
            {activeSection === 'models' && <SettingsModels />}
            {activeSection === 'editor' && <SettingsEditor />}
            {activeSection === 'terminal' && <SettingsTerminal />}
            {activeSection === 'integrations' && <SettingsIntegrations />}
            {activeSection === 'security' && <SettingsSecurity />}
            {activeSection === 'privacy' && <SettingsPrivacy />}
            {activeSection === 'shortcuts' && <SettingsShortcuts />}
            {activeSection === 'updates' && <SettingsUpdates />}
            {activeSection === 'advanced' && <SettingsAdvanced />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
