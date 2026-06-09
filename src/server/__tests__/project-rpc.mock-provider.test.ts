import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { makeEventBus } from '../events/event-bus'
import type { ProjectOpsRpcService } from '../rpc/domains/project-ops'
import { makeRpcRouter } from '../rpc/router'

describe('project ops RPC mocked provider', () => {
  it('routes projectOps.openDirectoryDialog to the injected provider service', async () => {
    const openDirectoryDialog = vi.fn(() => Effect.succeed('/repo'))
    const service = { openDirectoryDialog } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-open-directory-dialog-1',
        method: 'projectOps.openDirectoryDialog',
        params: {}
      })
    )

    expect(openDirectoryDialog).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'project-open-directory-dialog-1',
      ok: true,
      value: '/repo'
    })
  })

  it('validates projectOps.openDirectoryDialog params before calling the provider service', async () => {
    const openDirectoryDialog = vi.fn(() => Effect.succeed('/unused'))
    const service = { openDirectoryDialog } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-open-directory-dialog-invalid',
        method: 'projectOps.openDirectoryDialog',
        params: { extra: true }
      })
    )

    expect(openDirectoryDialog).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-open-directory-dialog-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.showInFolder to the injected provider service', async () => {
    const showInFolder = vi.fn(() => Effect.succeed(undefined))
    const service = { showInFolder } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-show-in-folder-1',
        method: 'projectOps.showInFolder',
        params: { path: '/repo/package.json' }
      })
    )

    expect(showInFolder).toHaveBeenCalledWith('/repo/package.json')
    expect(response).toEqual({
      id: 'project-show-in-folder-1',
      ok: true,
      value: undefined
    })
  })

  it('validates projectOps.showInFolder params before calling the provider service', async () => {
    const showInFolder = vi.fn(() => Effect.succeed(undefined))
    const service = { showInFolder } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-show-in-folder-invalid',
        method: 'projectOps.showInFolder',
        params: { path: '' }
      })
    )

    expect(showInFolder).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-show-in-folder-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.openPath to the injected provider service', async () => {
    const openPath = vi.fn(() => Effect.succeed(''))
    const service = { openPath } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-open-path-1',
        method: 'projectOps.openPath',
        params: { path: '/repo/README.md' }
      })
    )

    expect(openPath).toHaveBeenCalledWith('/repo/README.md')
    expect(response).toEqual({
      id: 'project-open-path-1',
      ok: true,
      value: ''
    })
  })

  it('validates projectOps.openPath params before calling the provider service', async () => {
    const openPath = vi.fn(() => Effect.succeed('unused'))
    const service = { openPath } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-open-path-invalid',
        method: 'projectOps.openPath',
        params: { path: '' }
      })
    )

    expect(openPath).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-open-path-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.copyToClipboard to the injected provider service', async () => {
    const copyToClipboard = vi.fn(() => Effect.succeed(undefined))
    const service = { copyToClipboard } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-copy-to-clipboard-1',
        method: 'projectOps.copyToClipboard',
        params: { text: 'copied text' }
      })
    )

    expect(copyToClipboard).toHaveBeenCalledWith('copied text')
    expect(response).toEqual({
      id: 'project-copy-to-clipboard-1',
      ok: true,
      value: undefined
    })
  })

  it('validates projectOps.copyToClipboard params before calling the provider service', async () => {
    const copyToClipboard = vi.fn(() => Effect.succeed(undefined))
    const service = { copyToClipboard } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-copy-to-clipboard-invalid',
        method: 'projectOps.copyToClipboard',
        params: { text: 42 }
      })
    )

    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-copy-to-clipboard-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.readFromClipboard to the injected provider service', async () => {
    const readFromClipboard = vi.fn(() => Effect.succeed('clipboard text'))
    const service = { readFromClipboard } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-read-from-clipboard-1',
        method: 'projectOps.readFromClipboard',
        params: {}
      })
    )

    expect(readFromClipboard).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'project-read-from-clipboard-1',
      ok: true,
      value: 'clipboard text'
    })
  })

  it('validates projectOps.readFromClipboard params before calling the provider service', async () => {
    const readFromClipboard = vi.fn(() => Effect.succeed('unused'))
    const service = { readFromClipboard } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-read-from-clipboard-invalid',
        method: 'projectOps.readFromClipboard',
        params: { extra: true }
      })
    )

    expect(readFromClipboard).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-read-from-clipboard-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.isGitRepository to the injected provider service', async () => {
    const isGitRepository = vi.fn(() => Effect.succeed(true))
    const service = { isGitRepository } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-is-git-repository-1',
        method: 'projectOps.isGitRepository',
        params: { path: '/repo' }
      })
    )

    expect(isGitRepository).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-is-git-repository-1',
      ok: true,
      value: true
    })
  })

  it('validates projectOps.isGitRepository params before calling the provider service', async () => {
    const isGitRepository = vi.fn(() => Effect.succeed(false))
    const service = { isGitRepository } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-is-git-repository-invalid',
        method: 'projectOps.isGitRepository',
        params: { path: '' }
      })
    )

    expect(isGitRepository).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-is-git-repository-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.validateProject to the injected provider service', async () => {
    const validation = { success: true, path: '/repo', name: 'repo' }
    const validateProject = vi.fn(() => Effect.succeed(validation))
    const service = { validateProject } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-validate-project-1',
        method: 'projectOps.validateProject',
        params: { path: '/repo' }
      })
    )

    expect(validateProject).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-validate-project-1',
      ok: true,
      value: validation
    })
  })

  it('validates projectOps.validateProject params before calling the provider service', async () => {
    const validateProject = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { validateProject } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-validate-project-invalid',
        method: 'projectOps.validateProject',
        params: { path: '' }
      })
    )

    expect(validateProject).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-validate-project-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.detectLanguage to the injected provider service', async () => {
    const detectLanguage = vi.fn(() => Effect.succeed('typescript'))
    const service = { detectLanguage } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-detect-language-1',
        method: 'projectOps.detectLanguage',
        params: { path: '/repo' }
      })
    )

    expect(detectLanguage).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-detect-language-1',
      ok: true,
      value: 'typescript'
    })
  })

  it('validates projectOps.detectLanguage params before calling the provider service', async () => {
    const detectLanguage = vi.fn(() => Effect.succeed(null))
    const service = { detectLanguage } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-detect-language-invalid',
        method: 'projectOps.detectLanguage',
        params: { path: '' }
      })
    )

    expect(detectLanguage).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-detect-language-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.detectSetupSuggestions to the injected provider service', async () => {
    const suggestions = [
      {
        id: 'install',
        command: 'pnpm install',
        label: 'Install dependencies',
        category: 'install' as const,
        defaultChecked: true
      }
    ]
    const detectSetupSuggestions = vi.fn(() => Effect.succeed(suggestions))
    const service = { detectSetupSuggestions } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-detect-setup-suggestions-1',
        method: 'projectOps.detectSetupSuggestions',
        params: { path: '/repo' }
      })
    )

    expect(detectSetupSuggestions).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-detect-setup-suggestions-1',
      ok: true,
      value: suggestions
    })
  })

  it('validates projectOps.detectSetupSuggestions params before calling the provider service', async () => {
    const detectSetupSuggestions = vi.fn(() => Effect.succeed([]))
    const service = { detectSetupSuggestions } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-detect-setup-suggestions-invalid',
        method: 'projectOps.detectSetupSuggestions',
        params: { path: '' }
      })
    )

    expect(detectSetupSuggestions).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-detect-setup-suggestions-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.findXcworkspace to the injected provider service', async () => {
    const findXcworkspace = vi.fn(() => Effect.succeed('/repo/App.xcworkspace'))
    const service = { findXcworkspace } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-find-xcworkspace-1',
        method: 'projectOps.findXcworkspace',
        params: { path: '/repo' }
      })
    )

    expect(findXcworkspace).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-find-xcworkspace-1',
      ok: true,
      value: '/repo/App.xcworkspace'
    })
  })

  it('validates projectOps.findXcworkspace params before calling the provider service', async () => {
    const findXcworkspace = vi.fn(() => Effect.succeed(null))
    const service = { findXcworkspace } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-find-xcworkspace-invalid',
        method: 'projectOps.findXcworkspace',
        params: { path: '' }
      })
    )

    expect(findXcworkspace).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-find-xcworkspace-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.isAndroidProject to the injected provider service', async () => {
    const isAndroidProject = vi.fn(() => Effect.succeed(true))
    const service = { isAndroidProject } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-is-android-project-1',
        method: 'projectOps.isAndroidProject',
        params: { path: '/repo' }
      })
    )

    expect(isAndroidProject).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-is-android-project-1',
      ok: true,
      value: true
    })
  })

  it('validates projectOps.isAndroidProject params before calling the provider service', async () => {
    const isAndroidProject = vi.fn(() => Effect.succeed(false))
    const service = { isAndroidProject } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-is-android-project-invalid',
        method: 'projectOps.isAndroidProject',
        params: { path: '' }
      })
    )

    expect(isAndroidProject).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-is-android-project-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.loadLanguageIcons to the injected provider service', async () => {
    const icons = {
      typescript: 'data:image/svg+xml;base64,typescript',
      rust: 'data:image/svg+xml;base64,rust'
    }
    const loadLanguageIcons = vi.fn(() => Effect.succeed(icons))
    const service = { loadLanguageIcons } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-load-language-icons-1',
        method: 'projectOps.loadLanguageIcons',
        params: {}
      })
    )

    expect(loadLanguageIcons).toHaveBeenCalledWith()
    expect(response).toEqual({
      id: 'project-load-language-icons-1',
      ok: true,
      value: icons
    })
  })

  it('validates projectOps.loadLanguageIcons params before calling the provider service', async () => {
    const loadLanguageIcons = vi.fn(() => Effect.succeed({}))
    const service = { loadLanguageIcons } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-load-language-icons-invalid',
        method: 'projectOps.loadLanguageIcons',
        params: { extra: true }
      })
    )

    expect(loadLanguageIcons).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-load-language-icons-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.initRepository to the injected provider service', async () => {
    const result = { success: true }
    const initRepository = vi.fn(() => Effect.succeed(result))
    const service = { initRepository } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-init-repository-1',
        method: 'projectOps.initRepository',
        params: { path: '/repo' }
      })
    )

    expect(initRepository).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-init-repository-1',
      ok: true,
      value: result
    })
  })

  it('validates projectOps.initRepository params before calling the provider service', async () => {
    const initRepository = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { initRepository } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-init-repository-invalid',
        method: 'projectOps.initRepository',
        params: { path: '' }
      })
    )

    expect(initRepository).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-init-repository-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.pickProjectIcon to the injected provider service', async () => {
    const result = { success: true, filename: 'project-1.png' }
    const pickProjectIcon = vi.fn(() => Effect.succeed(result))
    const service = { pickProjectIcon } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-pick-project-icon-1',
        method: 'projectOps.pickProjectIcon',
        params: { projectId: 'project-1' }
      })
    )

    expect(pickProjectIcon).toHaveBeenCalledWith('project-1')
    expect(response).toEqual({
      id: 'project-pick-project-icon-1',
      ok: true,
      value: result
    })
  })

  it('validates projectOps.pickProjectIcon params before calling the provider service', async () => {
    const pickProjectIcon = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { pickProjectIcon } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-pick-project-icon-invalid',
        method: 'projectOps.pickProjectIcon',
        params: { projectId: '' }
      })
    )

    expect(pickProjectIcon).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-pick-project-icon-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.removeProjectIcon to the injected provider service', async () => {
    const result = { success: true }
    const removeProjectIcon = vi.fn(() => Effect.succeed(result))
    const service = { removeProjectIcon } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-remove-project-icon-1',
        method: 'projectOps.removeProjectIcon',
        params: { projectId: 'project-1' }
      })
    )

    expect(removeProjectIcon).toHaveBeenCalledWith('project-1')
    expect(response).toEqual({
      id: 'project-remove-project-icon-1',
      ok: true,
      value: result
    })
  })

  it('validates projectOps.removeProjectIcon params before calling the provider service', async () => {
    const removeProjectIcon = vi.fn(() => Effect.succeed({ success: false, error: 'unused' }))
    const service = { removeProjectIcon } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-remove-project-icon-invalid',
        method: 'projectOps.removeProjectIcon',
        params: { projectId: '' }
      })
    )

    expect(removeProjectIcon).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-remove-project-icon-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.getProjectIconPath to the injected provider service', async () => {
    const getProjectIconPath = vi.fn(() => Effect.succeed('data:image/png;base64,icon'))
    const service = { getProjectIconPath } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-get-project-icon-path-1',
        method: 'projectOps.getProjectIconPath',
        params: { filename: 'project-1.png' }
      })
    )

    expect(getProjectIconPath).toHaveBeenCalledWith('project-1.png')
    expect(response).toEqual({
      id: 'project-get-project-icon-path-1',
      ok: true,
      value: 'data:image/png;base64,icon'
    })
  })

  it('validates projectOps.getProjectIconPath params before calling the provider service', async () => {
    const getProjectIconPath = vi.fn(() => Effect.succeed(null))
    const service = { getProjectIconPath } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-get-project-icon-path-invalid',
        method: 'projectOps.getProjectIconPath',
        params: { filename: '' }
      })
    )

    expect(getProjectIconPath).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-get-project-icon-path-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.detectFavicon to the injected provider service', async () => {
    const detectFavicon = vi.fn(() => Effect.succeed('data:image/png;base64,favicon'))
    const service = { detectFavicon } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-detect-favicon-1',
        method: 'projectOps.detectFavicon',
        params: { path: '/repo' }
      })
    )

    expect(detectFavicon).toHaveBeenCalledWith('/repo')
    expect(response).toEqual({
      id: 'project-detect-favicon-1',
      ok: true,
      value: 'data:image/png;base64,favicon'
    })
  })

  it('validates projectOps.detectFavicon params before calling the provider service', async () => {
    const detectFavicon = vi.fn(() => Effect.succeed(null))
    const service = { detectFavicon } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-detect-favicon-invalid',
        method: 'projectOps.detectFavicon',
        params: { path: '' }
      })
    )

    expect(detectFavicon).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-detect-favicon-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })

  it('routes projectOps.getAbsoluteIconDataUrl to the injected provider service', async () => {
    const getAbsoluteIconDataUrl = vi.fn(() => Effect.succeed('data:image/png;base64,absolute'))
    const service = { getAbsoluteIconDataUrl } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-get-absolute-icon-data-url-1',
        method: 'projectOps.getAbsoluteIconDataUrl',
        params: { path: '/repo/icon.png' }
      })
    )

    expect(getAbsoluteIconDataUrl).toHaveBeenCalledWith('/repo/icon.png')
    expect(response).toEqual({
      id: 'project-get-absolute-icon-data-url-1',
      ok: true,
      value: 'data:image/png;base64,absolute'
    })
  })

  it('validates projectOps.getAbsoluteIconDataUrl params before calling the provider service', async () => {
    const getAbsoluteIconDataUrl = vi.fn(() => Effect.succeed(null))
    const service = { getAbsoluteIconDataUrl } as unknown as ProjectOpsRpcService
    const router = makeRpcRouter({
      eventBus: makeEventBus(),
      projectOps: service
    })

    const response = await Effect.runPromise(
      router.handle({
        id: 'project-get-absolute-icon-data-url-invalid',
        method: 'projectOps.getAbsoluteIconDataUrl',
        params: { path: '' }
      })
    )

    expect(getAbsoluteIconDataUrl).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      id: 'project-get-absolute-icon-data-url-invalid',
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
  })
})
