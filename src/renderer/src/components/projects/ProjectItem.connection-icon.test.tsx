/**
 * Wiring only: the sidebar row and the two project pickers put a connection project's member
 * composite in their 16px icon slot. Which tiles it holds is covered by
 * lib/connection-project-icon.test.ts, how they are drawn by ConnectionProjectIcon.test.tsx.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/types/project'
import type { FavoriteTicket } from '../../../../main/db/types'
import { useProjectStore } from '@/stores/useProjectStore'
import { MoveToProjectModal } from '@/components/kanban/MoveToProjectModal'
import { FavoriteTicketCreateModal } from '@/components/kanban/FavoriteTicketCreateModal'
import typescriptIcon from '@/assets/language-icons/typescript.svg'
import pythonIcon from '@/assets/language-icons/python.svg'
import goIcon from '@/assets/language-icons/go.png'
import { LanguageIcon } from './LanguageIcon'
import { ProjectItem } from './ProjectItem'

const now = '2026-01-01T00:00:00.000Z'

const git = (id: string, language: string | null = null): Project => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  description: null,
  tags: null,
  language,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: now,
  last_accessed_at: now
})

const connection = (id: string, memberIds: string[]): Project => ({
  ...git(id),
  kind: 'connection',
  member_project_ids: JSON.stringify(memberIds)
})

const web = git('web', 'typescript')
const api = git('api', 'python')
const docs = git('docs')
const stack = connection('stack', ['web', 'api'])
/** A connection project whose only member has no icon. */
const bare = connection('bare', ['docs'])

const seed = (...projects: Project[]): void => {
  useProjectStore.setState({ projects })
}

/** Change one stored row the way a project edit does: a new row in a new `projects` array. */
const updateStoredProject = (id: string, patch: Partial<Project>): void => {
  act(() => {
    useProjectStore.setState((state) => ({
      projects: state.projects.map((row) => (row.id === id ? { ...row, ...patch } : row))
    }))
  })
}

const compositeIn = (scope: HTMLElement): HTMLElement | null =>
  within(scope).queryByTestId('connection-project-icon')

const linkGlyphIn = (scope: HTMLElement): Element | null => scope.querySelector('svg.lucide-link')

const tileImagesIn = (scope: HTMLElement): Set<string | null> =>
  new Set(Array.from(scope.querySelectorAll('[data-tile] img'), (img) => img.getAttribute('src')))

const expectComposite = (scope: HTMLElement): void => {
  const composite = within(scope).getByTestId('connection-project-icon')
  expect(composite).toHaveAttribute('data-layout', 'box')
  expect(composite.querySelectorAll('[data-tile]')).toHaveLength(2)
  expect(linkGlyphIn(scope)).toBeNull()
}

const expectLanguageLogo = (scope: HTMLElement, language: string, src: string): void => {
  expect(within(scope).getByAltText(language)).toHaveAttribute('src', src)
  expect(compositeIn(scope)).toBeNull()
  expect(linkGlyphIn(scope)).toBeNull()
}

const renderRow = (project: Project): HTMLElement => {
  render(<ProjectItem project={project} />)
  return screen.getByTestId(`project-item-${project.id}`)
}

// The language icon overrides load once per module and re-render late: settle that up front.
beforeAll(async () => {
  render(<LanguageIcon language={null} />).unmount()
  await act(async () => {})
})

// Clicking a row selects and expands its project.
beforeEach(() => {
  useProjectStore.setState({ expandedProjectIds: new Set(), selectedProjectId: null })
})

describe('ProjectItem sidebar icon', () => {
  it('shows the member composite for a connection project whose members have icons', () => {
    seed(web, api, stack)

    expectComposite(renderRow(stack))
  })

  it('keeps the link glyph for a connection project whose members have no icon', () => {
    seed(docs, bare)

    const row = renderRow(bare)

    expect(row.querySelectorAll('svg.lucide-link')).toHaveLength(1)
    expect(compositeIn(row)).toBeNull()
  })

  it('renders a git project as its LanguageIcon, also when a connection project lists it', () => {
    seed(web, api, stack)

    expectLanguageLogo(renderRow(web), 'typescript', typescriptIcon)
  })

  it('still selects the project when its icon is clicked', () => {
    seed(web, api, stack)
    const row = renderRow(stack)

    fireEvent.click(within(row).getByTestId('connection-project-icon'))

    expect(useProjectStore.getState().selectedProjectId).toBe('stack')
  })

  // The row is memo'd and its `project` prop never changes here: the icon follows the store.
  describe('after mount', () => {
    it('swaps the link glyph for the composite once a member gets an icon', () => {
      seed(docs, bare)
      const row = renderRow(bare)
      expect(linkGlyphIn(row)).not.toBeNull()

      updateStoredProject('docs', { language: 'go' })

      expectComposite(row)
    })

    it('redraws the tiles when the member list is edited', () => {
      seed(web, api, git('worker', 'go'), stack)
      const row = renderRow(stack)
      expect(tileImagesIn(row)).toEqual(new Set([typescriptIcon, pythonIcon]))

      updateStoredProject('stack', { member_project_ids: JSON.stringify(['worker', 'web']) })

      expect(tileImagesIn(row)).toEqual(new Set([goIcon, typescriptIcon]))
    })
  })

  // The row itself carries a data-state too (context menu trigger), so look at the icon box.
  describe('members tooltip trigger', () => {
    it('is the icon box of a connection project, whichever icon it holds', () => {
      seed(web, api, stack, docs, bare)
      const stackRow = renderRow(stack)
      const bareRow = renderRow(bare)

      expect(compositeIn(stackRow)?.parentElement).toHaveAttribute('data-state', 'closed')
      // The glyph sits in a box of its own inside the icon box
      expect(linkGlyphIn(bareRow)?.parentElement?.parentElement).toHaveAttribute(
        'data-state',
        'closed'
      )
    })

    it('is not there for a git project', () => {
      seed(web, api, stack)

      const logo = within(renderRow(web)).getByAltText('typescript')

      expect(logo.parentElement).not.toHaveAttribute('data-state')
    })
  })
})

const favorite: FavoriteTicket = {
  id: 'favorite-1',
  title: 'Weekly cleanup',
  description: null,
  goal_mode: false,
  goal_success_criteria: null,
  created_at: now,
  updated_at: now
}

const pickers = [
  {
    name: 'MoveToProjectModal',
    optionId: 'move-to-project-option',
    picker: (
      <MoveToProjectModal
        currentProjectId="current"
        ticketTitle="Fix the thing"
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />
    )
  },
  {
    name: 'FavoriteTicketCreateModal',
    optionId: 'favorite-project-option',
    picker: <FavoriteTicketCreateModal favorite={favorite} open onOpenChange={() => {}} />
  }
]

describe.each(pickers)('$name project options', ({ optionId, picker }) => {
  beforeEach(() => {
    seed(web, api, stack)
    render(picker)
  })

  it('show the member composite for a connection project', () => {
    expectComposite(screen.getByTestId(`${optionId}-stack`))
  })

  it('show the language icon, and no composite, for a git project', () => {
    expectLanguageLogo(screen.getByTestId(`${optionId}-web`), 'typescript', typescriptIcon)
  })
})
