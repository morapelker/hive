import { createRoot } from 'react-dom/client'
import { CanvasAtlasSprite } from '../CanvasAtlasSprite'
import { PetSprite } from '../PetSprite'
import { atlasStageWidth } from '../atlasCanvas'
import { workingVariantIndex } from '../workingVariant'
import { getPet } from '../registry'
import type { PetCanvasAtlasCounter, PetSize, PetState } from '@shared/types/pet'
import '../pet.css'
import './corgi-preview.css'
import './sprite-sheet-preview.css'

const bella = getPet('bella')
const atlas = bella.workingAtlas!
const atlases = bella.resolvedWorkingAtlasVariants!
const CARD_HEIGHT = 236

/**
 * Counter options to compare; `manifest` is what ships. The others override only the fields
 * that make the style, so the manifest's anchors, tilt and `minSessions` are shared by all.
 */
const NUMBER_STYLES: Record<string, Partial<PetCanvasAtlasCounter>> = {
  manifest: {},
  before: {
    style: 'plain',
    color: '#b00068',
    outline: undefined,
    badge: undefined,
    fontSizes: { '1': 16.625, '2': 14.9625, '3': 12.46875 }
  },
  print: {
    style: 'print',
    color: '#b00068',
    outline: undefined,
    badge: undefined,
    fontSizes: { '1': 34, '2': 30, '3': 24 }
  },
  jersey: {
    style: 'jersey',
    color: '#ffffff',
    outline: { color: '#b00068', width: 3 },
    badge: undefined,
    fontSizes: { '1': 34, '2': 30, '3': 24 }
  },
  patch: {
    style: 'patch',
    color: '#b00068',
    outline: undefined,
    badge: { fill: '#ffffff', rim: '#b00068', rimWidth: 2, size: 34 },
    fontSizes: { '1': 23, '2': 19, '3': 15 }
  },
  bib: {
    style: 'bib',
    color: '#b00068',
    outline: undefined,
    badge: { fill: '#ffffff', rim: '#b00068', rimWidth: 2, size: 28 },
    fontSizes: { '1': 22, '2': 20, '3': 16 }
  }
}

function styledPet(style: string): typeof bella {
  const counter = { ...atlas.counter!, ...NUMBER_STYLES[style] }
  return { ...bella, workingAtlas: { ...atlas, counter } }
}

const LEVELS: Array<{ min: number; range: string; name: string; description: string }> = [
  {
    min: 0,
    range: '0 · Idle',
    name: 'Off court',
    description: 'Sitting comfortably, waiting for a session to start.'
  },
  { min: 1, range: '1 session', name: 'Warm-up', description: 'Running, nothing fancy yet.' },
  {
    min: 2,
    range: '2–3 sessions',
    name: 'Shades on',
    description: 'Black sunglasses for the afternoon match.'
  },
  {
    min: 4,
    range: '4–5 sessions',
    name: 'Pink polo',
    description: 'The polo shows the live session count.'
  },
  {
    min: 6,
    range: '6–9 sessions',
    name: 'Skirt',
    description: 'A white pleated tennis skirt joins the kit.'
  },
  {
    min: 10,
    range: '10–14 sessions',
    name: 'Visor',
    description: 'A white tennis visor against the sun.'
  },
  {
    min: 15,
    range: '15+ sessions',
    name: 'On fire',
    description: 'Vivid pink polo, a pink visor bow and a long pink flame trail.'
  }
]

const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const speedSelect = $<HTMLSelectElement>('#speed')
const playButton = $<HTMLButtonElement>('#play')
const speedEnabled = $<HTMLInputElement>('#speed-enabled')
const speedLimit = $<HTMLSelectElement>('#speed-limit')
const stateSelect = $<HTMLSelectElement>('#state')
const numberStyle = $<HTMLSelectElement>('#number-style')
const sessions = $<HTMLInputElement>('#sessions')
const customCount = $<HTMLInputElement>('#session-count')
const noop = (): void => {}
let paused = false

function Gallery({
  speed,
  paused,
  style
}: {
  speed: number
  paused: boolean
  style: string
}): React.JSX.Element {
  const pet = styledPet(style)
  const styled = pet.workingAtlas!
  return (
    <>
      {LEVELS.map((level) => {
        const index = workingVariantIndex(pet, level.min)
        const variant = styled.variants[index]
        return (
          <article className="card" key={level.min} data-sessions={level.min}>
            <div className="card-top">
              <span className="level">{level.min ? String(level.min).padStart(2, '0') : '·'}</span>
              <span>{level.range}</span>
            </div>
            <div className="artboard sheet-artboard">
              <span
                className="pet-stage"
                style={{
                  width: level.min ? atlasStageWidth(variant, CARD_HEIGHT) : CARD_HEIGHT,
                  height: CARD_HEIGHT
                }}
              >
                <span
                  className="pet-sprite sheet-card-sprite"
                  style={{ width: CARD_HEIGHT, height: CARD_HEIGHT }}
                >
                  {level.min ? (
                    <CanvasAtlasSprite
                      atlas={styled}
                      variant={variant}
                      src={atlases[index]}
                      fallbackSrc={bella.resolvedAssets.idle}
                      variantIndex={index}
                      count={level.min}
                      size={CARD_HEIGHT}
                      speed={speed}
                      paused={paused}
                      state="working"
                    />
                  ) : (
                    <img src={bella.resolvedAssets.idle} alt="" draggable={false} />
                  )}
                </span>
              </span>
            </div>
            <div className="caption">
              <h2>{level.name}</h2>
              <p>{level.description}</p>
              <a href={level.min ? atlases[index] : bella.resolvedAssets.idle} download>
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

function Desktop({
  count,
  state,
  style
}: {
  count: number
  state: PetState
  style: string
}): React.JSX.Element {
  const pet = styledPet(style)
  return (
    <>
      {(['S', 'M', 'L'] as PetSize[]).map((size) => (
        <div className="desktop-size" key={size}>
          <div className="desktop-stage">
            <PetSprite
              pet={pet}
              state={state}
              settings={{
                petId: 'bella',
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
  galleryRoot.render(
    <Gallery speed={Number(speedSelect.value)} paused={paused} style={numberStyle.value} />
  )
}

function renderDesktop(): void {
  const count = Number(customCount.value)
  const chosen = stateSelect.value
  const state: PetState = chosen === 'auto' ? (count ? 'working' : 'idle') : (chosen as PetState)
  desktopRoot.render(<Desktop count={count} state={state} style={numberStyle.value} />)
}

function updateDesktop(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) return
  sessions.value = String(Math.min(count, 15))
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
numberStyle.addEventListener('change', () => {
  renderGallery()
  renderDesktop()
})
playButton.addEventListener('click', () => {
  paused = !paused
  playButton.textContent = paused ? 'Play' : 'Pause'
  renderGallery()
})
$<HTMLSelectElement>('#backdrop').addEventListener('change', (event) => {
  document.body.dataset.backdrop = (event.target as HTMLSelectElement).value
})

renderGallery()
updateDesktop(Number(sessions.value))

window.addEventListener('pagehide', () => {
  galleryRoot.unmount()
  desktopRoot.unmount()
})
