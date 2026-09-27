import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PetSettings } from '@shared/types/pet'
import { SettingsPet } from '@/components/settings/SettingsPet'

const updateSetting = vi.fn()
let pet: PetSettings

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: () => ({ pet, updateSetting })
}))
vi.mock('@/api/pet-api', () => ({ petApi: { show: vi.fn() } }))

describe('pet animation settings', () => {
  beforeEach(() => {
    updateSetting.mockClear()
    pet = {
      enabled: true,
      petId: 'corgi',
      size: 'M',
      opacity: 1,
      animationSpeedEnabled: true,
      animationSpeed: 3,
      hasHatched: true
    }
  })

  it('keeps automatic corgi styles independent of the shared speed controls', () => {
    const { rerender } = render(<SettingsPet />)
    expect(screen.getByTestId('pet-animation-variants')).toHaveTextContent('up to 5 styles')
    expect(screen.getByTestId('pet-animation-speed-enabled-checkbox')).toBeChecked()
    expect(screen.getByTestId('pet-animation-speed-slider')).toHaveValue('3')

    fireEvent.click(screen.getByTestId('pet-animation-speed-enabled-checkbox'))
    expect(updateSetting).toHaveBeenLastCalledWith('pet', { ...pet, animationSpeedEnabled: false })
    pet = { ...pet, animationSpeedEnabled: false }
    rerender(<SettingsPet />)
    expect(screen.getByTestId('pet-animation-speed-slider')).toBeDisabled()
    expect(screen.getByTestId('pet-animation-variants')).toHaveTextContent(
      'This works whether speed scaling is on or off.'
    )

    fireEvent.click(screen.getByTestId('pet-animation-speed-enabled-checkbox'))
    expect(updateSetting).toHaveBeenLastCalledWith('pet', { ...pet, animationSpeedEnabled: true })
    pet = { ...pet, animationSpeedEnabled: true }
    rerender(<SettingsPet />)
    expect(screen.getByTestId('pet-animation-speed-slider')).toBeEnabled()
    fireEvent.change(screen.getByTestId('pet-animation-speed-slider'), { target: { value: '2' } })
    expect(updateSetting).toHaveBeenLastCalledWith('pet', { ...pet, animationSpeed: 2 })
    pet = { ...pet, animationSpeed: 2 }
    rerender(<SettingsPet />)

    fireEvent.change(screen.getByTestId('pet-selector'), { target: { value: 'bee' } })
    expect(updateSetting).toHaveBeenCalledWith('pet', { ...pet, petId: 'bee' })
    pet = { ...pet, petId: 'bee' }
    rerender(<SettingsPet />)
    expect(screen.queryByTestId('pet-animation-variants')).not.toBeInTheDocument()
    expect(screen.getByTestId('pet-animation-speed-enabled-checkbox')).toBeChecked()
    expect(screen.getByTestId('pet-animation-speed-slider')).toHaveValue('2')
  })
})
