// "What the agent receives" for a ticket of an orchestrator: the board ticket word for word,
// then the run's rules in a block of their own. On a connection project the member folders
// are only known from the launch on, so before it the preview says the run will name them.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { resolvePreferredAgentSdk } from '@/stores/useSettingsStore'
import { buildTicketRunPrompt } from '@shared/document-flow/prompts'
import type { KanbanTicket } from '../../../../main/db/types'
import { makeItem, makeRun } from './test-fixtures'
import { TicketRunBriefPreview } from './TicketRunBriefPreview'

const initialKanbanState = useKanbanStore.getState()
const initialProjectState = useProjectStore.getState()

const BOARD_TICKET = {
  id: 't1',
  project_id: 'project-1',
  title: 'Login form',
  description: 'Validate the email.',
  attachments: []
} as unknown as KanbanTicket

function seed(kind: 'git' | 'connection'): void {
  useProjectStore.setState({
    projects: [{ id: 'project-1', name: 'Shop', path: '/repo/shop', kind }]
  } as never)
  useKanbanStore.setState({
    tickets: new Map([['project-1', [BOARD_TICKET]]]),
    loadTickets: vi.fn(async () => {})
  } as never)
}

const run = makeRun({ source_kind: 'tickets', source_path: '', members: null })
const item = makeItem({ key: 'TD-1', ticket_id: 't1', title: 'Old title', verification: [] })

async function renderOpen(): Promise<void> {
  await act(async () => {
    render(<TicketRunBriefPreview run={run} item={item} />)
  })
  fireEvent.click(screen.getByTestId('docflow-brief-preview-toggle-TD-1'))
}

afterEach(() => {
  cleanup()
  useKanbanStore.setState(initialKanbanState, true)
  useProjectStore.setState(initialProjectState, true)
})

describe('TicketRunBriefPreview', () => {
  it('shows the board ticket as it is now, then the rules, together the launch prompt', async () => {
    seed('git')
    await renderOpen()

    const brief = screen.getByTestId('docflow-brief-preview-brief-TD-1').textContent ?? ''
    const rules = screen.getByTestId('docflow-brief-preview-rules-TD-1').textContent ?? ''
    expect(brief).toContain('<ticket title="Login form">')
    expect(brief).toContain('Validate the email.')
    expect(`${brief}\n\n${rules}`).toBe(
      buildTicketRunPrompt(BOARD_TICKET, {
        interactive: run.config.interactive,
        sdk: resolvePreferredAgentSdk(),
        verification: [],
        workspace: null
      })
    )
    expect(screen.queryByTestId('docflow-brief-preview-workspace-note-TD-1')).toBeNull()
  })

  it('says the member folders are named at launch on a connection project', async () => {
    seed('connection')
    await renderOpen()

    expect(screen.getByTestId('docflow-brief-preview-workspace-note-TD-1')).toHaveTextContent(
      'which folder of the connection holds each repository'
    )
  })
})
