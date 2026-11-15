import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectApi } from '@/api/project-api'
import goLogo from '@/assets/language-icons/go.png'
import pythonLogo from '@/assets/language-icons/python.svg'
import typescriptLogo from '@/assets/language-icons/typescript.svg'
import { useConnectionIconMembers } from '@/hooks/useConnectionProjectIcon'
import { useProjectStore } from '@/stores/useProjectStore'
import type { Project } from '@shared/types/project'
import {
  ConnectionMembersTooltip,
  ConnectionProjectIcon,
  ProjectIcon
} from './ConnectionProjectIcon'
import { LanguageIcon } from './LanguageIcon'

// Radix's popper (the tooltip) measures with a ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

// Radix's popper asks these on every positioning pass and jsdom takes seconds to answer each.
const TOP_LAYER_SELECTOR = /^:(popover-open|modal|fullscreen)$/
const nativeMatches = Element.prototype.matches
beforeAll(() => {
  Element.prototype.matches = function matches(this: Element, selectors: string): boolean {
    return TOP_LAYER_SELECTOR.test(selectors) ? false : nativeMatches.call(this, selectors)
  }
})
afterAll(() => {
  Element.prototype.matches = nativeMatches
})

// A "slow-" file / "/slow/" path stays pending until the test releases it.
const gates = vi.hoisted(() => {
  const openers = new Map<string, () => void>()
  return {
    wait: (key: string): Promise<void> => new Promise((resolve) => openers.set(key, resolve)),
    release: (key: string): void => openers.get(key)?.()
  }
})

// The icon caches are module-level, so every test uses its own filenames / paths.
// "ok-"/"slow-" files and "/ok/"-"/slow/" paths resolve to a data URL; anything else is missing.
vi.mock('@/api/project-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/project-api')>()
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      loadLanguageIcons: vi.fn(async () => ({})),
      getProjectIconPath: vi.fn(async (filename: string) => {
        if (filename.startsWith('slow-')) await gates.wait(filename)
        return /^(ok|slow)-/.test(filename) ? `data:custom/${filename}` : null
      }),
      getAbsoluteIconDataUrl: vi.fn(async (iconPath: string) => {
        if (iconPath.startsWith('/slow/')) await gates.wait(iconPath)
        return /^\/(ok|slow)\//.test(iconPath) ? `data:detected${iconPath}` : null
      })
    }
  }
})

const makeProject = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  name: `name-${id}`,
  path: `/tmp/${id}`,
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const makeConnection = (id: string, memberIds: string[], extra: Partial<Project> = {}): Project =>
  makeProject(id, { kind: 'connection', member_project_ids: JSON.stringify(memberIds), ...extra })

const TS = makeProject('ts', { language: 'typescript' })
const PY = makeProject('py', { language: 'python' })
const GO = makeProject('go', { language: 'go' })
const RS = makeProject('rs', { language: 'rust' })
const PLAIN = makeProject('plain')

const seed = (...projects: Project[]): void => {
  useProjectStore.setState({ projects })
}

/** Let every pending icon lookup (mocked RPC promise chains) land. */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

const tilesOf = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-tile]'))

/** A tile as its image src, "badge:<text>" or "generic". */
const describeTile = (tile: HTMLElement): string => {
  const kind = tile.getAttribute('data-tile')
  if (kind === 'image') return tile.querySelector('img')?.getAttribute('src') ?? ''
  return kind === 'badge' ? `badge:${tile.textContent}` : String(kind)
}

/** The tiles of a composite icon, described in member order. */
const tiles = (testId = 'connection-project-icon'): string[] => {
  const root = screen.getByTestId(testId)
  const described = tilesOf(root).map(describeTile)
  // The box paints its second (back) tile first.
  return root.getAttribute('data-layout') === 'box' ? described.reverse() : described
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useProjectStore.setState({ projects: [] })
})

describe('ConnectionProjectIcon', () => {
  // Keep this test first: no tile has mounted yet, so the one-off (module-cached)
  // loadLanguageIcons call has not happened and "no icon call" covers it too.
  it.each([
    ['no member has an icon', 'iconless'],
    ["its only member's language is an inherited key, not a language", 'inherited'],
    ['its members no longer exist', 'orphaned'],
    ['the id is unknown', 'nope'],
    ['the project is a git project', 'git']
  ])('renders only the fallback and makes no icon call when %s', async (_label, projectId) => {
    seed(
      makeConnection('iconless', ['plain']),
      makeConnection('inherited', ['ctor']),
      makeConnection('orphaned', ['gone-1', 'gone-2']),
      makeProject('git', { kind: 'git', member_project_ids: '["filed"]' }),
      PLAIN,
      makeProject('ctor', { language: 'constructor' }),
      makeProject('filed', { custom_icon: 'ok-unused.png', detected_icon: '/ok/unused/fav.ico' })
    )

    const bare = render(<ConnectionProjectIcon projectId={projectId} />)
    const withFallback = render(<ConnectionProjectIcon projectId={projectId} fallback="no icon" />)
    await settle()

    expect(bare.container).toBeEmptyDOMElement()
    expect(withFallback.container.innerHTML).toBe('no icon')
    expect(projectApi.getProjectIconPath).not.toHaveBeenCalled()
    expect(projectApi.getAbsoluteIconDataUrl).not.toHaveBeenCalled()
    expect(projectApi.loadLanguageIcons).not.toHaveBeenCalled()
  })

  describe('box layout', () => {
    it('is the default: an aria-hidden 16px square with two 9px tiles on its diagonal', async () => {
      seed(makeConnection('conn', ['ts', 'py']), TS, PY)

      render(<ConnectionProjectIcon projectId="conn" />)
      await settle()

      const root = screen.getByTestId('connection-project-icon')
      expect(root).toHaveAttribute('aria-hidden', 'true')
      expect(root).toHaveAttribute('data-layout', 'box')
      expect(root).toHaveClass('size-4')

      // The second member's tile comes first in the DOM, so the first member's is painted on top.
      const [back, front, ...extra] = tilesOf(root)
      expect(extra).toEqual([])
      expect([front, back].map(describeTile)).toEqual([typescriptLogo, pythonLogo])
      for (const tile of [front, back]) {
        expect(tile).toHaveStyle({ position: 'absolute', width: '9px', height: '9px' })
      }
      expect(front).toHaveStyle({ left: '0px', top: '0px' })
      expect(front.style.clipPath).toBe('')
      expect(back).toHaveStyle({ left: '7px', top: '7px' })
      // A 3px notch: the corner under the front tile, 1px wider than the 2px overlap.
      expect(back.style.clipPath).toBe('polygon(3px 0, 100% 0, 100% 100%, 0 100%, 0 3px, 3px 3px)')
    })

    it("holds 2 tiles however many unique icons there are, a member's own image ahead of a logo", async () => {
      const own = makeProject('own', { detected_icon: '/ok/box/fav.ico' })
      seed(makeConnection('conn', ['ts', 'py', 'own', 'rs']), TS, PY, own, RS)

      render(<ConnectionProjectIcon projectId="conn" layout="box" />)
      await settle()

      // Asking for 3 tiles and drawing the first 2 would show the python logo instead.
      expect(tiles()).toEqual([typescriptLogo, 'data:detected/ok/box/fav.ico'])
    })
  })

  describe('strip layout', () => {
    it('is an aria-hidden row of up to 3 tiles of 12px, in member order', async () => {
      // Stored member order decides the tile order, not the order of the rows.
      seed(makeConnection('conn', ['go', 'ts', 'py', 'rs']), TS, PY, GO, RS)

      render(<ConnectionProjectIcon projectId="conn" layout="strip" />)
      await settle()

      const root = screen.getByTestId('connection-project-icon')
      expect(root).toHaveAttribute('aria-hidden', 'true')
      expect(root).toHaveAttribute('data-layout', 'strip')
      expect(tiles()).toEqual([goLogo, typescriptLogo, pythonLogo])
      for (const tile of tilesOf(root)) {
        expect(tile).toHaveStyle({ width: '12px', height: '12px' })
      }
    })

    it('shows 2 tiles when the members have only 2 unique icons', async () => {
      seed(makeConnection('conn', ['ts', 'py', 'ts-2']), TS, PY, { ...TS, id: 'ts-2' })

      render(<ConnectionProjectIcon projectId="conn" layout="strip" />)
      await settle()

      expect(tiles()).toEqual([typescriptLogo, pythonLogo])
    })
  })

  describe('tiles', () => {
    it('shows the language logo while a file loads, then the file as a decorative image', async () => {
      seed(
        makeConnection('conn', ['a', 'b']),
        makeProject('a', { language: 'typescript', custom_icon: 'slow-load.png' }),
        makeProject('b', { language: 'python', detected_icon: '/slow/load/fav.ico' })
      )

      const { container } = render(<ConnectionProjectIcon projectId="conn" />)
      await settle()
      expect(tiles()).toEqual([typescriptLogo, pythonLogo])

      gates.release('slow-load.png')
      gates.release('/slow/load/fav.ico')
      await settle()
      expect(tiles()).toEqual(['data:custom/slow-load.png', 'data:detected/slow/load/fav.ico'])
      container.querySelectorAll('img').forEach((img) => {
        expect(img).toHaveAttribute('alt', '')
        expect(img).toHaveAttribute('draggable', 'false')
        expect(img).not.toHaveAttribute('title')
      })
    })

    it('shows the language logo when a file is missing', async () => {
      seed(
        makeConnection('conn', ['a', 'b']),
        makeProject('a', { language: 'typescript', custom_icon: 'missing-tile.png' }),
        makeProject('b', { language: 'python', detected_icon: '/missing/tile/fav.ico' })
      )

      render(<ConnectionProjectIcon projectId="conn" />)
      await settle()

      expect(projectApi.getProjectIconPath).toHaveBeenCalledWith('missing-tile.png')
      expect(projectApi.getAbsoluteIconDataUrl).toHaveBeenCalledWith('/missing/tile/fav.ico')
      expect(tiles()).toEqual([typescriptLogo, pythonLogo])
    })

    it('draws a language without a bundled logo as a badge: one letter in the box, the full label in the strip', async () => {
      seed(makeConnection('conn', ['php', 'ts']), makeProject('php', { language: 'php' }), TS)

      render(
        <>
          <ConnectionProjectIcon projectId="conn" data-testid="box" />
          <ConnectionProjectIcon projectId="conn" layout="strip" data-testid="strip" />
        </>
      )
      await settle()

      expect(tiles('box')).toEqual(['badge:P', typescriptLogo])
      expect(tiles('strip')).toEqual(['badge:PH', typescriptLogo])
    })

    it('puts a generic plate next to a single unique icon', async () => {
      seed(makeConnection('conn', ['ts']), TS)

      render(<ConnectionProjectIcon projectId="conn" />)
      await settle()

      expect(tiles()).toEqual([typescriptLogo, 'generic'])
    })
  })

  describe('reactivity', () => {
    it("follows a member's custom icon changing", async () => {
      const conn = makeConnection('conn', ['ts', 'py'])
      seed(conn, TS, PY)

      render(<ConnectionProjectIcon projectId="conn" />)
      await settle()
      expect(tiles()).toEqual([typescriptLogo, pythonLogo])

      act(() => seed(conn, { ...TS, custom_icon: 'ok-reactive.png' }, PY))
      await settle()

      expect(tiles()).toEqual(['data:custom/ok-reactive.png', pythonLogo])
    })

    it('follows the member list being edited', async () => {
      seed(makeConnection('conn', ['ts', 'py']), TS, PY, GO)

      render(<ConnectionProjectIcon projectId="conn" layout="strip" />)
      await settle()
      expect(tiles()).toEqual([typescriptLogo, pythonLogo])

      act(() => seed(makeConnection('conn', ['go', 'ts', 'py']), TS, PY, GO))
      await settle()

      expect(tiles()).toEqual([goLogo, typescriptLogo, pythonLogo])
    })

    it('keeps the same members array when the rows are replaced by equal ones', () => {
      const conn = makeConnection('conn', ['ts', 'py'])
      seed(conn, TS, PY)

      const { result, rerender } = renderHook(() => useConnectionIconMembers('conn'))
      const first = result.current
      expect(first.map((member) => member.id)).toEqual(['ts', 'py'])

      act(() => seed({ ...conn }, { ...TS }, { ...PY }))
      rerender()

      expect(result.current).toBe(first)
    })
  })

  it('looks a file up once for all the icons mounted together that need it', async () => {
    seed(
      makeConnection('conn', ['a', 'b']),
      makeProject('a', { custom_icon: 'slow-dup.png' }),
      makeProject('b', { detected_icon: '/slow/dup/fav.ico' })
    )

    render(
      <>
        <ConnectionProjectIcon projectId="conn" data-testid="box" />
        <ConnectionProjectIcon projectId="conn" layout="strip" data-testid="strip" />
      </>
    )
    await settle()

    expect(vi.mocked(projectApi.getProjectIconPath).mock.calls).toEqual([['slow-dup.png']])
    expect(vi.mocked(projectApi.getAbsoluteIconDataUrl).mock.calls).toEqual([['/slow/dup/fav.ico']])

    gates.release('slow-dup.png')
    gates.release('/slow/dup/fav.ico')
    await settle()
    const resolved = ['data:custom/slow-dup.png', 'data:detected/slow/dup/fav.ico']
    expect(tiles('box')).toEqual(resolved)
    expect(tiles('strip')).toEqual(resolved)
  })
})

describe('ProjectIcon', () => {
  it.each<[string, Partial<Project>]>([
    ['a language logo', { language: 'typescript' }],
    ['a custom icon file', { custom_icon: 'ok-git-custom.png' }],
    ['a favicon', { detected_icon: '/ok/git/fav.ico' }]
  ])('renders a git project with %s exactly as LanguageIcon does', async (_label, fields) => {
    const project = makeProject('git', fields)

    const actual = render(<ProjectIcon project={project} />)
    const expected = render(
      <LanguageIcon
        language={project.language}
        customIcon={project.custom_icon}
        detectedIcon={project.detected_icon}
      />
    )
    await settle()

    expect(actual.container.querySelector('img')).not.toBeNull()
    expect(actual.container.innerHTML).toBe(expected.container.innerHTML)
  })

  describe('for a connection project', () => {
    it('shows its own custom icon as a single image when the file resolves', async () => {
      const conn = makeConnection('conn', ['ts', 'py'], { custom_icon: 'ok-own.png' })
      seed(conn, TS, PY)

      const { container } = render(<ProjectIcon project={conn} />)
      await settle()

      expect(screen.getByAltText('project icon')).toHaveAttribute('src', 'data:custom/ok-own.png')
      expect(container.querySelectorAll('img')).toHaveLength(1)
      expect(screen.queryByTestId('connection-project-icon')).toBeNull()
    })

    it('shows the composite when its own custom icon file is missing', async () => {
      const conn = makeConnection('conn', ['ts', 'py'], { custom_icon: 'missing-own.png' })
      seed(conn, TS, PY)

      render(<ProjectIcon project={conn} />)
      await settle()

      expect(screen.queryByAltText('project icon')).toBeNull()
      expect(tiles()).toEqual([typescriptLogo, pythonLogo])
    })

    it('falls back to the composite when its custom icon changes to a missing file', async () => {
      const conn = makeConnection('conn', ['ts', 'py'], { custom_icon: 'ok-replaced.png' })
      seed(conn, TS, PY)

      const { rerender } = render(<ProjectIcon project={conn} />)
      await settle()
      expect(screen.getByAltText('project icon')).toBeInTheDocument()

      rerender(<ProjectIcon project={{ ...conn, custom_icon: 'missing-replaced.png' }} />)
      await settle()

      expect(screen.queryByAltText('project icon')).toBeNull()
      expect(tiles()).toEqual([typescriptLogo, pythonLogo])
    })

    it('keeps the link glyph in a 16px box when no member has an icon', async () => {
      const conn = makeConnection('conn', ['plain'])
      seed(conn, PLAIN)

      const { container } = render(<ProjectIcon project={conn} />)
      await settle()

      const box = container.firstElementChild
      expect(box).toHaveClass('size-4')
      expect(box?.querySelector('svg.lucide-link')).not.toBeNull()
      expect(container.querySelector('[data-tile]')).toBeNull()
    })
  })
})

describe('ConnectionMembersTooltip', () => {
  const renderTooltip = (): void => {
    render(
      <ConnectionMembersTooltip projectId="conn">
        <button data-testid="target">target</button>
      </ConnectionMembersTooltip>
    )
  }

  /** Hover the target and wait for the legend (it opens after a 350ms delay). */
  const hoverOpen = async (): Promise<HTMLElement> => {
    await userEvent.setup().hover(screen.getByTestId('target'))
    const legend = await screen.findByTestId('connection-members-tooltip', {}, { timeout: 3000 })
    await settle()
    return legend
  }

  /** The legend's member rows, top to bottom, as [name, icon]. */
  const rows = (legend: HTMLElement): (string | null | undefined)[][] =>
    tilesOf(legend).map((tile) => [tile.parentElement?.textContent, describeTile(tile)])

  it('renders its children bare when no member resolves', () => {
    seed(makeConnection('conn', ['gone']), TS)

    renderTooltip()

    expect(screen.getByTestId('target')).not.toHaveAttribute('data-state')
  })

  it('on hover names every member next to its icon, in a legend that takes no pointer events', async () => {
    seed(makeConnection('conn', ['py', 'plain', 'ts']), TS, PY, PLAIN)

    renderTooltip()
    expect(screen.getByTestId('target')).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByRole('tooltip')).toBeNull()

    const legend = await hoverOpen()

    expect(legend).toHaveAttribute('role', 'tooltip')
    expect(legend).toHaveClass('pointer-events-none')
    expect(within(legend).getByText('Connects 3 projects')).toBeInTheDocument()
    expect(rows(legend)).toEqual([
      ['name-py', pythonLogo],
      ['name-plain', 'generic'],
      ['name-ts', typescriptLogo]
    ])
  })

  it('uses the singular for a single member', async () => {
    seed(makeConnection('conn', ['ts']), TS)

    renderTooltip()
    const legend = await hoverOpen()

    expect(within(legend).getByText('Connects 1 project')).toBeInTheDocument()
  })

  it('lists the first 8 of 9 members and "and 1 more"', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']
    seed(makeConnection('conn', ids), ...ids.map((id) => makeProject(id)))

    renderTooltip()
    const legend = await hoverOpen()

    expect(within(legend).getByText('Connects 9 projects')).toBeInTheDocument()
    expect(rows(legend).map(([name]) => name)).toEqual(ids.slice(0, 8).map((id) => `name-${id}`))
    expect(within(legend).getByText('and 1 more')).toBeInTheDocument()
  })
})
