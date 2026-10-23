// "Add database…" in the sidebar's add menu opens the data project wizard (mounted globally in
// AppLayout through useDataProjectStore).

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddProjectButton } from './AddProjectButton'
import { useDataProjectStore } from '@/stores/useDataProjectStore'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  projectToast: { added: vi.fn() }
}))

// floating-ui's top-layer probes are slow under jsdom (see ProjectItem.shell-commands.test.tsx).
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})
afterAll(() => {
  Element.prototype.matches = originalMatches
})

beforeEach(() => {
  useDataProjectStore.getState().reset()
})

describe('AddProjectButton › Add database…', () => {
  it('opens the add database wizard', async () => {
    render(<AddProjectButton />)
    await userEvent.click(screen.getByTestId('add-project-button'))
    const item = await screen.findByTestId('add-project-menu-database')
    expect(item).toHaveTextContent('Add database…')

    await userEvent.click(item)

    expect(useDataProjectStore.getState().wizard).toEqual({ mode: 'create' })
  })
})
