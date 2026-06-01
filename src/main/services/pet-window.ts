import { app, BrowserWindow, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { getDatabase } from '../db'
import { APP_SETTINGS_DB_KEY } from '../../shared/types/settings'
import type {
  PetManifest,
  PetPosition,
  PetSettings,
  PetSize,
  PetStatusPayload
} from '../../shared/types/pet'
import { emitPetJumpToWorktree, emitPetSettingsUpdated, emitPetStatus } from './pet-events'

const PET_POSITION_FILE = join(app.getPath('userData'), 'pet-position.json')
const PET_PADDING = 48
const SCREEN_MARGIN = 24
const PET_POINTER_INTERACTION_SUPPRESSION_MS = 250

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: false,
  petId: 'bee',
  size: 'M',
  opacity: 1,
  hasHatched: false
}

const BEE_MANIFEST: PetManifest = {
  id: 'bee',
  name: 'Bee',
  version: '1.0.0',
  author: 'Hive',
  assets: {
    idle: 'assets/bee.png',
    working: 'assets/bee.png',
    question: 'assets/bee.png',
    permission: 'assets/bee.png',
    plan_ready: 'assets/bee.png'
  },
  lottieAssets: {
    working: 'assets/honey-bee.lottie'
  },
  lottieScale: {
    working: 2.15
  },
  defaultSize: 'M'
}

const CORGI_MANIFEST: PetManifest = {
  id: 'corgi',
  name: 'Corgi',
  version: '1.0.0',
  author: 'Hive',
  assets: {
    idle: 'assets/corgi-static.png',
    working: 'assets/corgi-static.png',
    question: 'assets/corgi-static.png',
    permission: 'assets/corgi-static.png',
    plan_ready: 'assets/corgi-static.png'
  },
  lottieAssets: {
    working: 'assets/corgi-anim.lottie'
  },
  lottieScale: {
    working: 1.55
  },
  defaultSize: 'M'
}

const PET_MANIFESTS: Record<string, PetManifest> = {
  bee: BEE_MANIFEST,
  corgi: CORGI_MANIFEST
}

const PET_SIZE_PX: Record<PetSize, number> = {
  S: 64,
  M: 96,
  L: 128
}

let petWindow: BrowserWindow | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let latestStatus: PetStatusPayload = { state: 'idle', sourceWorktreeId: null }
let latestSettings: PetSettings = DEFAULT_PET_SETTINGS
let petPointerInteractionActive = false
let petPointerInteractionTimer: NodeJS.Timeout | null = null

function ensureRegularMacAppActivation(): void {
  if (process.platform !== 'darwin') return

  app.setActivationPolicy('regular')
  void app.dock?.show()
}

function petWindowSize(settings = latestSettings): number {
  return PET_SIZE_PX[settings.size] + PET_PADDING
}

function constrainPosition(position: PetPosition, size = petWindowSize()): PetPosition {
  const displays = screen.getAllDisplays()
  const display =
    displays.find((candidate) => {
      const { x, y, width, height } = candidate.workArea
      return position.x >= x && position.y >= y && position.x < x + width && position.y < y + height
    }) ?? screen.getDisplayNearestPoint(position)

  const { x, y, width, height } = display.workArea
  return {
    x: Math.min(Math.max(position.x, x), x + width - size),
    y: Math.min(Math.max(position.y, y), y + height - size)
  }
}

function defaultPosition(size = petWindowSize()): PetPosition {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  return {
    x: x + width - size - SCREEN_MARGIN,
    y: y + height - size - SCREEN_MARGIN
  }
}

export function loadPetPosition(size = petWindowSize()): PetPosition {
  try {
    if (existsSync(PET_POSITION_FILE)) {
      const parsed = JSON.parse(readFileSync(PET_POSITION_FILE, 'utf-8')) as PetPosition
      const position = constrainPosition(parsed, size)
      const displays = screen.getAllDisplays()
      const isInsideWorkArea = displays.some((display) => {
        const { x, y, width, height } = display.workArea
        return (
          parsed.x >= x &&
          parsed.y >= y &&
          parsed.x + size <= x + width &&
          parsed.y + size <= y + height
        )
      })
      if (isInsideWorkArea) return position
    }
  } catch {
    // Ignore invalid persisted position.
  }
  return defaultPosition(size)
}

export function savePetPosition(position: PetPosition): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(PET_POSITION_FILE, JSON.stringify(position))
  } catch {
    // Ignore save errors.
  }
}

export function configurePetWindow(options: { getMainWindow: () => BrowserWindow | null }): void {
  getMainWindow = options.getMainWindow
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}

function clearPetPointerInteractionTimer(): void {
  if (petPointerInteractionTimer) {
    clearTimeout(petPointerInteractionTimer)
    petPointerInteractionTimer = null
  }
}

export function beginPetPointerInteraction(): void {
  clearPetPointerInteractionTimer()
  petPointerInteractionActive = true
}

export function endPetPointerInteraction(): void {
  clearPetPointerInteractionTimer()
  petPointerInteractionTimer = setTimeout(() => {
    petPointerInteractionActive = false
    petPointerInteractionTimer = null
  }, PET_POINTER_INTERACTION_SUPPRESSION_MS)
}

export function shouldSuppressMainWindowActivationFromPet(): boolean {
  return petPointerInteractionActive
}

export function getCurrentPetStatus(): PetStatusPayload {
  return latestStatus
}

export function getCurrentPetSettings(): PetSettings {
  return latestSettings
}

export function getPetConfig(): {
  settings: PetSettings
  position: PetPosition
  manifest: PetManifest
} {
  return {
    settings: latestSettings,
    position: petWindow?.getPosition()
      ? { x: petWindow.getPosition()[0], y: petWindow.getPosition()[1] }
      : loadPetPosition(),
    manifest: PET_MANIFESTS[latestSettings.petId] ?? BEE_MANIFEST
  }
}

export function createPetWindow(): BrowserWindow | null {
  if (process.platform !== 'darwin') return null
  ensureRegularMacAppActivation()
  if (petWindow && !petWindow.isDestroyed()) return petWindow

  const size = petWindowSize()
  const position = loadPetPosition(size)

  petWindow = new BrowserWindow({
    width: size,
    height: size,
    x: position.x,
    y: position.y,
    transparent: true,
    type: 'panel',
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    alwaysOnTop: true,
    focusable: false,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.setFullScreenable(false)
  petWindow.setIgnoreMouseEvents(true, { forward: true })

  petWindow.on('closed', () => {
    petWindow = null
  })

  petWindow.on('ready-to-show', () => {
    petWindow?.showInactive()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    petWindow.loadFile(join(__dirname, '../renderer/pet.html'))
  }

  return petWindow
}

export function destroyPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    const [x, y] = petWindow.getPosition()
    savePetPosition({ x, y })
    petWindow.destroy()
  }
  petWindow = null
  ensureRegularMacAppActivation()
}

export function movePetWindow(position: PetPosition): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const constrained = constrainPosition(position, petWindow.getBounds().width)
  petWindow.setPosition(constrained.x, constrained.y, false)
  savePetPosition(constrained)
}

export function setPetIgnoreMouseEvents(ignore: boolean): void {
  if (!petWindow || petWindow.isDestroyed()) return
  petWindow.setIgnoreMouseEvents(ignore, { forward: true })
}

export function forwardStatusToPet(payload: PetStatusPayload): void {
  latestStatus = payload
  emitPetStatus(payload)
}

export function updatePetSettings(partial: Partial<PetSettings>): void {
  latestSettings = { ...latestSettings, ...partial }

  if (petWindow && !petWindow.isDestroyed()) {
    const size = petWindowSize()
    const [x, y] = petWindow.getPosition()
    const constrained = constrainPosition({ x, y }, size)
    petWindow.setBounds({ ...constrained, width: size, height: size })
    petWindow.setIgnoreMouseEvents(true, { forward: true })
  }

  emitPetSettingsUpdated(latestSettings)
}

export function persistPetSettings(partial: Partial<PetSettings>): void {
  updatePetSettings(partial)

  try {
    const existing = getDatabase().getSetting(APP_SETTINGS_DB_KEY)
    const parsed = existing ? JSON.parse(existing) : {}
    getDatabase().setSetting(
      APP_SETTINGS_DB_KEY,
      JSON.stringify({
        ...parsed,
        pet: {
          ...DEFAULT_PET_SETTINGS,
          ...(parsed.pet ?? {}),
          ...partial
        }
      })
    )
  } catch {
    // The renderer will keep the live cache in sync even if DB persistence fails.
  }
}

export function focusMainWindowFromPet(worktreeId: string | null): void {
  clearPetPointerInteractionTimer()
  petPointerInteractionActive = false
  ensureRegularMacAppActivation()
  const mainWindow = getMainWindow?.() ?? null
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()

  if (worktreeId) {
    emitPetJumpToWorktree(worktreeId)
  }
}
