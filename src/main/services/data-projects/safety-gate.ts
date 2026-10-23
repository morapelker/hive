// The safety gate: safe mode × environment × per-statement classification → run / confirm /
// block. Every path that can change a database goes through it on the server (editor queries,
// grid edits, exports of queries, Mongo writes, kill-process), so the renderer's own badge is
// only a prediction. Rules (design §6):
//
//   off        everything runs, unsandboxed. Dangerous statements still confirm (red dialog)
//              unless the environment is `local`.
//   half-safe  read/session auto-run (reads inside the DB read-only sandbox); anything else, or
//              anything dangerous, confirms.
//   safe       everything confirms (one dialog for the whole request).
//   read-only  read/session run (reads sandboxed); anything else is blocked outright. A dangerous
//              read (pg_sleep, SLEEP...) still confirms.
//
// Production + a destructive statement (DROP / TRUNCATE / DELETE|UPDATE without WHERE / Mongo
// deleteMany({}) ...) adds `typedConfirmation`: the confirm button stays disabled until the user
// types the target object's name.
//
// Confirm tokens are random, single-use, expire after 5 minutes and are bound to
// (project, database, source, fingerprint text) through a SHA-256 key, so a token issued for
// "DELETE FROM a" cannot run "DROP TABLE b". A valid token runs the whole request with writes
// unsandboxed (reads too: a sandbox rejection after confirmation would loop back to the dialog),
// except in read-only mode where reads always stay in the sandbox.

import { createHash, randomBytes } from 'node:crypto'
import {
  isAutoRunClass,
  type DataExecutionPlan,
  type DataPlannedStatement,
  type DataStatementClass
} from '../../../shared/data-projects/types'
import type {
  EvaluateSafety,
  SafetyDecision,
  SafetyEvaluationInput,
  SafetyStatementInput
} from './contracts'

export const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000
const MAX_TOKENS = 1000

export type ConfirmDecision = Extract<SafetyDecision, { action: 'confirm' }>
export type BlockDecision = Extract<SafetyDecision, { action: 'block' }>

export interface SafetyGateOptions {
  now?: () => number
  ttlMs?: number
  randomToken?: () => string
  maxTokens?: number
}

export interface SafetyGate {
  evaluate: EvaluateSafety
  /**
   * A statement that ran in the read-only sandbox was rejected by the database (it tried to
   * write). Read-only mode → block; otherwise → confirm the whole request, flagging it.
   */
  escalate(
    input: SafetyEvaluationInput,
    rejectedIndex: number,
    reason?: string
  ): ConfirmDecision | BlockDecision
  /** A block decided by the caller (e.g. exporting a write statement). */
  block(input: SafetyEvaluationInput, reason: string, blockedIndexes?: number[]): BlockDecision
  /** Number of live tokens (tests, diagnostics). */
  tokenCount(): number
  clear(): void
}

interface TokenRecord {
  key: string
  expiresAt: number
}

const CLASS_REASON: Record<DataStatementClass, string> = {
  read: 'reads data',
  session: 'changes session settings',
  tx: 'transaction control',
  lock: 'takes row or table locks',
  write: 'modifies data',
  ddl: 'changes the schema',
  admin: 'administrative command',
  unknown: 'statement type not recognised'
}

export const describeStatementClass = (cls: DataStatementClass): string => CLASS_REASON[cls]

const READ_ONLY_PREFIX = 'read-only mode: '

// ---------------------------------------------------------------------------------------------
// Typed confirmation target
// ---------------------------------------------------------------------------------------------

/** Dangerous reasons that need the target name typed on production. */
const DESTRUCTIVE_REASON =
  /\b(drop|dropped|drops|truncate|truncates|dropdatabase|dropindexes|deletemany|updatemany|remove)\b|\$out\b|without\s+(a\s+)?where|(delete|deletes|update|updates)\s+(all|every)|empty\s+filter|\{\s*\}/i

export const isDestructive = (
  statement: Pick<SafetyStatementInput, 'dangerous' | 'text'>
): boolean => statement.dangerous.some((reason) => DESTRUCTIVE_REASON.test(reason))

const IDENT = '(?:`(?:[^`]|``)+`|"(?:[^"]|"")+"|\\[[^\\]]+\\]|[\\p{L}\\p{N}_$@#-]+)'
const QUALIFIED = `(${IDENT}(?:\\s*\\.\\s*${IDENT})*)`

const SQL_TARGET_PATTERNS: RegExp[] = [
  new RegExp(
    `^drop\\s+(?:temporary\\s+)?(?:table|view|materialized\\s+view|database|schema|index|sequence|function|procedure|trigger|type|event|dictionary|user|role|collection)\\s+(?:concurrently\\s+)?(?:if\\s+exists\\s+)?${QUALIFIED}`,
    'iu'
  ),
  new RegExp(`^truncate\\s+(?:table\\s+)?(?:if\\s+exists\\s+)?(?:only\\s+)?${QUALIFIED}`, 'iu'),
  new RegExp(
    `^delete\\s+(?:low_priority\\s+|quick\\s+|ignore\\s+)*from\\s+(?:only\\s+)?${QUALIFIED}`,
    'iu'
  ),
  new RegExp(`^update\\s+(?:low_priority\\s+|ignore\\s+|only\\s+)*${QUALIFIED}`, 'iu'),
  new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QUALIFIED}`, 'iu')
]

const unquoteIdent = (part: string): string => {
  const p = part.trim()
  if (p.startsWith('`') && p.endsWith('`')) return p.slice(1, -1).replace(/``/g, '`')
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/""/g, '"')
  if (p.startsWith('[') && p.endsWith(']')) return p.slice(1, -1)
  return p
}

const lastIdentPart = (qualified: string): string => {
  const parts = qualified.match(new RegExp(IDENT, 'gu')) ?? [qualified]
  return unquoteIdent(parts[parts.length - 1] ?? qualified)
}

/** Strips leading whitespace and comments so the first keyword is at offset 0. */
const stripLeadingComments = (text: string): string => {
  let s = text
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--') || s.startsWith('#')) s = s.replace(/^[^\n]*\n?/, '')
    else if (s.startsWith('/*') && !s.startsWith('/*!') && !s.startsWith('/*M!')) {
      const end = s.indexOf('*/')
      s = end < 0 ? '' : s.slice(end + 2)
    }
    if (s === before) return s
  }
}

/** Best-effort object name of a destructive statement (SQL or mongosh). */
export function extractTargetName(text: string): string | null {
  const body = stripLeadingComments(text)
  // mongosh: db.dropDatabase() → caller falls back to the database name.
  if (/^db\s*\.\s*dropDatabase\s*\(/.test(body)) return null
  const getColl = body.match(/^db\s*\.\s*getCollection\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1\s*\)/)
  if (getColl) return getColl[2].replace(/\\(.)/g, '$1')
  const dotted = body.match(/^db\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/)
  if (dotted) return dotted[1]
  const bracket = body.match(/^db\s*\[\s*(['"])((?:\\.|(?!\1).)+)\1\s*\]/)
  if (bracket) return bracket[2]
  for (const pattern of SQL_TARGET_PATTERNS) {
    const m = body.match(pattern)
    if (m?.[1]) return lastIdentPart(m[1])
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

interface Assessment {
  planned: DataPlannedStatement
  blocked: boolean
  sandbox: boolean
}

function assess(input: SafetyEvaluationInput, statement: SafetyStatementInput): Assessment {
  const { safeMode, environment } = input.project
  const cls = statement.classification
  const autoRun = isAutoRunClass(cls)
  const dangerous = statement.dangerous.length > 0
  // Prefer the classifier's specific reason ("calls nextval(), which has side effects") over
  // the generic class label, which would call a side-effecting SELECT "modifies data".
  const classReason = statement.reasons?.find((r) => r.trim()) ?? CLASS_REASON[cls]
  const reasons: string[] = []
  let needsConfirmation = false
  let blocked = false

  switch (safeMode) {
    case 'off':
      if (dangerous && environment !== 'local') {
        needsConfirmation = true
        reasons.push('dangerous statement')
      }
      break
    case 'half-safe':
      if (!autoRun) {
        needsConfirmation = true
        reasons.push(classReason)
      } else if (dangerous) {
        needsConfirmation = true
        reasons.push('dangerous statement')
      }
      break
    case 'safe':
      needsConfirmation = true
      reasons.push('safe mode confirms every statement')
      if (!autoRun) reasons.push(classReason)
      break
    case 'read-only':
    default:
      if (!autoRun) {
        blocked = true
        reasons.push(`${READ_ONLY_PREFIX}${classReason}`)
      } else if (dangerous) {
        needsConfirmation = true
        reasons.push('dangerous statement')
      }
      break
  }

  return {
    planned: {
      index: statement.index,
      text: statement.text,
      start: statement.start,
      end: statement.end,
      classification: cls,
      dangerous: [...statement.dangerous],
      reasons,
      needsConfirmation
    },
    blocked,
    // Only plain reads go into the sandbox: a USE/SET (session) inside BEGIN READ ONLY ...
    // ROLLBACK would be rolled back on PG, and nothing else auto-runs.
    sandbox: safeMode !== 'off' && cls === 'read'
  }
}

function typedConfirmationFor(
  input: SafetyEvaluationInput,
  statements: readonly SafetyStatementInput[]
): string | undefined {
  if (input.project.environment !== 'production') return undefined
  const destructive = statements.filter((s) => isDestructive(s))
  if (destructive.length === 0) return undefined
  const fallback =
    input.database ||
    input.project.config.database ||
    input.project.config.filePath ||
    input.project.name
  const targets = new Set<string>()
  for (const statement of destructive) {
    const explicit = statement.targets?.find((t) => t.trim().length > 0)
    // Classifier targets are usually plain `schema.table` text; quoted forms go through the lexer.
    const name = explicit
      ? /[`"[]/.test(explicit)
        ? lastIdentPart(explicit)
        : (explicit.split('.').pop() ?? explicit).trim()
      : extractTargetName(statement.text)
    targets.add(name && name.length > 0 ? name : fallback)
  }
  // Several different objects: the database name is the one thing that covers all of them.
  if (targets.size === 1) return [...targets][0]
  return fallback
}

function makePlan(
  input: SafetyEvaluationInput,
  planned: DataPlannedStatement[],
  statements: readonly SafetyStatementInput[]
): DataExecutionPlan {
  const plan: DataExecutionPlan = {
    dataProjectId: input.project.id,
    projectName: input.project.name,
    engine: input.project.engine,
    environment: input.project.environment,
    safeMode: input.project.safeMode,
    database: input.database ?? input.project.config.database,
    statements: planned
  }
  const typed = typedConfirmationFor(input, statements)
  if (typed) plan.typedConfirmation = typed
  return plan
}

function blockReason(blocked: Assessment[]): string {
  const classes = [...new Set(blocked.map((a) => a.planned.classification))]
  if (blocked.length === 1) {
    const a = blocked[0]
    const n = a.planned.index + 1
    const label = CLASS_REASON[a.planned.classification]
    const detail = a.planned.reasons
      .find((r) => r.startsWith(READ_ONLY_PREFIX))
      ?.slice(READ_ONLY_PREFIX.length)
    return detail && detail !== label
      ? `Read-only mode: statement ${n} is not allowed (${detail}).`
      : `Read-only mode: statement ${n} ${label} and is not allowed.`
  }
  return `Read-only mode: ${blocked.length} statements would change the database (${classes
    .map((c) => CLASS_REASON[c])
    .join(', ')}) and are not allowed.`
}

const bindingKey = (input: SafetyEvaluationInput): string =>
  createHash('sha256')
    .update(input.project.id)
    .update('\u0000')
    .update(input.database ?? '')
    .update('\u0000')
    .update(input.source)
    .update('\u0000')
    .update(input.fingerprintText)
    .digest('hex')

export function createSafetyGate(options: SafetyGateOptions = {}): SafetyGate {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? CONFIRM_TOKEN_TTL_MS
  const maxTokens = options.maxTokens ?? MAX_TOKENS
  const randomToken = options.randomToken ?? (() => randomBytes(24).toString('base64url'))
  const tokens = new Map<string, TokenRecord>()

  const purge = (): void => {
    const t = now()
    for (const [token, record] of tokens) if (record.expiresAt <= t) tokens.delete(token)
    // Map iteration is insertion order: drop the oldest when a client floods us with requests.
    while (tokens.size >= maxTokens) {
      const oldest = tokens.keys().next().value
      if (oldest === undefined) break
      tokens.delete(oldest)
    }
  }

  const issue = (input: SafetyEvaluationInput): string => {
    purge()
    let token = randomToken()
    while (tokens.has(token)) token = randomToken()
    tokens.set(token, { key: bindingKey(input), expiresAt: now() + ttlMs })
    return token
  }

  /** Consumes the token when it is valid for exactly this request. */
  const redeem = (input: SafetyEvaluationInput): boolean => {
    const token = input.confirmToken
    if (!token) return false
    const record = tokens.get(token)
    if (!record) return false
    if (record.expiresAt <= now()) {
      tokens.delete(token)
      return false
    }
    // A token presented for a different request stays valid for its own request.
    if (record.key !== bindingKey(input)) return false
    tokens.delete(token)
    return true
  }

  const evaluate: EvaluateSafety = (input) => {
    const assessments = input.statements.map((s) => assess(input, s))
    const blocked = assessments.filter((a) => a.blocked)
    if (blocked.length > 0) {
      return {
        action: 'block',
        plan: makePlan(
          input,
          assessments.map((a) => a.planned),
          input.statements
        ),
        reason: blockReason(blocked)
      }
    }

    if (redeem(input)) {
      const readOnly = input.project.safeMode === 'read-only'
      return { action: 'run', sandboxReads: assessments.map((a) => readOnly && a.sandbox) }
    }

    if (assessments.some((a) => a.planned.needsConfirmation)) {
      return {
        action: 'confirm',
        plan: makePlan(
          input,
          assessments.map((a) => a.planned),
          input.statements
        ),
        confirmToken: issue(input)
      }
    }

    return { action: 'run', sandboxReads: assessments.map((a) => a.sandbox) }
  }

  const escalate: SafetyGate['escalate'] = (input, rejectedIndex, reason = 'tried to write') => {
    const assessments = input.statements.map((s) => assess(input, s))
    const planned = assessments.map((a) => {
      if (a.planned.index !== rejectedIndex) return a.planned
      return {
        ...a.planned,
        reasons: [...a.planned.reasons, `${reason} (rejected by the database's read-only sandbox)`],
        needsConfirmation: input.project.safeMode !== 'read-only'
      }
    })
    const plan = makePlan(input, planned, input.statements)
    if (input.project.safeMode === 'read-only') {
      return {
        action: 'block',
        plan,
        reason: `Read-only mode: statement ${rejectedIndex + 1} ${reason} and is not allowed.`
      }
    }
    return { action: 'confirm', plan, confirmToken: issue(input) }
  }

  const block: SafetyGate['block'] = (input, reason, blockedIndexes) => {
    const planned = input.statements.map((s) => {
      const a = assess(input, s).planned
      if (blockedIndexes && !blockedIndexes.includes(s.index)) return a
      return { ...a, reasons: [...a.reasons, reason], needsConfirmation: false }
    })
    return { action: 'block', plan: makePlan(input, planned, input.statements), reason }
  }

  return {
    evaluate,
    escalate,
    block,
    tokenCount: () => {
      purge()
      return tokens.size
    },
    clear: () => tokens.clear()
  }
}

const defaultGate = createSafetyGate()

/** The process-wide gate (tokens must survive between the confirm round-trip's two requests). */
export const evaluateSafety: EvaluateSafety = (input) => defaultGate.evaluate(input)
export const escalateSandboxRejection: SafetyGate['escalate'] = (input, index, reason) =>
  defaultGate.escalate(input, index, reason)
export const blockSafety: SafetyGate['block'] = (input, reason, indexes) =>
  defaultGate.block(input, reason, indexes)
export const defaultSafetyGate = (): SafetyGate => defaultGate
