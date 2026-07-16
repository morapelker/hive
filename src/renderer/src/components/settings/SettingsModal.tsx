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
  Plug,
  Bug,
  Send,
  Zap,
  Database,
  DatabaseBackup,
  Hash,
  RadioTower,
  Building2,
  Users,
  Bot
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { SettingsAppearance } from './SettingsAppearance'
import { SettingsGeneral } from './SettingsGeneral'
import { SettingsAccounts } from './SettingsAccounts'
import { SettingsModels } from './SettingsModels'
import { SettingsEditor } from './SettingsEditor'
import { SettingsTerminal } from './SettingsTerminal'
import { SettingsShortcuts } from './SettingsShortcuts'
import { SettingsUpdates } from './SettingsUpdates'
import { SettingsSecurity } from './SettingsSecurity'
import { SettingsPrivacy } from './SettingsPrivacy'
import { SettingsIntegrations } from './SettingsIntegrations'
import { SettingsTelegram } from './SettingsTelegram'
import { SettingsDiscord } from './SettingsDiscord'
import { SettingsTeleport } from './SettingsTeleport'
import { SettingsHiveEnterprise } from './SettingsHiveEnterprise'
import { SettingsAdvanced } from './SettingsAdvanced'
import { SettingsPet } from './SettingsPet'
import { SettingsCustomCommands } from './SettingsCustomCommands'
import { SettingsCustomProviders } from './SettingsCustomProviders'
import { SettingsStorage } from './SettingsStorage'
import { SettingsBackup } from './SettingsBackup'
import { cn } from '@/lib/utils'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'general', label: 'General', icon: Monitor },
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'custom-commands', label: 'Custom Commands', icon: Zap },
  { id: 'custom-providers', label: 'Custom Providers', icon: Bot },
  { id: 'models', label: 'Models', icon: Sparkles },
  { id: 'pet', label: 'Pet', icon: Bug },
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'telegram', label: 'Telegram', icon: Send },
  { id: 'discord', label: 'Discord', icon: Hash },
  { id: 'teleport', label: 'Teleport', icon: RadioTower },
  { id: 'hive-enterprise', label: 'Hive Enterprise', icon: Building2 },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'privacy', label: 'Privacy', icon: Eye },
  { id: 'storage', label: 'Storage', icon: Database },
  { id: 'backup', label: 'Backup', icon: DatabaseBackup },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'advanced', label: 'Advanced', icon: Wrench },
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
        <div className="flex h-full min-h-0">
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
            {activeSection === 'accounts' && <SettingsAccounts />}
            {activeSection === 'custom-commands' && <SettingsCustomCommands />}
            {activeSection === 'custom-providers' && <SettingsCustomProviders />}
            {activeSection === 'models' && <SettingsModels />}
            {activeSection === 'pet' && <SettingsPet />}
            {activeSection === 'editor' && <SettingsEditor />}
            {activeSection === 'terminal' && <SettingsTerminal />}
            {activeSection === 'integrations' && <SettingsIntegrations />}
            {activeSection === 'telegram' && <SettingsTelegram />}
            {activeSection === 'discord' && <SettingsDiscord />}
            {activeSection === 'teleport' && <SettingsTeleport />}
            {activeSection === 'hive-enterprise' && <SettingsHiveEnterprise />}
            {activeSection === 'security' && <SettingsSecurity />}
            {activeSection === 'privacy' && <SettingsPrivacy />}
            {activeSection === 'storage' && <SettingsStorage />}
            {activeSection === 'backup' && <SettingsBackup />}
            {activeSection === 'shortcuts' && <SettingsShortcuts />}
            {activeSection === 'updates' && <SettingsUpdates />}
            {activeSection === 'advanced' && <SettingsAdvanced />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
