import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ScrollTagGutter } from '../ScrollTagGutter'
import { useScrollTagStore, type ScrollTag } from '@/stores/useScrollTagStore'
import type {
  VirtualizedMessageListHandle,
  VirtualizedMessageListViewportAnchor
} from '../VirtualizedMessageList'

const ANCHOR: VirtualizedMessageListViewportAnchor = {
  itemKey: 'message:msg_1',
  offsetWithinItem: 10,
  fallbackScrollTop: 100,
  fallbackScrollHeight: 1000
}

function makeHandle(
  overrides: Partial<VirtualizedMessageListHandle> = {}
): VirtualizedMessageListHandle {
  const handle: VirtualizedMessageListHandle = {
    scrollToEnd: vi.fn(),
    captureViewportAnchor: vi.fn(() => ANCHOR),
    captureAnchorAtFraction: vi.fn(() => ANCHOR),
    restoreViewportAnchor: vi.fn(() => true),
    getAnchorFraction: vi.fn(() => 0.25),
    getAnchorFractions: vi.fn((anchors: readonly unknown[]) => anchors.map(() => 0.25)),
    ...overrides
  }
  return handle
}

function renderGutter(
  handle: VirtualizedMessageListHandle,
  scrollElement?: HTMLDivElement,
  onWheelIntent?: () => void
) {
  const listRef = { current: handle }
  return render(
    <ScrollTagGutter
      sessionId="session-test"
      listRef={listRef}
      scrollElement={scrollElement ?? null}
      onWheelIntent={onWheelIntent}
      totalSize={1000}
    />
  )
}

function seedTag(overrides: Partial<ScrollTag> = {}): ScrollTag {
  const tag: ScrollTag = {
    id: overrides.id ?? 'tag-1',
    color: overrides.color ?? '#ef4444',
    anchor: overrides.anchor ?? ANCHOR,
    fractionHint: overrides.fractionHint ?? 0.25,
    createdAt: overrides.createdAt ?? 1
  }
  useScrollTagStore.getState().addTag('session-test', tag)
  return tag
}

describe('ScrollTagGutter', () => {
  beforeEach(() => {
    localStorage.clear()
    useScrollTagStore.setState({ tagsBySession: {} })
  })

  it('does not cover the 12px scrollbar band', () => {
    renderGutter(makeHandle())
    expect(screen.getByTestId('scroll-tag-gutter').className).toContain('right-[12px]')
  })

  it('stacks below the z-10 scroll-to-bottom FAB', () => {
    renderGutter(makeHandle())
    expect(screen.getByTestId('scroll-tag-gutter').className).toContain('z-[9]')
  })

  it('forwards wheel events to the scroll element', () => {
    const scrollElement = document.createElement('div')
    scrollElement.scrollBy = vi.fn()
    renderGutter(makeHandle(), scrollElement)

    fireEvent.wheel(screen.getByTestId('scroll-tag-gutter'), { deltaY: 42, deltaX: 0 })

    expect(scrollElement.scrollBy).toHaveBeenCalledWith({ top: 42, left: 0 })
  })

  it('signals manual-scroll intent before forwarding a wheel scroll', () => {
    const scrollElement = document.createElement('div')
    const calls: string[] = []
    scrollElement.scrollBy = vi.fn(() => calls.push('scrollBy')) as never
    const onWheelIntent = vi.fn(() => calls.push('intent'))
    renderGutter(makeHandle(), scrollElement, onWheelIntent)

    fireEvent.wheel(screen.getByTestId('scroll-tag-gutter'), { deltaY: -30 })

    expect(onWheelIntent).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['intent', 'scrollBy'])
  })

  it('adds no tag when no stable anchor is available', async () => {
    const handle = makeHandle({ captureAnchorAtFraction: vi.fn(() => null) })
    renderGutter(handle)

    const strip = screen.getByTestId('scroll-tag-gutter').firstElementChild as HTMLElement
    fireEvent.contextMenu(strip, { clientY: 50 })
    fireEvent.click(await screen.findByText('Tag this spot'))

    expect(screen.queryByTestId('scroll-tag-marker')).not.toBeInTheDocument()
    expect(useScrollTagStore.getState().tagsBySession['session-test']).toBeUndefined()
  })

  it('right-click → "Tag this spot" captures an anchor at the clicked fraction and adds a marker', async () => {
    const handle = makeHandle()
    renderGutter(handle)

    const strip = screen.getByTestId('scroll-tag-gutter').firstElementChild as HTMLElement
    fireEvent.contextMenu(strip, { clientY: 50 })

    fireEvent.click(await screen.findByText('Tag this spot'))

    expect(handle.captureAnchorAtFraction).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('scroll-tag-marker')).toBeInTheDocument()
    })
    expect(useScrollTagStore.getState().tagsBySession['session-test']).toHaveLength(1)
  })

  it('clicking a marker restores its anchor', () => {
    const handle = makeHandle()
    const tag = seedTag()
    renderGutter(handle)

    fireEvent.click(screen.getByTestId('scroll-tag-marker'))

    expect(handle.restoreViewportAnchor).toHaveBeenCalledWith(tag.anchor)
  })

  it('re-validates the anchor at click time even when the marker rendered as active', () => {
    // Batch lookup said the marker is active, but the anchor has since become
    // unresolvable (message replaced without a totalSize change).
    const handle = makeHandle({ getAnchorFraction: vi.fn(() => null) })
    seedTag()
    renderGutter(handle)

    fireEvent.click(screen.getByTestId('scroll-tag-marker'))

    expect(handle.restoreViewportAnchor).not.toHaveBeenCalled()
  })

  it('a stale marker (unresolvable anchor) does not jump on click', () => {
    const handle = makeHandle({
      getAnchorFractions: vi.fn((anchors: readonly unknown[]) => anchors.map(() => null))
    })
    seedTag()
    renderGutter(handle)

    fireEvent.click(screen.getByTestId('scroll-tag-marker'))

    expect(handle.restoreViewportAnchor).not.toHaveBeenCalled()
  })

  it('a stale marker has "Go to tag" disabled but "Delete tag" enabled', async () => {
    const handle = makeHandle({
      getAnchorFractions: vi.fn((anchors: readonly unknown[]) => anchors.map(() => null))
    })
    seedTag()
    renderGutter(handle)

    fireEvent.contextMenu(screen.getByTestId('scroll-tag-marker'))

    const goTo = await screen.findByText('Go to tag')
    expect(goTo.closest('[role="menuitem"]')).toHaveAttribute('data-disabled')
    const del = screen.getByText('Delete tag')
    expect(del.closest('[role="menuitem"]')).not.toHaveAttribute('data-disabled')
  })

  it('viewing a session with tags refreshes its LRU recency', () => {
    // session-test seeded first (older), then another session (newer).
    seedTag()
    useScrollTagStore.getState().addTag('session-other', {
      id: 'other-tag',
      color: '#3b82f6',
      anchor: ANCHOR,
      fractionHint: 0.5,
      createdAt: 2
    })
    expect(Object.keys(useScrollTagStore.getState().tagsBySession)).toEqual([
      'session-test',
      'session-other'
    ])

    renderGutter(makeHandle())

    expect(Object.keys(useScrollTagStore.getState().tagsBySession)).toEqual([
      'session-other',
      'session-test'
    ])
  })

  it('deletes a tag via the marker context menu', async () => {
    const handle = makeHandle()
    seedTag()
    renderGutter(handle)

    fireEvent.contextMenu(screen.getByTestId('scroll-tag-marker'))
    fireEvent.click(await screen.findByText('Delete tag'))

    await waitFor(() => {
      expect(screen.queryByTestId('scroll-tag-marker')).not.toBeInTheDocument()
    })
    expect(useScrollTagStore.getState().tagsBySession['session-test']).toBeUndefined()
  })
})
