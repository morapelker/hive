import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ModelIcon, resolveModelIconAsset } from './ModelIcon'
import { useSettingsStore, useSessionStore, useWorktreeStore } from '@/stores'
import claudeIcon from '@/assets/model-icons/claude.svg'
import openaiIcon from '@/assets/model-icons/openai.svg'

const baseWorktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'Feature',
  branch_name: 'feature',
  path: '/tmp/feature',
  status: 'active' as const,
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null
}

describe('ModelIcon', () => {
  beforeEach(() => {
    useSettingsStore.setState({ showModelIcons: true })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      worktreeOrderByProject: new Map()
    })
    useSessionStore.setState({
      sessionsByWorktree: new Map()
    })
  })

  it('renders Claude for the Claude Agent SDK provider recorded on the worktree', () => {
    useWorktreeStore.setState({
      worktreesByProject: new Map([
        [
          'project-1',
          [
            {
              ...baseWorktree,
              last_model_provider_id: 'claude-code',
              last_model_id: 'opus'
            }
          ]
        ]
      ])
    })

    render(<ModelIcon worktreeId="worktree-1" />)

    expect(screen.getByRole('img', { name: 'Claude' })).toBeInTheDocument()
  })
})

describe('resolveModelIconAsset', () => {
  it('resolves the Claude icon for the anthropic provider', () => {
    const asset = resolveModelIconAsset('anthropic', 'opus')
    expect(asset).toEqual({ src: claudeIcon, alt: 'Claude' })
  })

  it('resolves the Claude icon for the claude-code provider', () => {
    const asset = resolveModelIconAsset('claude-code', 'some-model')
    expect(asset?.alt).toBe('Claude')
  })

  it('resolves the OpenAI icon for the codex provider', () => {
    const asset = resolveModelIconAsset('codex', 'gpt-5.5')
    expect(asset).toEqual({ src: openaiIcon, alt: 'OpenAI' })
  })

  it('resolves the OpenAI icon for the openai provider', () => {
    const asset = resolveModelIconAsset('openai', 'some-model')
    expect(asset?.alt).toBe('OpenAI')
  })

  it('falls back to a claude-* modelId match when the provider is unrecognized', () => {
    const asset = resolveModelIconAsset('unknown-provider', 'claude-opus-4-5')
    expect(asset?.alt).toBe('Claude')
  })

  it('falls back to a gpt-* modelId match when the provider is unrecognized', () => {
    const asset = resolveModelIconAsset('unknown-provider', 'gpt-5.5')
    expect(asset?.alt).toBe('OpenAI')
  })

  it('returns null for an unknown provider and modelId', () => {
    expect(resolveModelIconAsset('unknown-provider', 'some-model')).toBeNull()
  })

  it('returns null when both providerId and modelId are missing', () => {
    expect(resolveModelIconAsset(null, null)).toBeNull()
    expect(resolveModelIconAsset(undefined, undefined)).toBeNull()
  })
})
