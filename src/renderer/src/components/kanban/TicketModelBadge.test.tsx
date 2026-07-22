import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TicketModelBadge } from './TicketModelBadge'
import { cacheHandoffModelCatalog, clearHandoffModelCatalogCache } from '@/lib/handoffSelection'

describe('TicketModelBadge', () => {
  afterEach(() => {
    clearHandoffModelCatalogCache()
    vi.restoreAllMocks()
  })

  it('renders nothing when the ticket has no model_id', () => {
    const { container } = render(
      <TicketModelBadge
        ticket={{ model_provider_id: null, model_id: null, model_variant: null }}
      />
    )

    expect(container.firstChild).toBeNull()
  })

  it('renders the raw model_id as a fallback display name when the catalog has no match', () => {
    render(
      <TicketModelBadge
        ticket={{
          model_provider_id: 'anthropic',
          model_id: 'claude-opus-4-5-20251101',
          model_variant: null
        }}
      />
    )

    expect(screen.getByText('claude-opus-4-5-20251101')).toBeInTheDocument()
  })

  it('renders the provider icon for a recognized provider', () => {
    render(
      <TicketModelBadge
        ticket={{
          model_provider_id: 'anthropic',
          model_id: 'claude-opus-4-5-20251101',
          model_variant: null
        }}
      />
    )

    expect(screen.getByRole('img', { name: 'Claude' })).toBeInTheDocument()
  })

  it('omits the icon for an unrecognized provider/modelId', () => {
    render(
      <TicketModelBadge
        ticket={{
          model_provider_id: 'some-unknown-provider',
          model_id: 'mystery-model',
          model_variant: null
        }}
      />
    )

    expect(screen.queryByRole('img')).toBeNull()
  })

  it('puts the variant in the title tooltip, not the visible text', () => {
    render(
      <TicketModelBadge
        ticket={{
          model_provider_id: 'anthropic',
          model_id: 'opus',
          model_variant: 'high'
        }}
      />
    )

    const badge = screen.getByTitle('opus (high)')
    expect(badge).toBeInTheDocument()
    expect(badge.textContent).not.toContain('high')
  })

  it('uses the pretty display name from the cached model catalog when there is a hit', () => {
    cacheHandoffModelCatalog('claude-code', {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            opus: { id: 'opus', name: 'Claude Opus 4.5' }
          }
        }
      ]
    })

    render(
      <TicketModelBadge
        ticket={{
          model_provider_id: 'anthropic',
          model_id: 'opus',
          model_variant: null
        }}
      />
    )

    expect(screen.getByText('Claude Opus 4.5')).toBeInTheDocument()
    expect(screen.getByTitle('Claude Opus 4.5')).toBeInTheDocument()
  })

  it('gives the chip a violet border for an ultracode launch', () => {
    render(
      <TicketModelBadge
        ticket={{ model_provider_id: 'claude-code', model_id: 'opus', model_variant: 'ultracode' }}
      />
    )

    expect(screen.getByText('opus').closest('span')).toHaveClass('border-violet-500/60')
  })

  it('gives the chip a violet border for a codex ultra launch', () => {
    render(
      <TicketModelBadge
        ticket={{ model_provider_id: 'codex', model_id: 'gpt-5.6-sol', model_variant: 'ultra' }}
      />
    )

    expect(screen.getByText('gpt-5.6-sol').closest('span')).toHaveClass('border-violet-500/60')
  })

  it('keeps the border transparent for non-ultra variants', () => {
    render(
      <TicketModelBadge
        ticket={{ model_provider_id: 'claude-code', model_id: 'opus', model_variant: 'xhigh' }}
      />
    )

    const badge = screen.getByText('opus').closest('span')
    expect(badge).not.toHaveClass('border-violet-500/60')
    expect(badge).toHaveClass('border-transparent')
  })

  it('applies the passed className to the chip', () => {
    render(
      <TicketModelBadge
        ticket={{ model_provider_id: 'anthropic', model_id: 'opus', model_variant: null }}
        className="custom-class"
      />
    )

    expect(screen.getByText('opus').closest('span')).toHaveClass('custom-class')
  })
})
