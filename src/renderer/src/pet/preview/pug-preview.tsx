import { createRoot } from 'react-dom/client'
import { PetSprite } from '../PetSprite'
import { SpriteSheetSprite } from '../SpriteSheetSprite'
import { workingVariantIndex } from '../workingVariant'
import { getPet } from '../registry'
import type { PetSize, PetState } from '@shared/types/pet'
import '../pet.css'
import './corgi-preview.css'
import './pug-preview.css'

const pug = getPet('pug')
const sheet = pug.workingSpriteSheet!
const atlases = pug.resolvedWorkingSpriteSheetVariants!

const LEVELS: Array<{ min: number; range: string; name: string; description: string }> = [
  {
    min: 0,
    range: '0 · Idle',
    name: 'Off duty',
    description: 'A soft little loaf. Folded ears, forehead wrinkles and a proper pug curl.'
  },
  {
    min: 1,
    range: '1 worktree',
    name: 'Little legs, big plans',
    description: 'The same soft plush pug, now bounding along on four tiny paws.'
  },
  {
    min: 2,
    range: '2 worktrees',
    name: 'Happy helper',
    description: 'A sage linen bandana, softly folded and tied behind the neck.'
  },
  {
    min: 3,
    range: '3 worktrees',
    name: 'His pugness',
    description: 'A little polished gold crown, rounded tips and a teal jewel.'
  },
  {
    min: 4,
    range: '4 worktrees',
    name: 'Cape, please',
    description: 'Coral satin, a gold hem and an embroidered paw. Dressed to help.'
  },
  {
    min: 5,
    range: '5–9 worktrees',
    name: 'Super pug',
    description: 'The stitched cape badge counts your worktrees, with a little golden sparkle.'
  },
  {
    min: 10,
    range: '10–14 worktrees',
    name: 'Fast & furriest',
    description: 'Sapphire satin and brass goggles perched above those big glossy eyes.'
  },
  {
    min: 15,
    range: '15–19 worktrees',
    name: 'Pugs can fly',
    description: 'Amethyst velvet and soft ivory wings. A very small, very determined aviator.'
  },
  {
    min: 20,
    range: '20+ worktrees',
    name: 'Small but mighty',
    description: 'Midnight velvet, embroidered stars and a warm golden comet trail.'
  }
]

const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const speedSelect = $<HTMLSelectElement>('#speed')
const speedEnabled = $<HTMLInputElement>('#speed-enabled')
const speedLimit = $<HTMLSelectElement>('#speed-limit')
const stateSelect = $<HTMLSelectElement>('#state')
const sessions = $<HTMLInputElement>('#sessions')
const customCount = $<HTMLInputElement>('#session-count')
const noop = (): void => {}

function Gallery({ speed }: { speed: number }): React.JSX.Element {
  return (
    <>
      {LEVELS.map((level) => {
        const index = workingVariantIndex(pug, level.min)
        return (
          <article className="card" key={level.min} data-sessions={level.min}>
            <div className="card-top">
              <span className="level">{level.min ? String(level.min).padStart(2, '0') : '·'}</span>
              <span>{level.range}</span>
            </div>
            <div className="artboard pug-artboard">
              <span className="pet-sprite pug-card-sprite">
                {level.min ? (
                  <SpriteSheetSprite
                    sheet={sheet}
                    src={atlases[index]}
                    fallbackSrc={pug.resolvedAssets.idle}
                    variantIndex={index}
                    count={level.min}
                    speed={speed}
                    state="working"
                  />
                ) : (
                  <img src={pug.resolvedAssets.idle} alt="" draggable={false} />
                )}
              </span>
            </div>
            <div className="caption">
              <h2>{level.name}</h2>
              <p>{level.description}</p>
              <a href={level.min ? atlases[index] : pug.resolvedAssets.idle} download>
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
              pet={pug}
              state={state}
              settings={{
                petId: 'pug',
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
