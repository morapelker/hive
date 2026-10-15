import { app, BrowserWindow, powerMonitor, webContents } from 'electron'
import { join } from 'node:path'
import type { PerfLoggingPayload, PerfLoggingResult } from '../../../shared/desktop-command'
import { getPerfLogger, type PerfLogger } from './perf-logger'

/**
 * Performance logging in the Electron main process. The server child owns the user's toggle
 * (`perfDiagnosticsOps.enable`) and forwards it here as the `perfLogging` desktop command; at
 * boot `index.ts` reads the persisted setting directly.
 *
 * Besides the generic sampler this process can see what no other can: `app.getAppMetrics()`
 * (CPU and working set of every Chromium process, renderer and GPU included), window counts,
 * and sleep/wake, which the "after a while" symptom tends to follow.
 */

let logger: PerfLogger | null = null
let wired = false

/**
 * Renderer-side counters the renderer cannot read about itself (listener count, DOM nodes,
 * layout work) through the DevTools protocol, polled while logging is on. Attaching fails
 * harmlessly when DevTools already holds the debugger; the gauge then reports nothing.
 */
const RENDERER_METRICS_POLL_MS = 10_000
const RENDERER_METRIC_NAMES = new Set([
  'JSEventListeners',
  'Nodes',
  'Documents',
  'Frames',
  'LayoutCount',
  'RecalcStyleCount',
  'JSHeapUsedSize'
])
const rendererMetrics = new Map<number, Record<string, number>>()
const attachedContents = new Map<number, Electron.WebContents>()
const destroyListened = new Set<number>()
let rendererMetricsTimer: ReturnType<typeof setInterval> | null = null

const pollRendererMetrics = async (): Promise<void> => {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.getType() === 'remote' || contents.getURL().startsWith('devtools://')) continue
    try {
      if (!attachedContents.has(contents.id)) {
        if (contents.isDevToolsOpened()) continue
        contents.debugger.attach('1.3')
        attachedContents.set(contents.id, contents)
        await contents.debugger.sendCommand('Performance.enable')
        if (!destroyListened.has(contents.id)) {
          destroyListened.add(contents.id)
          contents.once('destroyed', () => {
            attachedContents.delete(contents.id)
            rendererMetrics.delete(contents.id)
            destroyListened.delete(contents.id)
          })
        }
      }
      const result = (await contents.debugger.sendCommand('Performance.getMetrics')) as {
        metrics: Array<{ name: string; value: number }>
      }
      const out: Record<string, number> = {}
      for (const metric of result.metrics) {
        if (RENDERER_METRIC_NAMES.has(metric.name)) {
          out[metric.name] = metric.name === 'JSHeapUsedSize' ? Math.round(metric.value / 1048576) : metric.value
        }
      }
      rendererMetrics.set(contents.id, out)
    } catch {
      if (attachedContents.delete(contents.id)) {
        try {
          contents.debugger.detach()
        } catch {
          // already detached
        }
      }
      rendererMetrics.delete(contents.id)
    }
  }
}

const startRendererMetrics = (): void => {
  if (rendererMetricsTimer) return
  rendererMetricsTimer = setInterval(() => {
    void pollRendererMetrics()
  }, RENDERER_METRICS_POLL_MS)
  rendererMetricsTimer.unref?.()
  void pollRendererMetrics()
}

const stopRendererMetrics = (): void => {
  if (rendererMetricsTimer) clearInterval(rendererMetricsTimer)
  rendererMetricsTimer = null
  for (const contents of attachedContents.values()) {
    try {
      if (!contents.isDestroyed()) contents.debugger.detach()
    } catch {
      // already detached
    }
  }
  attachedContents.clear()
  rendererMetrics.clear()
}

export const getElectronMainPerfLogger = (): PerfLogger => {
  if (!logger) {
    logger = getPerfLogger('electron-main')
    wireElectronGauges(logger)
  }
  return logger
}

const wireElectronGauges = (target: PerfLogger): void => {
  if (wired) return
  wired = true
  target.registerGauge('electron.windows', () => BrowserWindow.getAllWindows().length)
  target.registerGauge('renderer.metrics', () => {
    const out: Record<string, number> = {}
    for (const [id, metrics] of rendererMetrics) {
      for (const [name, value] of Object.entries(metrics)) out[`${id}:${name}`] = value
    }
    return out
  })
  target.registerGauge('electron.webContents', () => webContents.getAllWebContents().length)
  target.registerGauge('electron.processes', () => {
    const out: Record<string, number> = {}
    for (const metric of app.getAppMetrics()) {
      const key = `${metric.type}${metric.name ? `(${metric.name})` : ''}:${metric.pid}`
      out[`${key}:cpuPct`] = Math.round(metric.cpu.percentCPUUsage * 100) / 100
      out[`${key}:wsMB`] = Math.round(metric.memory.workingSetSize / 1024)
    }
    return out
  })
  try {
    powerMonitor.on('suspend', () => target.mark('power-suspend'))
    powerMonitor.on('resume', () => target.mark('power-resume'))
    powerMonitor.on('lock-screen', () => target.mark('screen-lock'))
    powerMonitor.on('unlock-screen', () => target.mark('screen-unlock'))
  } catch {
    // powerMonitor is unavailable before app ready in some test harnesses
  }
}

export const configureElectronMainPerfLogging = (enabled: boolean): void => {
  const target = getElectronMainPerfLogger()
  if (enabled) {
    target.start()
    startRendererMetrics()
  } else {
    stopRendererMetrics()
    target.stop()
  }
}

/** Heap snapshots of every renderer (main window, pet, voice HUD) next to the perf logs. */
const captureRendererHeapSnapshots = async (stamp: string): Promise<string[]> => {
  const target = getElectronMainPerfLogger()
  const files: string[] = []
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    const title = contents.getTitle().replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'renderer'
    const path = join(target.getLogDir(), `heap-renderer-${contents.id}-${title}-${stamp}.heapsnapshot`)
    try {
      await contents.takeHeapSnapshot(path)
      files.push(path)
    } catch (error) {
      console.warn('[perf-logging] renderer heap snapshot failed', error)
    }
  }
  return files
}

export const handlePerfLoggingCommand = async (
  payload: PerfLoggingPayload
): Promise<PerfLoggingResult> => {
  if (payload.action === 'configure') {
    configureElectronMainPerfLogging(payload.enabled)
    return { files: [] }
  }
  const target = getElectronMainPerfLogger()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const own = target.captureNow(payload.reason)
  const renderers = await captureRendererHeapSnapshots(stamp)
  target.mark('capture-renderers', { reason: payload.reason, files: renderers })
  return { files: [...own.files, ...renderers] }
}
