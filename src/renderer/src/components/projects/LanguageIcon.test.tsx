import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectApi } from '@/api/project-api'
import { LanguageIcon } from './LanguageIcon'

// The icon caches are module-level, so every test uses its own filenames / paths.
// "ok-" custom icons and "/ok/" favicons resolve to a data URL; everything else is missing.
vi.mock('@/api/project-api', () => ({
  projectApi: {
    loadLanguageIcons: vi.fn(async () => ({ ruby: 'data:override/ruby' })),
    getProjectIconPath: vi.fn(async (filename: string) =>
      filename.startsWith('ok-') ? `data:custom/${filename}` : null
    ),
    getAbsoluteIconDataUrl: vi.fn(async (iconPath: string) =>
      iconPath.startsWith('/ok/') ? `data:detected${iconPath}` : null
    )
  }
}))

describe('LanguageIcon', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the custom project icon ahead of everything else', async () => {
    render(
      <LanguageIcon language="typescript" customIcon="ok-a.png" detectedIcon="/ok/a/favicon.ico" />
    )

    const icon = await screen.findByAltText('project icon')
    expect(icon).toHaveAttribute('src', 'data:custom/ok-a.png')
    expect(icon).toHaveAttribute('title', 'Custom project icon')
    expect(icon).toHaveClass('h-4', 'w-4', 'shrink-0', 'object-contain', 'rounded-sm')
    expect(screen.queryByAltText('project favicon')).toBeNull()
    expect(screen.queryByAltText('typescript')).toBeNull()
  })

  it('shows the detected favicon when there is no custom icon', async () => {
    render(<LanguageIcon language="typescript" detectedIcon="/ok/b/favicon.ico" />)

    const icon = await screen.findByAltText('project favicon')
    expect(icon).toHaveAttribute('src', 'data:detected/ok/b/favicon.ico')
    expect(icon).toHaveAttribute('title', 'Auto-detected favicon')
    expect(icon).toHaveClass('h-4', 'w-4', 'shrink-0', 'object-contain', 'rounded-sm')
    expect(projectApi.getProjectIconPath).not.toHaveBeenCalled()
  })

  it('falls back to the favicon when the custom icon file is missing', async () => {
    render(
      <LanguageIcon language="go" customIcon="missing-c.png" detectedIcon="/ok/c/favicon.ico" />
    )

    expect(await screen.findByAltText('project favicon')).toHaveAttribute(
      'src',
      'data:detected/ok/c/favicon.ico'
    )
    expect(screen.queryByAltText('project icon')).toBeNull()
  })

  it("treats the 'none' favicon sentinel as no favicon", () => {
    render(<LanguageIcon language="go" detectedIcon="none" />)

    expect(screen.getByAltText('go')).toBeInTheDocument()
    expect(projectApi.getAbsoluteIconDataUrl).not.toHaveBeenCalled()
  })

  it('shows the language icon while a project image is still loading or missing', () => {
    render(
      <LanguageIcon language="python" customIcon="missing-d.png" detectedIcon="/missing/d.ico" />
    )

    const icon = screen.getByAltText('python')
    expect(icon).toHaveAttribute('title', 'python')
    expect(icon.getAttribute('src')).toBeTruthy()
    expect(icon).toHaveClass('h-4', 'w-4', 'shrink-0', 'object-contain')
    expect(icon).not.toHaveClass('rounded-sm')
  })

  it('prefers a user-override language icon over the bundled one and the badge', async () => {
    render(<LanguageIcon language="ruby" />)

    const icon = await screen.findByAltText('ruby')
    expect(icon).toHaveAttribute('src', 'data:override/ruby')
    expect(icon).toHaveAttribute('title', 'ruby')
  })

  it('renders a colored badge for a language without a bundled icon', () => {
    const { container } = render(<LanguageIcon language="php" />)

    const badge = screen.getByTitle('php')
    expect(badge.tagName).toBe('DIV')
    expect(badge).toHaveClass('h-4', 'w-4', 'shrink-0', 'rounded-sm', 'bg-indigo-500')
    expect(badge).toHaveTextContent('PH')
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the generic folder glyph without a language', () => {
    const { container } = render(<LanguageIcon language={null} />)

    const glyph = container.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph).toHaveClass('h-4', 'w-4', 'text-muted-foreground', 'shrink-0')
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the generic folder glyph for an unknown language', () => {
    const { container } = render(<LanguageIcon language="cobol" />)

    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('merges className into images but replaces the folder glyph defaults', () => {
    const { container, rerender } = render(<LanguageIcon language="go" className="h-5 w-5" />)

    const icon = screen.getByAltText('go')
    expect(icon).toHaveClass('h-5', 'w-5', 'shrink-0', 'object-contain')
    expect(icon).not.toHaveClass('h-4')

    rerender(<LanguageIcon language={null} className="h-5 w-5" />)
    const glyph = container.querySelector('svg')
    expect(glyph).toHaveClass('h-5', 'w-5')
    expect(glyph).not.toHaveClass('text-muted-foreground')
  })
})
