import { useState, useMemo } from 'react'
import {
  Briefcase,
  Code,
  Gamepad2,
  Palette,
  Music,
  Camera,
  Book,
  Wrench,
  Rocket,
  Heart,
  Star,
  Coffee,
  Globe,
  Zap,
  Shield,
  Terminal,
  Database,
  Cloud,
  Smartphone,
  Monitor,
  Cpu,
  GitBranch,
  Package,
  Layers,
  Compass,
  Map,
  Flag,
  Award,
  Crown,
  Diamond,
  Flame,
  Leaf,
  Sun,
  Moon,
  Umbrella,
  Anchor,
  Key,
  Lock,
  Bell,
  Bookmark,
  Calendar,
  Clock,
  Download,
  Upload,
  Search,
  Settings,
  Share,
  Trash,
  Users,
  Video,
  Wifi,
  FileCode,
  FolderOpen,
  MessageSquare,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

interface SpaceIconPickerProps {
  selectedValue?: string
  onSelect: (iconType: string, iconValue: string) => void
}

interface IconEntry {
  name: string
  component: LucideIcon
}

const ICON_LIST: IconEntry[] = [
  { name: 'Briefcase', component: Briefcase },
  { name: 'Code', component: Code },
  { name: 'Gamepad2', component: Gamepad2 },
  { name: 'Palette', component: Palette },
  { name: 'Music', component: Music },
  { name: 'Camera', component: Camera },
  { name: 'Book', component: Book },
  { name: 'Wrench', component: Wrench },
  { name: 'Rocket', component: Rocket },
  { name: 'Heart', component: Heart },
  { name: 'Star', component: Star },
  { name: 'Coffee', component: Coffee },
  { name: 'Globe', component: Globe },
  { name: 'Zap', component: Zap },
  { name: 'Shield', component: Shield },
  { name: 'Terminal', component: Terminal },
  { name: 'Database', component: Database },
  { name: 'Cloud', component: Cloud },
  { name: 'Smartphone', component: Smartphone },
  { name: 'Monitor', component: Monitor },
  { name: 'Cpu', component: Cpu },
  { name: 'GitBranch', component: GitBranch },
  { name: 'Package', component: Package },
  { name: 'Layers', component: Layers },
  { name: 'Compass', component: Compass },
  { name: 'Map', component: Map },
  { name: 'Flag', component: Flag },
  { name: 'Award', component: Award },
  { name: 'Crown', component: Crown },
  { name: 'Diamond', component: Diamond },
  { name: 'Flame', component: Flame },
  { name: 'Leaf', component: Leaf },
  { name: 'Sun', component: Sun },
  { name: 'Moon', component: Moon },
  { name: 'Umbrella', component: Umbrella },
  { name: 'Anchor', component: Anchor },
  { name: 'Key', component: Key },
  { name: 'Lock', component: Lock },
  { name: 'Bell', component: Bell },
  { name: 'Bookmark', component: Bookmark },
  { name: 'Calendar', component: Calendar },
  { name: 'Clock', component: Clock },
  { name: 'Download', component: Download },
  { name: 'Upload', component: Upload },
  { name: 'Search', component: Search },
  { name: 'Settings', component: Settings },
  { name: 'Share', component: Share },
  { name: 'Trash', component: Trash },
  { name: 'Users', component: Users },
  { name: 'Video', component: Video },
  { name: 'Wifi', component: Wifi },
  { name: 'FileCode', component: FileCode },
  { name: 'FolderOpen', component: FolderOpen },
  { name: 'MessageSquare', component: MessageSquare }
]

export function SpaceIconPicker({
  selectedValue,
  onSelect
}: SpaceIconPickerProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredIcons = useMemo(() => {
    if (!searchQuery.trim()) return ICON_LIST
    const q = searchQuery.toLowerCase()
    return ICON_LIST.filter((icon) => icon.name.toLowerCase().includes(q))
  }, [searchQuery])

  return (
    <div className="space-y-2" data-testid="space-icon-picker">
      <Input
        placeholder="Search icons..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="h-7 text-xs"
      />
      <div className="grid grid-cols-8 gap-1 max-h-40 overflow-y-auto">
        {filteredIcons.map((icon) => {
          const Icon = icon.component
          const isSelected = selectedValue === icon.name
          return (
            <button
              key={icon.name}
              type="button"
              className={cn(
                'flex items-center justify-center h-7 w-7 rounded-md transition-colors cursor-pointer',
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-accent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onSelect('default', icon.name)}
              title={icon.name}
              data-testid={`icon-${icon.name}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          )
        })}
      </div>
      {filteredIcons.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2">No icons match</p>
      )}
    </div>
  )
}

/** Resolve an icon_value string to its lucide component for rendering. */
export function getSpaceIcon(iconValue: string): LucideIcon {
  const entry = ICON_LIST.find((i) => i.name === iconValue)
  return entry?.component ?? FolderOpen
}

export { ICON_LIST }
