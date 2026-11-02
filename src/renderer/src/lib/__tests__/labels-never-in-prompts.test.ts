/**
 * Regression guard: ticket labels are display-only (shared/lib/ticket-labels.ts) and, like the
 * ticket's note, must never reach a model. Every code path that turns a ticket into model input
 * is run three times, on the same ticket carrying two labels (a saved one and a one-off), no
 * labels, and no `labels` key at all (a row from another Mac's older build). The three outputs
 * must be byte-identical, and none may hold a label's name or id.
 *
 * The dangerous case is a builder that spreads or serialises the whole ticket: a new field then
 * leaks without anyone touching the builder. Each case below runs the real builder (or the
 * narrowest real piece of it) rather than reading its source, so a spread fails here.
 *
 * MAINTENANCE: a new code path that builds model input (a prompt, an agent tool result, an
 * app_state field) from a KanbanTicket gets a case here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TicketLabel } from '@shared/lib/ticket-labels'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { buildPrompt, buildRemotePrompt } from '@/components/kanban/WorktreePickerModal'
import { buildBoardPrompt } from '@/components/kanban/BoardAssistantView'
import { TicketPickerModal, type TicketAttachmentData } from '@/components/kanban/TicketPickerModal'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { buildTicketPrompt } from '@/lib/connection-project-launch'
import { buildDisplayContent, buildMessageParts } from '@/lib/file-attachment-utils'
import { DocumentFlowRunner } from '@/lib/document-flow/runner'
import { advance, createWorld, TEST_NOW } from '@/lib/document-flow/runner-fakes'
import { useBoardChatStore, type BoardChatScope } from '@/stores/useBoardChatStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../../../main/db/types'

const APP_ROOT = join(__dirname, '..', '..', '..', '..', '..')

// ── Fixtures ──────────────────────────────────────────────────────────

const SAVED_LABEL_ID = 'saved-label-sentinel-id'
const ONCE_LABEL_ID = 'once-label-sentinel-id'

const LABELS: TicketLabel[] = [
  { id: SAVED_LABEL_ID, kind: 'saved', name: 'ZEBRA-LABEL-SENTINEL', color: 'yellow' },
  { id: ONCE_LABEL_ID, kind: 'once', name: 'WAITING UNTIL 21/10', color: 'red' }
]

/** Everything that would betray a label, compared case-insensitively (a builder may upper-case). */
const LABEL_TRACES = ['ZEBRA-LABEL-SENTINEL', 'WAITING UNTIL 21/10', SAVED_LABEL_ID, ONCE_LABEL_ID]

type Variant = 'labelled' | 'unlabelled' | 'legacy'
const VARIANTS: readonly Variant[] = ['labelled', 'unlabelled', 'legacy']

const PROJECT_ID = 'proj-labels'
const OTHER_PROJECT_ID = 'proj-labels-2'

function makeTicket(overrides: Partial<KanbanTicket> = {}): KanbanTicket {
  return {
    id: 'ticket-1',
    project_id: PROJECT_ID,
    title: 'Ship the checkout',
    description: 'Wire the pay button to the new endpoint.',
    attachments: [
      { type: 'image', url: '/tmp/mock.png', label: 'mock.png' },
      { type: 'jira', url: 'https://example.com/browse/PAY-1', label: 'PAY-1' }
    ],
    column: 'todo',
    sort_order: 0,
    current_session_id: null,
    worktree_id: null,
    mode: null,
    plan_ready: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    column_changed_at: '2026-10-01T00:00:00.000Z',
    archived_at: null,
    external_provider: null,
    external_id: null,
    external_url: null,
    github_pr_number: null,
    github_pr_url: null,
    mark: null,
    total_tokens: 0,
    pending_launch_config: null,
    goal_mode: false,
    goal_success_criteria: null,
    note: null,
    labels: [],
    created_from_session: false,
    auto_approve_plan: false,
    unread: false,
    awaiting_completion: false,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    variant_group_id: null,
    ticket_prefix: null,
    ticket_number: null,
    parent_ticket_id: null,
    parent_ticket_key: null,
    ...overrides
  }
}

/** The same ticket carrying the labels, carrying none, or (an older Mac's row) lacking the key. */
function variantOf<T extends { labels?: TicketLabel[] }>(ticket: T, variant: Variant): T {
  const rest: Record<string, unknown> = { ...ticket }
  delete rest.labels
  if (variant === 'legacy') return rest as T
  return { ...rest, labels: variant === 'labelled' ? LABELS.map((l) => ({ ...l })) : [] } as T
}

function expectNoLabelTrace(output: string): void {
  const lower = output.toLowerCase()
  for (const trace of LABEL_TRACES) {
    expect(lower, `model input must not contain "${trace}"`).not.toContain(trace.toLowerCase())
  }
  expect(output, 'model input must not carry a labels field').not.toMatch(/["']?labels["']?\s*:/)
}

/**
 * Builds the model input once per variant and checks they match byte for byte. `mustContain`
 * keeps the case honest: the output has to carry the ticket at all.
 */
async function expectLabelBlind(
  build: (variant: Variant) => string | Promise<string>,
  mustContain: string
): Promise<string> {
  const outputs: Record<Variant, string> = { labelled: '', unlabelled: '', legacy: '' }
  for (const variant of VARIANTS) outputs[variant] = await build(variant)
  expect(outputs.unlabelled).toContain(mustContain)
  expect(outputs.labelled).toBe(outputs.unlabelled)
  expect(outputs.legacy).toBe(outputs.unlabelled)
  expectNoLabelTrace(outputs.labelled)
  return outputs.labelled
}

const project = (id: string, name: string): never =>
  ({ id, name, path: `/tmp/${id}`, description: 'A shop', kind: 'git' }) as never

/** Three tickets on the first project (one archived) and one on the second. */
function boardTickets(variant: Variant): Map<string, KanbanTicket[]> {
  return new Map([
    [
      PROJECT_ID,
      [
        variantOf(makeTicket({ id: 't1', title: 'Ship the checkout' }), variant),
        variantOf(makeTicket({ id: 't2', title: 'Fix the cart badge', column: 'review' }), variant),
        variantOf(
          makeTicket({ id: 't3', title: 'Old idea', column: 'done', archived_at: '2026-10-02' }),
          variant
        )
      ]
    ],
    [
      OTHER_PROJECT_ID,
      [variantOf(makeTicket({ id: 't4', project_id: OTHER_PROJECT_ID, title: 'Rates' }), variant)]
    ]
  ])
}

const stores = [
  useKanbanStore,
  useSessionStore,
  useWorktreeStore,
  useConnectionStore,
  useProjectStore,
  usePinnedStore,
  useSettingsStore,
  useBoardChatStore
] as const
const initialStates = stores.map((s) => (s as unknown as { getState(): unknown }).getState())

beforeEach(() => {
  stores.forEach((s, i) =>
    (s as unknown as { setState(state: unknown, replace: true): void }).setState(
      initialStates[i],
      true
    )
  )
  useProjectStore.setState({
    projects: [project(PROJECT_ID, 'shop'), project(OTHER_PROJECT_ID, 'rates')],
    selectedProjectId: PROJECT_ID
  })
  usePinnedStore.setState({ pinnedProjectIds: new Set([OTHER_PROJECT_ID]), loaded: true })
  useConnectionStore.setState({ connections: [], loaded: true })
})

afterEach(() => {
  cleanup()
  resetRendererRpcClientForTests()
})

// ── Session launch from a ticket ──────────────────────────────────────

describe('launch prompts', () => {
  it.each(['build', 'plan', 'super-plan', 'super-build'] as const)(
    'WorktreePickerModal buildPrompt (%s): picker prefill, quick launch, queued launch config',
    async (mode) => {
      await expectLabelBlind(
        (variant) => buildPrompt(mode, variantOf(makeTicket(), variant)),
        '<ticket title="Ship the checkout">'
      )
    }
  )

  it('WorktreePickerModal buildRemotePrompt, from the prefill and from edited text', async () => {
    await expectLabelBlind((variant) => {
      const ticket = variantOf(makeTicket(), variant)
      return buildRemotePrompt('build', ticket, buildPrompt('build', ticket))
    }, 'Wire the pay button')
    await expectLabelBlind((variant) => {
      const ticket = variantOf(makeTicket(), variant)
      return buildRemotePrompt('plan', ticket, `${buildPrompt('plan', ticket)}\n\nAnd the tests.`)
    }, 'And the tests.')
  })

  // Connection boards, the Tedooo agent's launch_ticket, document-run fix tickets and the
  // phone relay's launches all compose their prompt here.
  it.each(['build', 'plan', 'super-plan', 'super-build'] as const)(
    'connection-project-launch buildTicketPrompt (%s)',
    async (mode) => {
      await expectLabelBlind(
        (variant) => buildTicketPrompt(mode, variantOf(makeTicket(), variant)),
        '<ticket title="Ship the checkout">'
      )
    }
  )
})

// ── Board assistants ──────────────────────────────────────────────────

describe('board assistants', () => {
  it('BoardAssistantView buildBoardPrompt', async () => {
    const scope: BoardChatScope = {
      kind: 'project',
      projectId: PROJECT_ID,
      projectName: 'shop',
      projectPath: `/tmp/${PROJECT_ID}`
    }
    await expectLabelBlind((variant) => {
      useKanbanStore.setState({ tickets: boardTickets(variant) })
      return buildBoardPrompt('Split the checkout into tickets', scope, PROJECT_ID)
    }, '"title": "Fix the cart badge"')
  })

  /**
   * The board chat drawer reads the board straight from the backend and sends the prompt
   * through `opencodeOps.prompt`: both ends are faked at the RPC client, so the whole of
   * sendMessage (context lines, rules, request) is what is compared.
   */
  async function boardChatPrompt(scope: BoardChatScope, variant: Variant): Promise<string> {
    const tickets = boardTickets(variant)
    const prompts: string[] = []
    setRendererRpcClient({
      request: (async (method: string, params: Record<string, unknown>) => {
        if (method === 'opencodeOps.reconnect') return { success: true }
        if (method === 'kanban.ticket.getByProject') {
          return (tickets.get(params.projectId as string) ?? []).filter((t) => !t.archived_at)
        }
        if (method === 'opencodeOps.prompt') {
          const parts = params.messageOrParts as Array<{ type: string; text: string }>
          prompts.push(parts.map((part) => part.text).join('\n'))
          return { success: true }
        }
        return undefined
      }) as never,
      subscribe: () => () => {}
    })
    useBoardChatStore.setState({
      ...useBoardChatStore.getInitialState(),
      scope,
      sessionId: 'board-session',
      opencodeSessionId: 'board-opencode-session',
      selectedTargetProjectId: PROJECT_ID
    })
    await useBoardChatStore.getState().sendMessage('What is left on the board?')
    expect(useBoardChatStore.getState().error).toBeNull()
    expect(prompts).toHaveLength(1)
    return prompts[0]
  }

  it('useBoardChatStore board context, project board', async () => {
    const scope: BoardChatScope = {
      kind: 'project',
      projectId: PROJECT_ID,
      projectName: 'shop',
      projectPath: `/tmp/${PROJECT_ID}`
    }
    await expectLabelBlind(
      (variant) => boardChatPrompt(scope, variant),
      '- [review] Fix the cart badge'
    )
  })

  it('useBoardChatStore board context, connection board', async () => {
    const scope: BoardChatScope = {
      kind: 'connection',
      connectionId: 'conn-1',
      connectionName: 'shop + rates',
      connectionPath: '/tmp/conn-1',
      availableProjects: [
        { id: PROJECT_ID, name: 'shop' },
        { id: OTHER_PROJECT_ID, name: 'rates' }
      ]
    }
    await expectLabelBlind((variant) => boardChatPrompt(scope, variant), '- [todo] Rates')
  })
})

// ── Ticket attachments ───────────────────────────────────────────────

describe('ticket attachments', () => {
  /** What the ticket picker hands the composer for one picked ticket, through the real modal. */
  function pickTicket(variant: Variant): TicketAttachmentData[] {
    act(() => {
      useKanbanStore.setState({
        tickets: boardTickets(variant),
        // The modal reloads the board when it opens; the fixture is the board.
        loadTickets: vi.fn(async () => undefined)
      })
    })
    const onSelectTickets = vi.fn()
    render(
      createElement(TicketPickerModal, {
        projectId: PROJECT_ID,
        open: true,
        onOpenChange: () => {},
        onSelectTickets
      })
    )
    fireEvent.click(screen.getByTestId('ticket-row-t1'))
    fireEvent.click(screen.getByTestId('ticket-picker-done'))
    cleanup()
    expect(onSelectTickets).toHaveBeenCalledTimes(1)
    return onSelectTickets.mock.calls[0][0] as TicketAttachmentData[]
  }

  /** The composer's attachment, as SessionView builds it from the picker's data. */
  const asAttachment = (data: TicketAttachmentData): Attachment => ({
    kind: 'ticket',
    id: 'attachment-1',
    name: data.title,
    ticketId: data.ticketId,
    title: data.title,
    description: data.description,
    attachments: data.attachments
  })

  it('TicketPickerModal selection data', async () => {
    await expectLabelBlind(
      (variant) => JSON.stringify(pickTicket(variant)),
      '"title":"Ship the checkout"'
    )
  })

  it('file-attachment-utils message parts and display content', async () => {
    await expectLabelBlind((variant) => {
      const attachments = pickTicket(variant).map(asAttachment)
      return JSON.stringify(buildMessageParts(attachments, 'Look at this ticket.'))
    }, '<ticket title=\\"Ship the checkout\\">')
    await expectLabelBlind((variant) => {
      const attachments = pickTicket(variant).map(asAttachment)
      return buildDisplayContent(attachments, 'Look at this ticket.')
    }, '<ticket title="Ship the checkout">')
  })
})

// ── "Implement document" runs ─────────────────────────────────────────

describe('document-flow runner launch brief', () => {
  let runner: DocumentFlowRunner | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(TEST_NOW))
  })

  afterEach(() => {
    runner?.stop()
    runner = null
    vi.useRealTimers()
  })

  /** Launches the run's one ticket and returns the prompt its session was started with. */
  async function launchPrompt(variant: Variant, description: string): Promise<string> {
    runner?.stop()
    const world = createWorld()
    const ticket = world.tickets.get('ticket-A')!
    // The real port hands the runner the store's full row, labels included.
    world.tickets.set(ticket.id, variantOf({ ...ticket, description } as KanbanTicket, variant))
    runner = new DocumentFlowRunner(world.ports)
    runner.start()
    await advance(1000)
    expect(world.launches).toHaveLength(1)
    return world.launches[0].prompt
  }

  it('sends the description as the brief', async () => {
    await expectLabelBlind(
      (variant) => launchPrompt(variant, 'implement task A, but skip the export button'),
      'implement task A, but skip the export button'
    )
  })

  it('sends the standard brief for a ticket without a description', async () => {
    await expectLabelBlind((variant) => launchPrompt(variant, ''), 'implement task A ("Task A")')
  })
})

// ── Files agents read ─────────────────────────────────────────────────

describe('files agents read', () => {
  const source = (relPath: string): string => readFileSync(join(APP_ROOT, relPath), 'utf8')

  /**
   * A markdown board's card files sit in the repository, where agents read them. Labels live
   * only in the private runtime table (markdown_kanban_card_state), never in the frontmatter:
   * mergeFrontmatter writes nothing outside HIVE_FRONTMATTER_FIELDS, so the guard is
   * that list (and the create-time field map) never naming them.
   */
  it('markdown card frontmatter never carries labels', () => {
    const backend = source('src/main/services/kanban-backend.ts')
    const fields = backend.match(/const HIVE_FRONTMATTER_FIELDS = new Set\(\[([\s\S]*?)\]\)/)
    expect(fields, 'HIVE_FRONTMATTER_FIELDS not found').not.toBeNull()
    const names = [...fields![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(names).toContain('title')
    expect(names).not.toContain('labels')
    expect(names).not.toContain('note')

    const publicFields = backend.match(/function publicFieldsFromCreate\([\s\S]*?\n\}\n/)
    expect(publicFields, 'publicFieldsFromCreate not found').not.toBeNull()
    expect(publicFields![0]).not.toMatch(/\blabels\b/)
  })

  /** The ticket autocomplete model learns from the user's own titles and descriptions only. */
  it('the autocomplete corpus selects titles and descriptions only', () => {
    const database = source('src/main/db/database.ts')
    const corpus = database.match(
      /getTicketAutocompleteCorpus\(\): string\[\] \{([\s\S]*?)\n {2}\}\n/
    )
    expect(corpus, 'getTicketAutocompleteCorpus not found').not.toBeNull()
    expect(corpus![1]).toMatch(/SELECT title, description FROM kanban_tickets/)
    expect(corpus![1]).not.toMatch(/\blabels\b/)
  })
})
