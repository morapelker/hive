/**
 * Feedback sounds for the pill. On macOS the main process hands over the
 * system "Pop" and "Tink" sounds (converted to WAV once); elsewhere a short
 * synthesised tone stands in. Decoded once, played with no latency.
 */
export type VoiceSoundName = 'start' | 'stop'

export class VoiceSoundPlayer {
  private context: AudioContext | null = null
  private buffers: Partial<Record<VoiceSoundName, AudioBuffer>> = {}
  private loading: Promise<void> | null = null

  private getContext(): AudioContext {
    if (!this.context) this.context = new AudioContext()
    return this.context
  }

  load(): Promise<void> {
    this.loading ??= this.loadBuffers().catch(() => {})
    return this.loading
  }

  private async loadBuffers(): Promise<void> {
    const bridge = window.desktopBridge?.voiceHud
    if (!bridge) return
    const raw = await bridge.getSounds()
    const context = this.getContext()
    for (const name of ['start', 'stop'] as const) {
      const bytes = raw[name]
      if (!bytes) continue
      try {
        const copy = bytes.slice().buffer
        this.buffers[name] = await context.decodeAudioData(copy)
      } catch {
        // Fall back to the synthesised tone for this sound.
      }
    }
  }

  play(name: VoiceSoundName): void {
    const context = this.getContext()
    if (context.state !== 'running') void context.resume().catch(() => {})
    const buffer = this.buffers[name]
    if (buffer) {
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start()
      return
    }
    // Synthesised stand-in: a rising blip to start, a falling one to stop.
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const now = context.currentTime
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(name === 'start' ? 740 : 620, now)
    oscillator.frequency.exponentialRampToValueAtTime(name === 'start' ? 980 : 440, now + 0.08)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.13)
  }
}
