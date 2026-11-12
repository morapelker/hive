import { describe, expect, it } from 'vitest'
import { autoReviewTaskKey, resolveAutoReview } from './auto-review'

describe('automatic Review preference', () => {
  it('preserves legacy behavior and resolves task > project > global', () => {
    expect(resolveAutoReview({}, 'p', 't')).toBe(true)
    const settings = {
      autoReview: false,
      autoReviewProjects: { p: true },
      autoReviewTasks: { [autoReviewTaskKey('p', 't')]: false }
    }
    expect(resolveAutoReview(settings, 'other', 't')).toBe(false)
    expect(resolveAutoReview(settings, 'p', 'other')).toBe(true)
    expect(resolveAutoReview(settings, 'p', 't')).toBe(false)
    settings.autoReview = true
    settings.autoReviewProjects.p = false
    expect(resolveAutoReview(settings, 'p', 't')).toBe(false)
    delete settings.autoReviewTasks[autoReviewTaskKey('p', 't')]
    expect(resolveAutoReview(settings, 'p', 't')).toBe(false)
  })

  it('isolates identical ticket IDs across projects and survives serialization', () => {
    const settings = JSON.parse(
      JSON.stringify({
        autoReviewTasks: { [autoReviewTaskKey('p', 't')]: false }
      })
    )
    expect(resolveAutoReview(settings, 'p', 't')).toBe(false)
    expect(resolveAutoReview(settings, 'q', 't')).toBe(true)
  })
})
