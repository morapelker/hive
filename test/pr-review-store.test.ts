import { beforeEach, describe, expect, test } from 'vitest'
import { usePRReviewStore, UNKNOWN_REVIEWER_KEY } from '../src/renderer/src/stores/usePRReviewStore'
import { useSettingsStore } from '../src/renderer/src/stores/useSettingsStore'

describe('usePRReviewStore', () => {
  beforeEach(() => {
    usePRReviewStore.setState({
      comments: new Map(),
      baseBranch: new Map(),
      loading: new Map(),
      error: new Map(),
      selectedCommentIds: new Set(),
      hiddenReviewers: new Set(),
      attachedComments: []
    })

    useSettingsStore.setState({ locale: 'en' })
  })

  test('keeps hidden unknown reviewers filtered after locale switches', () => {
    usePRReviewStore.setState({
      comments: new Map([
        [
          'wt-1',
          [
            {
              id: 1,
              path: 'src/foo.ts',
              body: 'Unknown reviewer comment',
              bodyHTML: '<p>Unknown reviewer comment</p>',
              createdAt: '2026-03-25T00:00:00Z',
              updatedAt: '2026-03-25T00:00:00Z',
              url: 'https://example.com/comment/1',
              diffHunk: '@@',
              position: 1,
              originalPosition: 1,
              line: 10,
              originalLine: 10,
              side: 'RIGHT',
              commitId: 'abc123',
              originalCommitId: 'abc123',
              pullRequestReviewId: 1,
              inReplyToId: null,
              startLine: null,
              originalStartLine: null,
              startSide: null,
              authorAssociation: 'NONE',
              user: null
            }
          ]
        ]
      ])
    })

    usePRReviewStore.getState().toggleReviewer(UNKNOWN_REVIEWER_KEY)
    expect(usePRReviewStore.getState().getVisibleComments('wt-1')).toHaveLength(0)

    useSettingsStore.setState({ locale: 'zh-CN' })

    expect(usePRReviewStore.getState().getVisibleComments('wt-1')).toHaveLength(0)
    expect(usePRReviewStore.getState().getUniqueReviewers('wt-1')).toEqual([
      { login: UNKNOWN_REVIEWER_KEY, count: 1 }
    ])
  })
})
