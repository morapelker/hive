import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '../rpc-client'
import { projectApi } from '../project-api'

describe('projectApi', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopBridge')
    resetRendererRpcClientForTests()
  })

  it('routes openDirectoryDialog through the renderer RPC client', async () => {
    const pickFolder = vi.fn().mockResolvedValue('/tmp/hive-project')
    const request = vi.fn().mockResolvedValue('/tmp/hive-project')
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        pickFolder
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.openDirectoryDialog()).resolves.toBe('/tmp/hive-project')
    expect(request).toHaveBeenCalledWith('projectOps.openDirectoryDialog', {})
    expect(pickFolder).not.toHaveBeenCalled()
  })

  it('routes showInFolder through the renderer RPC client', async () => {
    const showItemInFolder = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        showItemInFolder
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.showInFolder('/tmp/hive/package.json')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('projectOps.showInFolder', {
      path: '/tmp/hive/package.json'
    })
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('routes openPath through the renderer RPC client', async () => {
    const openPath = vi.fn().mockResolvedValue('')
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        openPath
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.openPath('https://example.com')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('projectOps.openPath', {
      path: 'https://example.com'
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('routes copyToClipboard through the renderer RPC client', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    const request = vi.fn().mockResolvedValue(undefined)
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        writeClipboardText
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.copyToClipboard('/tmp/hive/package.json')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith('projectOps.copyToClipboard', {
      text: '/tmp/hive/package.json'
    })
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('routes readFromClipboard through the renderer RPC client', async () => {
    const readClipboardText = vi.fn().mockResolvedValue('/tmp/hive/package.json')
    const request = vi.fn().mockResolvedValue('/tmp/hive/package.json')
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        readClipboardText
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.readFromClipboard()).resolves.toBe('/tmp/hive/package.json')
    expect(request).toHaveBeenCalledWith('projectOps.readFromClipboard', {})
    expect(readClipboardText).not.toHaveBeenCalled()
  })

  it('routes isGitRepository through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.isGitRepository('/tmp/hive')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('projectOps.isGitRepository', { path: '/tmp/hive' })
  })

  it('routes validateProject through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      path: '/tmp/hive',
      name: 'hive'
    })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.validateProject('/tmp/hive')).resolves.toEqual({
      success: true,
      path: '/tmp/hive',
      name: 'hive'
    })
    expect(request).toHaveBeenCalledWith('projectOps.validateProject', {
      path: '/tmp/hive'
    })
  })

  it('routes detectLanguage through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('typescript')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.detectLanguage('/tmp/hive')).resolves.toBe('typescript')
    expect(request).toHaveBeenCalledWith('projectOps.detectLanguage', {
      path: '/tmp/hive'
    })
  })

  it('routes detectSetupSuggestions through the renderer RPC client', async () => {
    const suggestions = [
      {
        id: 'install',
        command: 'pnpm install',
        label: 'Install dependencies',
        category: 'install',
        defaultChecked: true
      }
    ]
    const request = vi.fn().mockResolvedValue(suggestions)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.detectSetupSuggestions('/tmp/hive')).resolves.toEqual(suggestions)
    expect(request).toHaveBeenCalledWith('projectOps.detectSetupSuggestions', {
      path: '/tmp/hive'
    })
  })

  it('routes findXcworkspace through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('/tmp/hive/Hive.xcworkspace')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.findXcworkspace('/tmp/hive')).resolves.toBe(
      '/tmp/hive/Hive.xcworkspace'
    )
    expect(request).toHaveBeenCalledWith('projectOps.findXcworkspace', {
      path: '/tmp/hive'
    })
  })

  it('routes isAndroidProject through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.isAndroidProject('/tmp/hive')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('projectOps.isAndroidProject', {
      path: '/tmp/hive'
    })
  })

  it('routes initRepository through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue({ success: true })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.initRepository('/tmp/hive')).resolves.toEqual({ success: true })
    expect(request).toHaveBeenCalledWith('projectOps.initRepository', {
      path: '/tmp/hive'
    })
  })

  it('routes loadLanguageIcons through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue({ typescript: 'data:image/svg+xml;base64,abc' })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.loadLanguageIcons()).resolves.toEqual({
      typescript: 'data:image/svg+xml;base64,abc'
    })
    expect(request).toHaveBeenCalledWith('projectOps.loadLanguageIcons', {})
  })

  it('routes getProjectIconPath through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('data:image/png;base64,abc')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.getProjectIconPath('project-1.png')).resolves.toBe(
      'data:image/png;base64,abc'
    )
    expect(request).toHaveBeenCalledWith('projectOps.getProjectIconPath', {
      filename: 'project-1.png'
    })
  })

  it('routes getAbsoluteIconDataUrl through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('data:image/svg+xml;base64,abc')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.getAbsoluteIconDataUrl('/tmp/hive/public/favicon.svg')).resolves.toBe(
      'data:image/svg+xml;base64,abc'
    )
    expect(request).toHaveBeenCalledWith('projectOps.getAbsoluteIconDataUrl', {
      path: '/tmp/hive/public/favicon.svg'
    })
  })

  it('routes pickProjectIcon through the renderer RPC client', async () => {
    const pickProjectIcon = vi.fn().mockResolvedValue({ success: true, filename: 'project-1.png' })
    const request = vi.fn().mockResolvedValue({ success: true, filename: 'project-1.png' })
    const subscribe = vi.fn()

    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: {
        getLocalEnvironmentBootstrap: vi.fn(),
        pickProjectIcon
      }
    })
    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.pickProjectIcon('project-1')).resolves.toEqual({
      success: true,
      filename: 'project-1.png'
    })
    expect(request).toHaveBeenCalledWith('projectOps.pickProjectIcon', {
      projectId: 'project-1'
    })
    expect(pickProjectIcon).not.toHaveBeenCalled()
  })

  it('routes removeProjectIcon through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue({ success: true })
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.removeProjectIcon('project-1')).resolves.toEqual({ success: true })
    expect(request).toHaveBeenCalledWith('projectOps.removeProjectIcon', {
      projectId: 'project-1'
    })
  })

  it('routes detectFavicon through the renderer RPC client', async () => {
    const request = vi.fn().mockResolvedValue('favicon.png')
    const subscribe = vi.fn()

    setRendererRpcClient({ request, subscribe })

    await expect(projectApi.detectFavicon('/tmp/hive')).resolves.toBe('favicon.png')
    expect(request).toHaveBeenCalledWith('projectOps.detectFavicon', {
      path: '/tmp/hive'
    })
  })
})
