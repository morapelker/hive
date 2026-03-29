import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

type JsonRpcId = number

interface JsonRpcEnvelope {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: string }
}

interface ProbeTurnSummary {
  label: string
  interactionMode: 'plan' | 'default'
  turnId: string
  assistantDelta: string
  reasoningDelta: string
  planDelta: string
  finalAssistantMessage: string
  taskCompleteMessage: string
  requestMethods: string[]
  autoResponses: Array<{ method: string; detail: string }>
}

const PLAN_INSTRUCTIONS = [
  'Plan mode. Ask clarifying questions when useful.',
  'Understand the codebase first.',
  'Do not write code until the plan is clear.'
].join(' ')

class CodexProbeClient {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  private listeners = new Set<(message: JsonRpcEnvelope) => void>()

  constructor(tracePath: string) {
    this.child = spawn('codex', ['app-server'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const traceDir = dirname(tracePath)
    mkdirSync(traceDir, { recursive: true })
    const trace = createWriteStream(tracePath, { flags: 'w' })
    const stdout = createInterface({ input: this.child.stdout })

    stdout.on('line', (line) => {
      trace.write(`${line}\n`)

      let message: JsonRpcEnvelope
      try {
        message = JSON.parse(line) as JsonRpcEnvelope
      } catch {
        return
      }

      if (typeof message.id === 'number' && !message.method) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)

        if (message.error?.message) {
          pending.reject(new Error(message.error.message))
          return
        }

        pending.resolve(message.result)
        return
      }

      for (const listener of this.listeners) {
        listener(message)
      }
    })

    this.child.stderr.on('data', (chunk) => {
      trace.write(`STDERR ${chunk.toString()}`)
    })

    this.child.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
      }
      this.pending.clear()
      trace.end()
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'hive_codex_probe',
        title: 'Hive Codex Probe',
        version: '1.0.0'
      },
      capabilities: {
        experimentalApi: true
      }
    })

    this.notify('initialized', undefined)
  }

  async startThread(): Promise<string> {
    const result = await this.request('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    })

    const response = asObject(result)
    const thread = asObject(response?.thread)
    const threadId = asString(thread?.id) ?? asString(response?.threadId)
    if (!threadId) {
      throw new Error('thread/start did not return a thread id')
    }

    return threadId
  }

  async runTurn(
    threadId: string,
    label: string,
    text: string,
    interactionMode: 'plan' | 'default',
    questionAnswer: string
  ): Promise<ProbeTurnSummary> {
    const summary: ProbeTurnSummary = {
      label,
      interactionMode,
      turnId: '',
      assistantDelta: '',
      reasoningDelta: '',
      planDelta: '',
      finalAssistantMessage: '',
      taskCompleteMessage: '',
      requestMethods: [],
      autoResponses: []
    }

    const completion = new Promise<ProbeTurnSummary>((resolve) => {
      const onMessage = (message: JsonRpcEnvelope): void => {
        if (!message.method) return

        const params = asObject(message.params)
        const turnId = this.turnIdFor(message)
        if (turnId && summary.turnId && turnId !== summary.turnId) return

        if (typeof message.id === 'number') {
          summary.requestMethods.push(message.method)

          if (message.method === 'item/tool/requestUserInput') {
            const questions = Array.isArray(params?.questions) ? params.questions : []
            const answers = Object.fromEntries(
              questions.map((question) => {
                const questionRecord = asObject(question)
                const questionId = asString(questionRecord?.id) ?? 'question'
                return [questionId, { answers: [questionAnswer] }]
              })
            )

            summary.autoResponses.push({
              method: message.method,
              detail: questionAnswer
            })

            this.respond(message.id, { answers })
          }

          if (
            message.method === 'item/commandExecution/requestApproval' ||
            message.method === 'item/fileRead/requestApproval' ||
            message.method === 'item/fileChange/requestApproval'
          ) {
            summary.autoResponses.push({
              method: message.method,
              detail: 'once'
            })

            this.respond(message.id, { decision: 'once' })
          }
        }

        if (message.method === 'item/agentMessage/delta') {
          summary.assistantDelta += asString(params?.delta) ?? ''
        }

        if (
          message.method === 'item/reasoning/textDelta' ||
          message.method === 'item/reasoning/summaryTextDelta'
        ) {
          summary.reasoningDelta += asString(params?.delta) ?? ''
        }

        if (message.method === 'item/plan/delta') {
          summary.planDelta += asString(params?.delta) ?? asString(params?.text) ?? ''
        }

        if (message.method === 'item/completed') {
          const item = asObject(params?.item)
          if (asString(item?.type) === 'agentMessage') {
            summary.finalAssistantMessage = asString(item?.text) ?? summary.finalAssistantMessage
          }
        }

        if (message.method === 'codex/event/task_complete') {
          const msg = asObject(params?.msg)
          summary.taskCompleteMessage = asString(msg?.last_agent_message) ?? summary.taskCompleteMessage
        }

        if (message.method === 'turn/completed') {
          const completedTurnId = asString(asObject(params?.turn)?.id)
          if (summary.turnId && completedTurnId === summary.turnId) {
            this.listeners.delete(onMessage)
            resolve(summary)
          }
        }
      }

      this.listeners.add(onMessage)
    })

    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      collaborationMode: {
        mode: interactionMode,
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: PLAN_INSTRUCTIONS
        }
      }
    })

    const response = asObject(result)
    const turn = asObject(response?.turn)
    summary.turnId = asString(turn?.id) ?? asString(response?.turnId) ?? ''
    if (!summary.turnId) {
      throw new Error(`turn/start for ${label} did not return a turn id`)
    }

    return completion
  }

  close(): void {
    this.child.kill()
  }

  private turnIdFor(message: JsonRpcEnvelope): string | undefined {
    const params = asObject(message.params)
    const msg = asObject(params?.msg)

    return (
      asString(asObject(params?.turn)?.id) ??
      asString(params?.turnId) ??
      asString(msg?.turn_id) ??
      asString(params?.id)
    )
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private write(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function randomSuffix(): number {
  return Math.floor(Math.random() * 9000) + 1000
}

function isPlanMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return normalized.startsWith('plan\n') || normalized.startsWith('plan\r\n')
}

async function main(): Promise<void> {
  const suffix = randomSuffix()
  const initialPrompt = `add another function - mul_${suffix} which accepts x and returns x * ${suffix}`
  const clarificationReply =
    'Put it in src/shared/math.ts as a named TypeScript export. Add or update tests if needed. Stay in plan mode and do not make code changes yet.'

  const tracePath = resolve(
    process.cwd(),
    'dist',
    'codex-probe',
    `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  )

  const client = new CodexProbeClient(tracePath)

  try {
    await client.initialize()
    const threadId = await client.startThread()

    const turns: ProbeTurnSummary[] = []
    turns.push(
      await client.runTurn(threadId, 'initial-plan-turn', initialPrompt, 'plan', clarificationReply)
    )

    const latestPlanCandidate = turns[0].taskCompleteMessage || turns[0].finalAssistantMessage
    if (!isPlanMessage(latestPlanCandidate)) {
      turns.push(
        await client.runTurn(threadId, 'clarification-turn', clarificationReply, 'plan', clarificationReply)
      )
    }

    const finalTurn = turns[turns.length - 1]
    const finalPlanText = finalTurn.taskCompleteMessage || finalTurn.finalAssistantMessage

    const summary = {
      threadId,
      prompt: initialPrompt,
      tracePath,
      turns: turns.map((turn) => ({
        label: turn.label,
        interactionMode: turn.interactionMode,
        turnId: turn.turnId,
        requestMethods: turn.requestMethods,
        assistantDeltaPreview: turn.assistantDelta.slice(0, 240),
        reasoningDeltaPreview: turn.reasoningDelta.slice(0, 240),
        planDeltaPreview: turn.planDelta.slice(0, 240),
        finalAssistantMessage: turn.finalAssistantMessage,
        taskCompleteMessage: turn.taskCompleteMessage,
        autoResponses: turn.autoResponses
      })),
      conclusions: {
        textStreamsVia: 'item/agentMessage/delta',
        reasoningStreamsVia: ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'],
        planDeliveredVia:
          finalTurn.planDelta.length > 0
            ? 'item/plan/delta'
            : 'plain assistant message plus codex/event/task_complete before turn/completed',
        requestUserInputObserved: turns.some((turn) =>
          turn.requestMethods.includes('item/tool/requestUserInput')
        ),
        approvalRequestObserved: turns.some((turn) =>
          turn.requestMethods.some((method) => method.includes('requestApproval'))
        ),
        acceptPlanMechanism:
          'No dedicated plan approval request was observed. The practical acceptance path is a normal follow-up user turn (Hive\'s non-Claude "Implement" flow).',
        finalPlanLooksStructured: isPlanMessage(finalPlanText)
      }
    }

    console.log(JSON.stringify(summary, null, 2))
  } finally {
    client.close()
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
