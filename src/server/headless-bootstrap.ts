import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadHeadlessConfig } from './config'
import { ensureTlsCerts, generateTlsCerts, getCertFingerprint } from './tls'
import { generateApiKey, hashApiKey, BruteForceTracker } from './plugins/auth'
import { getEventBus } from './event-bus'
import { startGraphQLServer, type ServerHandle } from './index'
import { getDatabase } from '../main/db'
import { resolveClaudeBinaryPath } from '../main/services/claude-binary-resolver'
import { ClaudeCodeImplementer } from '../main/services/claude-code-implementer'
import { AgentSdkManager } from '../main/services/agent-sdk-manager'
import type { AgentSdkImplementer } from '../main/services/agent-sdk-types'
import { rmSync } from 'node:fs'

export interface HeadlessBootstrapOpts {
  port?: number
  bind?: string
}

let serverHandle: ServerHandle | null = null

export async function headlessBootstrap(opts: HeadlessBootstrapOpts): Promise<void> {
  const config = loadHeadlessConfig()
  const port = opts.port ?? config.port
  const bind = opts.bind ?? config.bindAddress

  // Initialize database (same singleton as GUI mode)
  const db = getDatabase()

  // Resolve Claude binary
  const claudeBinaryPath = resolveClaudeBinaryPath()

  // Create AgentSdkManager (headless — no mainWindow)
  const claudeImpl = new ClaudeCodeImplementer()
  claudeImpl.setDatabaseService(db)
  claudeImpl.setClaudeBinaryPath(claudeBinaryPath)

  const openCodePlaceholder = {
    id: 'opencode' as const,
    capabilities: {
      supportsUndo: true,
      supportsRedo: true,
      supportsCommands: true,
      supportsPermissionRequests: true,
      supportsQuestionPrompts: true,
      supportsModelSelection: true,
      supportsReconnect: true,
      supportsPartialStreaming: true
    },
    connect: async () => ({ sessionId: '' }),
    reconnect: async () => ({ success: false }),
    disconnect: async () => {},
    cleanup: async () => {},
    prompt: async () => {},
    abort: async () => false,
    getMessages: async () => [],
    getAvailableModels: async () => ({}),
    getModelInfo: async () => null,
    setSelectedModel: () => {},
    getSessionInfo: async () => ({ revertMessageID: null, revertDiff: null }),
    questionReply: async () => {},
    questionReject: async () => {},
    permissionReply: async () => {},
    permissionList: async () => [],
    undo: async () => ({}),
    redo: async () => ({}),
    listCommands: async () => [],
    sendCommand: async () => {},
    renameSession: async () => {},
    setMainWindow: () => {}
  } satisfies AgentSdkImplementer
  const sdkManager = new AgentSdkManager(openCodePlaceholder, claudeImpl)

  // EventBus singleton
  const eventBus = getEventBus()

  // Ensure TLS certs (skip in insecure/HTTP mode)
  let fingerprint: string | null = null
  if (!config.insecure) {
    const tlsDir = join(homedir(), '.hive', 'tls')
    fingerprint = ensureTlsCerts(tlsDir, (fp) => {
      db.setSetting('headless_cert_fingerprint', fp)
    })
  }

  // Ensure API key
  let existingHash = db.getSetting('headless_api_key_hash')
  if (!existingHash) {
    const newKey = generateApiKey()
    existingHash = hashApiKey(newKey)
    db.setSetting('headless_api_key_hash', existingHash)
    console.log('\n=== Hive Headless API Key (save this!) ===')
    console.log(newKey)
    console.log('==========================================\n')
  }

  // Brute force tracker
  const bruteForce = new BruteForceTracker({
    maxAttempts: config.security.bruteForceMaxAttempts,
    windowMs: config.security.bruteForceWindowSec * 1000,
    blockMs: config.security.bruteForceBlockSec * 1000
  })

  // Periodic cleanup
  const cleanupInterval = setInterval(() => bruteForce.cleanup(), 60_000)

  // Start GraphQL server
  serverHandle = startGraphQLServer({
    port,
    bindAddress: bind,
    insecure: config.insecure,
    ...(config.insecure
      ? {}
      : { tlsCert: config.tls.certPath, tlsKey: config.tls.keyPath }),
    context: { db, sdkManager, eventBus },
    getKeyHash: () => db.getSetting('headless_api_key_hash') || '',
    bruteForce
  })

  const protocol = config.insecure ? 'http' : 'https'
  console.log(`Hive headless server running on ${protocol}://${bind}:${port}/graphql`)
  if (fingerprint) {
    console.log(`TLS fingerprint: ${fingerprint}`)
  }

  // Handle shutdown
  process.on('SIGTERM', async () => {
    clearInterval(cleanupInterval)
    await serverHandle?.close()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    clearInterval(cleanupInterval)
    await serverHandle?.close()
    process.exit(0)
  })
}

export interface ManagementCommandOpts {
  rotateKey?: boolean
  regenCerts?: boolean
  showStatus?: boolean
  kill?: boolean
  unlock?: boolean
}

export async function handleManagementCommand(opts: ManagementCommandOpts): Promise<void> {
  const db = getDatabase()
  const hiveDir = join(homedir(), '.hive')

  if (opts.rotateKey) {
    const newKey = generateApiKey()
    const hash = hashApiKey(newKey)
    db.setSetting('headless_api_key_hash', hash)
    console.log('\n=== New API Key ===')
    console.log(newKey)
    console.log('===================\n')
    console.log('API key rotated successfully. Update your mobile app.')
  }

  if (opts.regenCerts) {
    const tlsDir = join(hiveDir, 'tls')
    // Remove old certs
    rmSync(join(tlsDir, 'server.crt'), { force: true })
    rmSync(join(tlsDir, 'server.key'), { force: true })
    // Regenerate
    generateTlsCerts(tlsDir)
    const fingerprint = getCertFingerprint(join(tlsDir, 'server.crt'))
    db.setSetting('headless_cert_fingerprint', fingerprint)
    console.log('TLS certificates regenerated.')
    console.log(`New fingerprint: ${fingerprint}`)
  }

  if (opts.showStatus) {
    const statusPath = join(hiveDir, 'hive-headless.status.json')
    try {
      const { readFileSync } = await import('node:fs')
      const status = JSON.parse(readFileSync(statusPath, 'utf-8'))
      console.log(JSON.stringify(status, null, 2))
    } catch {
      console.log('No running headless server found (no status file).')
    }
  }

  if (opts.kill) {
    const pidPath = join(hiveDir, 'hive-headless.pid')
    try {
      const { readFileSync } = await import('node:fs')
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim())
      process.kill(pid, 'SIGTERM')
      console.log(`Sent SIGTERM to PID ${pid}`)
    } catch {
      console.log('No running headless server found (no PID file).')
    }
  }

  if (opts.unlock) {
    db.setSetting('headless_locked', '')
    console.log('Headless server unlocked.')
  }
}
