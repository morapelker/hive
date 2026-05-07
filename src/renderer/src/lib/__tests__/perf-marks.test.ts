import { afterEach, describe, expect, it, vi } from 'vitest'

describe('perf-marks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it('does not mark performance entries unless the perf probe query flag is present', async () => {
    const mark = vi.spyOn(performance, 'mark')
    const measure = vi.spyOn(performance, 'measure')
    const { markKeystrokeStart, markKeystrokeEnd } = await import('../perf-marks')

    markKeystrokeStart('keystroke')
    markKeystrokeEnd('keystroke')

    expect(mark).not.toHaveBeenCalled()
    expect(measure).not.toHaveBeenCalled()
  })

  it('records a named measure when the perf probe query flag is present', async () => {
    window.history.replaceState(null, '', '/?perfprobe')
    vi.spyOn(console, 'table').mockImplementation(() => {})
    const mark = vi.spyOn(performance, 'mark')
    const measure = vi.spyOn(performance, 'measure')
    const { markKeystrokeStart, markKeystrokeEnd } = await import('../perf-marks')

    markKeystrokeStart('handleInputChange')
    markKeystrokeEnd('handleInputChange')

    expect(mark).toHaveBeenCalledWith('handleInputChange-start')
    expect(mark).toHaveBeenCalledWith('handleInputChange-end')
    expect(measure).toHaveBeenCalledWith(
      'handleInputChange',
      'handleInputChange-start',
      'handleInputChange-end'
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
