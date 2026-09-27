import { DotLottie } from '@lottiefiles/dotlottie-web'
import dotLottieWasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url'
import { createRoot } from 'react-dom/client'
import { PetSprite } from '../PetSprite'
import { sessionCounterSlots } from '../sessionCounter'
import { getPet } from '../registry'
import type { PetSize } from '@shared/types/pet'
import '../pet.css'
import './corgi-preview.css'

DotLottie.setWasmUrl(dotLottieWasmUrl)
const corgi = getPet('corgi')
const baseLevels = [
  ['The original', 'Our happy little running companion.', 'corgi-anim'],
  ['Happy tail', 'A long, cream-tipped tail with a softer wag.', 'corgi-level-2'],
  ['Royal corgi', 'A golden crown for a very good multitasker.', 'corgi-level-3'],
  ['Here to help', 'A red cape that ripples with every stride.', 'corgi-level-4']
]
const levels = Array.from(
  { length: 20 },
  (_, index) =>
    baseLevels[index] ?? [
      `Super corgi · ${index + 1}`,
      `The cape wears the actual count: ${index + 1} active sessions.`,
      'corgi-level-5'
    ]
)
const players: DotLottie[] = []
const playButton = document.querySelector<HTMLButtonElement>('#play')!
const frameInput = document.querySelector<HTMLInputElement>('#frame')!
const frameLabel = document.querySelector<HTMLOutputElement>('#frame-label')!
const loadStatus = document.querySelector<HTMLElement>('#load-status')!
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
let playing = !reduceMotion
let loaded = 0
playButton.textContent = playing ? 'Pause animations' : 'Play animations'

for (const [index, [name, description, filename]] of levels.entries()) {
  const src = corgi.resolvedWorkingLottieVariants![Math.min(index, 4)]
  const card = document.createElement('article')
  card.className = 'card'
  card.dataset.sessions = String(index + 1)
  card.innerHTML = `<div class="card-top"><span class="level">${String(index + 1).padStart(2, '0')}</span><span>${index + 1} active session${index ? 's' : ''}</span></div>
    <div class="artboard"><canvas width="720" height="720" aria-label="${name}, ${index + 1} active sessions"></canvas></div>
    <div class="caption"><h2>${name}</h2><p>${description}</p><a href="${src}" download="${filename}.lottie">${index >= 4 ? 'Download editable template' : 'Download Lottie'} <span aria-hidden="true">↗</span></a></div>`
  document.querySelector('#gallery')!.append(card)
  const player = new DotLottie({
    canvas: card.querySelector('canvas')!,
    src,
    autoplay: false,
    loop: true,
    speed: 1,
    renderConfig: { autoResize: true, freezeOnOffscreen: false }
  })
  players.push(player)
  player.addEventListener('load', () => {
    const slots = sessionCounterSlots(corgi.workingSessionCounter, index + 1)
    for (const [id, value] of Object.entries(slots ?? {})) player.setTextSlot(id, value)
    loaded++
    loadStatus.textContent = `${loaded} / ${levels.length} ready`
    if (loaded === levels.length) {
      for (const item of players) {
        item.setFrame(0)
        if (playing) item.play()
      }
    }
  })
  player.addEventListener('loadError', () => {
    loadStatus.textContent = `Could not load ${name}`
    card.dataset.error = 'true'
  })
}

playButton.addEventListener('click', () => {
  playing = !playing
  playButton.textContent = playing ? 'Pause animations' : 'Play animations'
  for (const player of players) {
    if (playing) player.play()
    else player.pause()
  }
  frameInput.value = String(Math.round(players[0].currentFrame))
  frameLabel.textContent = playing ? 'Live' : `${frameInput.value} / 59`
})
frameInput.addEventListener('input', () => {
  playing = false
  playButton.textContent = 'Play animations'
  for (const player of players) {
    player.pause()
    player.setFrame(Number(frameInput.value))
  }
  frameLabel.textContent = `${frameInput.value} / 59`
})
document.querySelector<HTMLSelectElement>('#backdrop')!.addEventListener('change', (event) => {
  document.body.dataset.backdrop = (event.target as HTMLSelectElement).value
})

const speedEnabled = document.querySelector<HTMLInputElement>('#speed-enabled')!
const speedLimit = document.querySelector<HTMLSelectElement>('#speed-limit')!
const root = createRoot(document.querySelector('#desktop-preview')!)
const noop = (): void => {}
function renderDesktop(count: number): void {
  root.render(
    <>
      {(['S', 'M', 'L'] as PetSize[]).map((size) => (
        <div className="desktop-size" key={size}>
          <div className="desktop-stage">
            <PetSprite
              pet={corgi}
              state={count ? 'working' : 'idle'}
              settings={{
                petId: 'corgi',
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
const sessions = document.querySelector<HTMLInputElement>('#sessions')!
const customCount = document.querySelector<HTMLInputElement>('#session-count')!
function updateDesktop(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) return
  sessions.value = String(Math.min(count, 20))
  customCount.value = String(count)
  renderDesktop(count)
}
sessions.addEventListener('input', () => updateDesktop(Number(sessions.value)))
customCount.addEventListener('input', () => {
  if (customCount.value !== '') updateDesktop(Number(customCount.value))
})
speedEnabled.addEventListener('change', () => {
  speedLimit.disabled = !speedEnabled.checked
  renderDesktop(Number(customCount.value))
})
speedLimit.addEventListener('change', () => renderDesktop(Number(customCount.value)))
renderDesktop(Number(sessions.value))

// Inspection hooks: inspect every point of the run cycle with the production WASM player.
Object.assign(window, { corgiPreview: { players } })
window.addEventListener('pagehide', () => {
  players.forEach((player) => player.destroy())
  root.unmount()
})
