import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScrollToBottomFab } from '../../../src/renderer/src/components/sessions/ScrollToBottomFab'

/**
 * Session 5: ScrollToBottomFab Component
 *
 * These tests verify the ScrollToBottomFab component:
 * - Renders with an ArrowDown icon and correct aria-label
 * - Visible/hidden states controlled by the `visible` prop
 * - Calls onClick when clicked while visible
 * - Not clickable when hidden (pointer-events-none)
 * - Positioned absolutely for fixed viewport placement
 *
 * Also verifies SessionView integration:
 * - ScrollToBottomFab is imported and rendered in SessionView
 * - FAB is placed outside the scroll container (sibling, not child)
 * - Parent wrapper has position: relative for absolute positioning
 */

describe('Session 5: ScrollToBottomFab', () => {
  describe('ScrollToBottomFab component', () => {
    test('renders with ArrowDown icon and aria-label', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button).toBeDefined()
      expect(button.getAttribute('aria-label')).toBe('Scroll to bottom')

      // Verify the SVG icon is rendered (lucide-react ArrowDown)
      const svg = button.querySelector('svg')
      expect(svg).not.toBeNull()
    })

    test('visible when visible=true', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('opacity-100')
      expect(button.className).not.toContain('pointer-events-none')
    })

    test('hidden when visible=false', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={false} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('opacity-0')
      expect(button.className).toContain('pointer-events-none')
    })

    test('calls onClick when clicked', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      fireEvent.click(button)
      expect(onClick).toHaveBeenCalledTimes(1)
    })

    test('has translate-y-0 when visible', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('translate-y-0')
    })

    test('has translate-y-2 when hidden (slide-up animation)', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={false} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('translate-y-2')
    })

    test('has transition-all duration-200 for smooth animation', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('transition-all')
      expect(button.className).toContain('duration-200')
    })

    test('has absolute positioning classes', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('absolute')
      expect(button.className).toContain('bottom-4')
      expect(button.className).toContain('right-4')
      expect(button.className).toContain('z-10')
    })

    test('has backdrop blur and border styling', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('backdrop-blur-sm')
      expect(button.className).toContain('border')
      expect(button.className).toContain('rounded-full')
      expect(button.className).toContain('shadow-md')
    })
  })

  describe('FAB integration in SessionView', () => {
    test('SessionView imports and renders ScrollToBottomFab', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Imports the component
      expect(source).toContain("import { ScrollToBottomFab } from './ScrollToBottomFab'")

      // Renders it with correct props
      expect(source).toContain('<ScrollToBottomFab')
      expect(source).toContain('onClick={handleScrollToBottomClick}')
      expect(source).toContain('visible={showScrollFab}')
    })

    test('FAB is rendered outside the scroll container (sibling)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // The scroll container closes (</div>) before the FAB is rendered.
      // Pattern: the scroll container div with ref={scrollContainerRef}
      // is followed by the closing </div>, then the ScrollToBottomFab.
      // This ensures the FAB does NOT scroll with the content.
      const scrollContainerEnd = source.indexOf('ref={scrollContainerRef}')
      const fabStart = source.indexOf('<ScrollToBottomFab')
      expect(scrollContainerEnd).toBeGreaterThan(-1)
      expect(fabStart).toBeGreaterThan(scrollContainerEnd)

      // The FAB appears after the scroll container's closing tag
      // Find the closing </div> of the scroll container between the ref and FAB
      const sectionBetween = source.slice(scrollContainerEnd, fabStart)
      // Count opening and closing divs — the scroll container's closing div should be in this section
      const openDivs = (sectionBetween.match(/<div/g) || []).length
      const closeDivs = (sectionBetween.match(/<\/div>/g) || []).length
      // The scroll container opens (counted as 0 since ref is on the same div)
      // so closeDivs should be >= openDivs (meaning the container is fully closed)
      expect(closeDivs).toBeGreaterThanOrEqual(openDivs)
    })

    test('FAB parent wrapper has relative positioning', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // The wrapper div containing both the scroll container and FAB
      // should have 'relative' for absolute positioning of FAB
      expect(source).toContain('relative flex-1 min-h-0')

      // The scroll container inside uses h-full overflow-y-auto
      expect(source).toContain('h-full overflow-y-auto')
    })

    test('ArrowDown is NOT imported directly in SessionView (delegated to ScrollToBottomFab)', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/SessionView.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // ArrowDown should NOT be in the lucide-react import line of SessionView
      const lucideImport = source.match(/import\s*\{[^}]*\}\s*from\s*'lucide-react'/)
      expect(lucideImport).not.toBeNull()
      expect(lucideImport![0]).not.toContain('ArrowDown')
    })
  })

  describe('ScrollToBottomFab.tsx source verification', () => {
    test('component file exists and has correct structure', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/ScrollToBottomFab.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Imports
      expect(source).toContain("import { ArrowDown } from 'lucide-react'")
      expect(source).toContain("import { cn } from '@/lib/utils'")

      // Props interface
      expect(source).toContain('interface ScrollToBottomFabProps')
      expect(source).toContain('onClick: () => void')
      expect(source).toContain('visible: boolean')

      // Export
      expect(source).toContain('export function ScrollToBottomFab')

      // Accessibility
      expect(source).toContain('aria-label="Scroll to bottom"')
      expect(source).toContain('data-testid="scroll-to-bottom-fab"')

      // Conditional classes
      expect(source).toContain('opacity-100')
      expect(source).toContain('opacity-0')
      expect(source).toContain('pointer-events-none')
      expect(source).toContain('translate-y-0')
      expect(source).toContain('translate-y-2')
    })
  })
})
