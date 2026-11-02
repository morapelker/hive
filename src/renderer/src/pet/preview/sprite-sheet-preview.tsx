import { createRoot } from 'react-dom/client'
import { PetSprite } from '../PetSprite'
import { SpriteSheetSprite } from '../SpriteSheetSprite'
import { workingVariantIndex } from '../workingVariant'
import { getPet } from '../registry'
import type { PetSize, PetState } from '@shared/types/pet'
import '../pet.css'
import './corgi-preview.css'
import './sprite-sheet-preview.css'

export interface PreviewLevel {
  min: number
  range: string
  name: string
  description: string
}

const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const noop = (): void => {}

/**
 * Development preview for a sprite-sheet pet: a gallery card per milestone drawn by the real
 * `SpriteSheetSprite`, and the real `PetSprite` at each desktop size under a count slider.
 * The page markup is shared by `pug-preview.html` and `french-bulldog-preview.html`.
 */
export function mountSpriteSheetPreview(petId: string, levels: PreviewLevel[]): void {
  const pet = getPet(petId)
  const sheet = pet.workingSpriteSheet!
  const atlases = pet.resolvedWorkingSpriteSheetVariants!

  const speedSelect = $<HTMLSelectElement>('#speed')
  const speedEnabled = $<HTMLInputElement>('#speed-enabled')
  const speedLimit = $<HTMLSelectElement>('#speed-limit')
  const stateSelect = $<HTMLSelectElement>('#state')
  const sessions = $<HTMLInputElement>('#sessions')
  const customCount = $<HTMLInputElement>('#session-count')

  function Gallery({ speed }: { speed: number }): React.JSX.Element {
    return (
      <>
        {levels.map((level) => {
          const index = workingVariantIndex(pet, level.min)
          return (
            <article className="card" key={level.min} data-sessions={level.min}>
              <div className="card-top">
                <span className="level">
                  {level.min ? String(level.min).padStart(2, '0') : '·'}
                </span>
                <span>{level.range}</span>
              </div>
              <div className="artboard sheet-artboard">
                <span className="pet-sprite sheet-card-sprite">
                  {level.min ? (
                    <SpriteSheetSprite
                      sheet={sheet}
                      src={atlases[index]}
                      fallbackSrc={pet.resolvedAssets.idle}
                      variantIndex={index}
                      count={level.min}
                      speed={speed}
                      state="working"
                    />
                  ) : (
                    <img src={pet.resolvedAssets.idle} alt="" draggable={false} />
                  )}
                </span>
              </div>
              <div className="caption">
                <h2>{level.name}</h2>
                <p>{level.description}</p>
                <a href={level.min ? atlases[index] : pet.resolvedAssets.idle} download>
                  {level.min ? 'Download atlas' : 'Download portrait'}{' '}
                  <span aria-hidden="true">↗</span>
                </a>
              </div>
            </article>
          )
        })}
      </>
    )
  }

  function Desktop({ count, state }: { count: number; state: PetState }): React.JSX.Element {
    return (
      <>
        {(['S', 'M', 'L'] as PetSize[]).map((size) => (
          <div className="desktop-size" key={size}>
            <div className="desktop-stage">
              <PetSprite
                pet={pet}
                state={state}
                settings={{
                  petId,
                  enabled: true,
                  size,
                  opacity: 1,
                  animationSpeed: Number(speedLimit.value),
                  animationSpeedEnabled: speedEnabled.checked,
                  hasHatched: true
                }}
                workingSessionCount={count}
                onPointerDown={noop}
                onMouseEnter={noop}
                onMouseLeave={noop}
                onClick={noop}
                onContextMenu={noop}
              />
            </div>
            <span>
              {size} · {size === 'S' ? 64 : size === 'M' ? 96 : 128} px
            </span>
          </div>
        ))}
      </>
    )
  }

  const galleryRoot = createRoot($('#gallery'))
  const desktopRoot = createRoot($('#desktop-preview'))

  function renderGallery(): void {
    galleryRoot.render(<Gallery speed={Number(speedSelect.value)} />)
  }

  function renderDesktop(): void {
    const count = Number(customCount.value)
    const chosen = stateSelect.value
    const state: PetState = chosen === 'auto' ? (count ? 'working' : 'idle') : (chosen as PetState)
    desktopRoot.render(<Desktop count={count} state={state} />)
  }

  function updateDesktop(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) return
    sessions.value = String(Math.min(count, 20))
    customCount.value = String(count)
    renderDesktop()
  }

  sessions.addEventListener('input', () => updateDesktop(Number(sessions.value)))
  customCount.addEventListener('input', () => {
    if (customCount.value !== '') updateDesktop(Number(customCount.value))
  })
  stateSelect.addEventListener('change', renderDesktop)
  speedEnabled.addEventListener('change', () => {
    speedLimit.disabled = !speedEnabled.checked
    renderDesktop()
  })
  speedLimit.addEventListener('change', renderDesktop)
  speedSelect.addEventListener('change', renderGallery)
  $<HTMLSelectElement>('#backdrop').addEventListener('change', (event) => {
    document.body.dataset.backdrop = (event.target as HTMLSelectElement).value
  })

  renderGallery()
  updateDesktop(Number(sessions.value))

  window.addEventListener('pagehide', () => {
    galleryRoot.unmount()
    desktopRoot.unmount()
  })
}
