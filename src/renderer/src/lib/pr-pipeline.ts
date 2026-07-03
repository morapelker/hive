import { gitApi } from '@/api/git-api'
import { useGitStore } from '@/stores/useGitStore'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import type { PRContentProvider } from '@/lib/pr-content-provider'

export interface CreatePRPipelineOptions {
  worktreeId: string
  worktreePath: string
  /** Project root path — used to look up the PR title in the already-exists flow */
  projectPath: string | null
  /** Base branch without a remote prefix, e.g. 'main' */
  baseBranch: string
  /** Empty string means auto-generate */
  title: string
  /** Empty string means auto-generate */
  body: string
  /** Used as the PR title when generation fails or is unavailable */
  fallbackTitle: string
  provider: PRContentProvider | null
  /** Pre-created notification card driven through the pipeline's states */
  notifId: string
  /** Prepended to every notification message, e.g. 'my-project: ' */
  labelPrefix?: string
}

export interface CreatePRPipelineResult {
  ok: boolean
  prNumber?: number
  prUrl?: string
  existing?: boolean
  error?: string
}

/**
 * Push (if needed) → generate PR content (if needed) → create the PR via
 * `gh pr create` → attach it to the worktree, driving a PR notification card
 * through the whole flow. Recovers gracefully when the PR already exists.
 */
export async function runCreatePRPipeline(
  options: CreatePRPipelineOptions
): Promise<CreatePRPipelineResult> {
  const {
    worktreeId,
    worktreePath,
    projectPath,
    baseBranch,
    fallbackTitle,
    provider,
    notifId,
    labelPrefix = ''
  } = options

  const { update } = usePRNotificationStore.getState()
  const { attachPR, setCreatingPR } = useGitStore.getState()
  setCreatingPR(worktreeId, true)

  let finalTitle = options.title
  let finalBody = options.body

  try {
    // Step 1: Push if needed
    let willPush = false
    try {
      willPush = await gitApi.needsPush(worktreePath)
    } catch {
      // Assume no push needed
    }

    if (willPush) {
      update(notifId, { message: `${labelPrefix}Pushing branch...` })
      const pushResult = await gitApi.push(worktreePath)
      if (!pushResult.success) {
        throw new Error(pushResult.error ?? 'Push failed')
      }
    }

    // Step 2: Generate content if needed (best-effort — failure should not block PR creation)
    const needsGenerate = !finalTitle || !finalBody
    let usedFallbackContent = false
    let generationFailureReason: string | null = null
    if (needsGenerate) {
      update(notifId, { message: `${labelPrefix}Generating PR content...` })
      if (!provider) {
        usedFallbackContent = true
        generationFailureReason =
          'No AI provider available for PR content generation. Using default title and description.'
      } else {
        try {
          const genResult = await gitApi.generatePRContent(worktreePath, baseBranch, provider)
          if (genResult.success) {
            if (!finalTitle && genResult.title) finalTitle = genResult.title
            if (!finalBody && genResult.body) finalBody = genResult.body
          } else {
            console.warn('PR content generation failed, using fallback:', genResult.error)
            generationFailureReason =
              genResult.error ??
              'AI content generation failed — you may want to edit the title and description'
            usedFallbackContent = true
          }
        } catch (err) {
          console.warn('PR content generation threw, using fallback:', err)
          generationFailureReason = err instanceof Error ? err.message : String(err)
          usedFallbackContent = true
        }
      }
      // Fallback if generation failed or returned empty
      if (!finalTitle) finalTitle = fallbackTitle
      if (!finalBody) finalBody = ''
    }

    // Step 3: Create PR
    update(notifId, { message: `${labelPrefix}Creating pull request...` })
    const createResult = await gitApi.createPR(worktreePath, baseBranch, finalTitle, finalBody)

    if (!createResult.success) {
      // The backend populates url/number even on failure when a PR already
      // exists — use that structured data first, regex fallback second.
      let existingNumber = createResult.number
      let existingUrl = createResult.url

      if (!existingNumber) {
        // Fallback: parse the error message ([\s\S] to match across newlines)
        const errMsg = createResult.error ?? ''
        const alreadyExistsMatch = errMsg.match(
          /already exists[\s\S]*?\/pull\/(\d+)|pull request.*?#(\d+).*?already/i
        )
        if (alreadyExistsMatch) {
          existingNumber = parseInt(alreadyExistsMatch[1] || alreadyExistsMatch[2], 10)
          if (!existingUrl) {
            const urlMatch = errMsg.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)
            existingUrl = urlMatch?.[0] ?? `https://github.com/unknown/pull/${existingNumber}`
          }
        }
      }

      if (existingNumber) {
        existingUrl = existingUrl ?? `https://github.com/unknown/pull/${existingNumber}`

        // Auto-attach the existing PR
        await attachPR(worktreeId, existingNumber, existingUrl)

        let existingTitle: string | undefined
        try {
          if (projectPath) {
            const state = await gitApi.getPRState(projectPath, existingNumber)
            if (state.success) existingTitle = state.title
          }
        } catch {
          // Best-effort: existing PR notification still works without a title.
        }

        update(notifId, {
          status: 'info',
          message: `${labelPrefix}PR #${existingNumber} already exists`,
          description: 'Attached to workspace',
          prUrl: existingUrl,
          prNumber: existingNumber,
          prTitle: existingTitle,
          worktreeId
        })
        return { ok: true, existing: true, prNumber: existingNumber, prUrl: existingUrl }
      }

      throw new Error(createResult.error ?? 'PR creation failed')
    }

    // Attach the new PR
    const prUrl = createResult.url ?? ''
    const prNumber = createResult.number ?? 0
    await attachPR(worktreeId, prNumber, prUrl)

    update(notifId, {
      status: usedFallbackContent ? 'warning' : 'success',
      message: usedFallbackContent
        ? `${labelPrefix}PR #${prNumber} created with default content`
        : `${labelPrefix}Pull request #${prNumber} created`,
      description: usedFallbackContent
        ? (generationFailureReason ??
          'AI content generation failed — you may want to edit the title and description')
        : undefined,
      prUrl,
      prNumber,
      prTitle: finalTitle,
      worktreeId
    })
    return { ok: true, prNumber, prUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    update(notifId, {
      status: 'error',
      message: `${labelPrefix}Failed to create pull request`,
      description: msg
    })
    return { ok: false, error: msg }
  } finally {
    setCreatingPR(worktreeId, false)
  }
}
