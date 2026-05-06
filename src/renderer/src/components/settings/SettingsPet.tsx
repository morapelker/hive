import { Bug, Check } from 'lucide-react'
import type { PetSettings, PetSize } from '@shared/types/pet'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { listPets } from '@/pet/registry'
import { useSettingsStore } from '@/stores/useSettingsStore'

const SIZE_OPTIONS: Array<{ id: PetSize; label: string; description: string }> = [
  { id: 'S', label: 'S', description: '64 px' },
  { id: 'M', label: 'M', description: '96 px' },
  { id: 'L', label: 'L', description: '128 px' }
]

export function SettingsPet(): React.JSX.Element {
  const { pet, updateSetting } = useSettingsStore()
  const pets = listPets()

  const updatePet = (partial: Partial<PetSettings>): void => {
    updateSetting('pet', { ...pet, ...partial })
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Pet</h3>
        <p className="text-sm text-muted-foreground">
          Ambient desktop status for the worktree that needs the most attention
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">Enable pet</label>
          <p className="text-xs text-muted-foreground">
            Shows a transparent always-on-top overlay on macOS
          </p>
        </div>
        <button
          role="switch"
          aria-checked={pet.enabled}
          onClick={() => updatePet({ enabled: !pet.enabled })}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
            pet.enabled ? 'bg-primary' : 'bg-muted'
          )}
          data-testid="pet-enabled-toggle"
        >
          <span
            className={cn(
              'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
              pet.enabled ? 'translate-x-4' : 'translate-x-0'
            )}
          />
        </button>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Character</label>
        <select
          value={pet.petId}
          onChange={(event) => updatePet({ petId: event.target.value })}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          data-testid="pet-selector"
        >
          {pets.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Size</label>
        <div className="grid grid-cols-3 gap-2">
          {SIZE_OPTIONS.map((option) => {
            const selected = pet.size === option.id
            return (
              <button
                key={option.id}
                onClick={() => updatePet({ size: option.id })}
                className={cn(
                  'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                  selected
                    ? 'border-primary/40 bg-primary/10'
                    : 'border-border bg-muted/30 hover:bg-accent/50'
                )}
                data-testid={`pet-size-${option.id}`}
              >
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
                {selected && <Check className="h-4 w-4 text-primary" />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Opacity</label>
          <span className="text-xs text-muted-foreground">{Math.round(pet.opacity * 100)}%</span>
        </div>
        <input
          type="range"
          min={20}
          max={100}
          step={5}
          value={Math.round(pet.opacity * 100)}
          onChange={(event) => updatePet({ opacity: Number(event.target.value) / 100 })}
          className="w-full accent-primary"
          data-testid="pet-opacity-slider"
        />
      </div>

      {pet.enabled && (
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => window.petOps.show()}
          data-testid="show-pet-button"
        >
          <Bug className="h-4 w-4" />
          Show pet
        </Button>
      )}
    </div>
  )
}
