// Icon chooser for a data project (wizard details step and the "Change icon…" dialog). Four
// sources — engine logos, an emoji, a curated lucide glyph, an uploaded image (through the same
// ~/.hive/project-icons pipeline git projects use) — plus a tint row that colours the tile
// behind a logo or the lucide glyph (brand marks themselves are never recoloured).

import { useState } from 'react'
import { ImageUp, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { projectApi } from '@/api/project-api'
import { toast } from '@/lib/toast'
import {
  DATA_ENGINE_INFO,
  DATA_ENGINES,
  type DataEngine,
  type DataProjectIcon as DataProjectIconSpec
} from '@shared/data-projects/types'
import { ICON_TINTS } from '../data-project-ui'
import {
  DATA_PROJECT_LUCIDE_ICONS,
  DataProjectIcon,
  invalidateDataProjectIconImage
} from '../DataProjectIcon'
import { EngineTile } from '../engine-logos'
import { Segmented } from './wizard-fields'

const EMOJI_PICKS = [
  '🗄️',
  '🐘',
  '🐬',
  '🦭',
  '🍃',
  '📊',
  '📦',
  '🛒',
  '👥',
  '💳',
  '🚀',
  '🧪',
  '🔒',
  '⭐',
  '🔥',
  '🌍'
]

type IconTab = 'logos' | 'emoji' | 'icons' | 'upload'

export interface IconPickerProps {
  engine: DataEngine
  icon: DataProjectIconSpec | null
  iconColor: string | null
  onChange: (icon: DataProjectIconSpec | null, iconColor: string | null) => void
  /**
   * Key the uploaded file is stored under (`<key>.<ext>` in ~/.hive/project-icons): the data
   * project id when editing (the server deletes `<id>.*` with the project), a fresh key for a
   * project that does not exist yet.
   */
  imageKey: string
  /** Told about every uploaded file name (the wizard cleans up uploads it did not save). */
  onImageUploaded?: (fileName: string) => void
}

const initialTab = (icon: DataProjectIconSpec | null): IconTab => {
  switch (icon?.kind) {
    case 'emoji':
      return 'emoji'
    case 'lucide':
      return 'icons'
    case 'image':
      return 'upload'
    default:
      return 'logos'
  }
}

export function IconPicker({
  engine,
  icon,
  iconColor,
  onChange,
  imageKey,
  onImageUploaded
}: IconPickerProps): React.JSX.Element {
  const [tab, setTab] = useState<IconTab>(initialTab(icon))
  const [emoji, setEmoji] = useState(icon?.kind === 'emoji' ? icon.emoji : '')
  const [uploading, setUploading] = useState(false)
  const tintable = !icon || icon.kind === 'engine' || icon.kind === 'lucide'

  const upload = async (): Promise<void> => {
    if (uploading) return
    setUploading(true)
    try {
      const result = await projectApi.pickProjectIcon(imageKey)
      if (result.success && result.filename) {
        invalidateDataProjectIconImage(result.filename)
        onImageUploaded?.(result.filename)
        onChange({ kind: 'image', fileName: result.filename }, iconColor)
      } else if (result.error && result.error !== 'cancelled') {
        toast.error(`Could not use that image: ${result.error}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open the image picker')
    } finally {
      setUploading(false)
    }
  }

  const applyEmoji = (value: string): void => {
    setEmoji(value)
    const trimmed = value.trim()
    if (trimmed)
      onChange({ kind: 'emoji', emoji: Array.from(trimmed).slice(0, 8).join('') }, iconColor)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="data-project-icon-picker">
      <div className="flex items-center gap-3">
        <DataProjectIcon engine={engine} icon={icon} iconColor={iconColor} size="xl" />
        <div className="flex flex-col gap-1.5">
          <Segmented
            ariaLabel="Icon source"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'logos', label: 'Logos' },
              { value: 'emoji', label: 'Emoji' },
              { value: 'icons', label: 'Icons' },
              { value: 'upload', label: 'Image' }
            ]}
            testId="data-project-icon-tab"
          />
          <button
            type="button"
            onClick={() => {
              setEmoji('')
              onChange(null, null)
            }}
            className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="data-project-icon-reset"
          >
            <RotateCcw className="size-3" />
            Reset to {DATA_ENGINE_INFO[engine].label} logo
          </button>
        </div>
      </div>

      {tab === 'logos' && (
        <div className="grid grid-cols-6 gap-1.5">
          {DATA_ENGINES.map((candidate) => {
            const active =
              (icon?.kind === 'engine' && icon.engine === candidate) ||
              (!icon && candidate === engine)
            return (
              <button
                key={candidate}
                type="button"
                onClick={() =>
                  onChange(
                    candidate === engine ? null : { kind: 'engine', engine: candidate },
                    iconColor
                  )
                }
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md border p-1.5 transition-colors',
                  active ? 'border-ring bg-accent' : 'border-transparent hover:bg-accent/50'
                )}
                title={DATA_ENGINE_INFO[candidate].label}
                aria-pressed={active}
                data-testid={`data-project-icon-engine-${candidate}`}
              >
                <EngineTile engine={candidate} tint={iconColor} className="size-7 rounded-[6px]" />
                <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                  {DATA_ENGINE_INFO[candidate].label}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {tab === 'emoji' && (
        <div className="flex flex-col gap-2">
          <Input
            value={emoji}
            onChange={(e) => applyEmoji(e.target.value)}
            placeholder="Type or paste an emoji"
            className="w-48 text-[15px]"
            data-testid="data-project-icon-emoji-input"
            aria-label="Emoji"
          />
          <div className="flex flex-wrap gap-1">
            {EMOJI_PICKS.map((pick) => (
              <button
                key={pick}
                type="button"
                onClick={() => applyEmoji(pick)}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded-md text-[17px] hover:bg-accent',
                  icon?.kind === 'emoji' && icon.emoji === pick && 'bg-accent ring-1 ring-ring'
                )}
                data-testid={`data-project-icon-emoji-${pick}`}
              >
                {pick}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'icons' && (
        <div className="grid grid-cols-9 gap-1">
          {Object.entries(DATA_PROJECT_LUCIDE_ICONS).map(([name, Glyph]) => {
            const active = icon?.kind === 'lucide' && icon.name === name
            return (
              <button
                key={name}
                type="button"
                onClick={() => onChange({ kind: 'lucide', name }, iconColor)}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded-md hover:bg-accent',
                  active && 'bg-accent ring-1 ring-ring'
                )}
                title={name}
                aria-pressed={active}
                data-testid={`data-project-icon-lucide-${name}`}
              >
                <Glyph className="size-4" style={iconColor ? { color: iconColor } : undefined} />
              </button>
            )
          })}
        </div>
      )}

      {tab === 'upload' && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void upload()}
            disabled={uploading}
            data-testid="data-project-icon-upload"
          >
            {uploading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ImageUp className="size-3.5" />
            )}
            Choose image…
          </Button>
          <span className="text-[11px] text-muted-foreground">SVG, PNG, JPG or WebP</span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Tint {tintable ? '' : '(logos and icons only)'}
        </span>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Tint">
          <button
            type="button"
            role="radio"
            aria-checked={iconColor === null}
            onClick={() => onChange(icon, null)}
            className={cn(
              'inline-flex h-5 items-center rounded-full border border-border px-2 text-[10px] text-muted-foreground',
              iconColor === null && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
            )}
            data-testid="data-project-icon-tint-default"
          >
            Brand
          </button>
          {ICON_TINTS.map((tint) => (
            <button
              key={tint}
              type="button"
              role="radio"
              aria-checked={iconColor === tint}
              aria-label={`Tint ${tint}`}
              onClick={() => onChange(icon, tint)}
              className={cn(
                'size-5 rounded-full',
                iconColor === tint && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
              )}
              style={{ backgroundColor: tint }}
              data-testid={`data-project-icon-tint-${tint.slice(1)}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
