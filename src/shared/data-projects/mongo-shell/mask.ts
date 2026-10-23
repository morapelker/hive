// Masks credentials in mongosh-style text: the one masker behind query history and the assistant
// on the server (maskForHistory / maskForAssistant) and the Mongo workspace's persisted drafts in
// the renderer (Shell text, query-bar fields, pipelines, recent filters). The Mongo counterpart
// of maskSqlSecrets. Covered:
//   key: '…' where the key, in any quoting ("auth.password", 'smtp-password', ["pwd"], `pwd`),
//     contains pwd / passwd / password / passphrase / secret / apiKey / privateKey, or ends in
//     token / accessKey (sessionToken, x-auth-token)   (createUser, $set paths, runCommand, KMS)
//   db.changeUserPassword(user, '…'), db.auth(user, '…'), db.createUser / addUser / updateUser
//     (user, '…')                                               (positional password argument)
//   every string of a `+` concatenation ('S3cret' + 'Pw', pre + 'fix')
//   scheme://user:pass@host                                     (connection strings anywhere)
//   the same inside comments, and half-typed (unterminated) strings
// Every masked string becomes '***' with its quote style kept. Token based (the shared shell
// lexer), so quotes inside comments, regexes or other strings cannot shift what is masked, and
// linear in the input. Over-masking a literal is harmless; leaving a password behind is not.
// `passwordDigestor`, non-string values (passwordPrompt(), numbers, objects) stay as they are.

import { maskUrlCredentials } from '../url-credentials'
import { lexShell, stringTokenValue, type ShellToken } from './shell-lexer'

const SECRET_KEY =
  /pwd|passw(?:or)?d|passphrase|secret|api_?key|private_?key|access_?key$|token$|^pass$/i
/** Keys that look like secrets but hold a setting ('server' / 'client'). */
const NOT_SECRET_KEY = /^passwordDigestor$/i

/** True when a value under this object key is a credential. */
export const isMongoSecretKey = (name: string): boolean =>
  SECRET_KEY.test(name) && !NOT_SECRET_KEY.test(name)

/** Methods whose second argument is a password when the first is a user name. */
const POSITIONAL_PASSWORD = new Set([
  'changeUserPassword',
  'auth',
  'addUser',
  'createUser',
  'updateUser'
])

const isPunct = (t: ShellToken | undefined, text: string): boolean =>
  t !== undefined && t.type === 'punct' && t.text === text
const isText = (t: ShellToken | undefined): t is ShellToken =>
  t !== undefined && (t.type === 'string' || t.type === 'template')
const isOpener = (t: ShellToken): boolean =>
  t.type === 'punct' && (t.text === '(' || t.text === '[' || t.text === '{')
const isCloser = (t: ShellToken): boolean =>
  t.type === 'punct' && (t.text === ')' || t.text === ']' || t.text === '}')

const maskedLiteral = (t: ShellToken): string => `${t.text[0]}***${t.text[0]}`

/** For each opening bracket, the index of its closing bracket (tokens.length when unclosed). */
function matchBrackets(tokens: ShellToken[]): Int32Array {
  const match = new Int32Array(tokens.length).fill(-1)
  const stack: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (isOpener(t)) stack.push(i)
    else if (isCloser(t) && stack.length > 0) match[stack.pop() as number] = i
  }
  for (const open of stack) match[open] = tokens.length
  return match
}

/** The text of a literal key token without its quotes (escapes decoded for plain strings). */
function literalKey(t: ShellToken | undefined): string | null {
  if (!isText(t)) return null
  if (t.type === 'string' && !t.unterminated) return stringTokenValue(t)
  return t.text.slice(1, t.unterminated ? undefined : -1)
}

/** The key of `key:` whose `:` is tokens[colon]: bare, quoted, or computed (["pwd"]). */
function keyBefore(tokens: ShellToken[], colon: number): string | null {
  const t = tokens[colon - 1]
  if (!t) return null
  if (t.type === 'ident') return t.text
  if (isText(t)) return literalKey(t)
  if (isPunct(t, ']') && isPunct(tokens[colon - 3], '[')) return literalKey(tokens[colon - 2])
  return null
}

/**
 * Marks every string of the value expression starting at tokens[from]: one operand or a `+`
 * chain of operands, where an operand is a string, a template, a number or a dotted name.
 */
function markValue(tokens: ShellToken[], from: number, masked: ShellToken[]): void {
  let k = from
  for (;;) {
    const t = tokens[k]
    if (t === undefined) return
    if (t.type === 'string' || t.type === 'template') {
      masked.push(t)
      k++
    } else if (t.type === 'ident' || t.type === 'number') {
      k++
      while (isPunct(tokens[k], '.') && tokens[k + 1]?.type === 'ident') k += 2
    } else return
    if (!isPunct(tokens[k], '+')) return
    k++
  }
}

/** Index of the first token of the call's second top-level argument, or -1. */
function secondArgument(tokens: ShellToken[], open: number, match: Int32Array): number {
  const close = match[open]
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]
    // Skip a nested group whole: each token is visited by the innermost call around it only.
    if (isOpener(t)) k = match[k]
    else if (isPunct(t, ',')) return k + 1 < close ? k + 1 : -1
  }
  return -1
}

/**
 * An apostrophe between two letters (what's, don't, I'm in prose around the shell code of an
 * assistant question): never a quote in valid JS, where a string cannot touch a word.
 */
const APOSTROPHE = /(?<=[A-Za-z])'(?=[A-Za-z])/g

function maskShellText(text: string, inComment: boolean): string {
  const all = lexShell(text.includes("'") ? text.replace(APOSTROPHE, '_') : text)
  const tokens = all.filter((t) => t.type !== 'comment')
  const match = matchBrackets(tokens)
  const masked: ShellToken[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (isPunct(t, ':')) {
      const key = keyBefore(tokens, i)
      if (key !== null && isMongoSecretKey(key)) markValue(tokens, i + 1, masked)
      continue
    }
    if (t.type === 'ident' && POSITIONAL_PASSWORD.has(t.text) && isPunct(tokens[i + 1], '(')) {
      const second = secondArgument(tokens, i + 1, match)
      if (second >= 0) markValue(tokens, second, masked)
    }
  }
  const replacements: Array<{ start: number; end: number; text: string }> = masked.map((t) => ({
    start: t.start,
    end: t.end,
    text: maskedLiteral(t)
  }))
  // A commented-out statement can carry a password too (one level: a comment holds no other).
  if (!inComment) {
    for (const c of all) {
      if (c.type !== 'comment') continue
      const block = c.text.startsWith('/*')
      const bodyEnd = block && !c.unterminated ? c.end - 2 : c.end
      const body = text.slice(c.start + 2, bodyEnd)
      const next = maskShellText(body, true)
      if (next !== body)
        replacements.push({
          start: c.start,
          end: c.end,
          text: text.slice(c.start, c.start + 2) + next + text.slice(bodyEnd, c.end)
        })
    }
  }
  if (replacements.length === 0) return text
  replacements.sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const r of replacements) {
    if (r.start < at) continue // the same string reached through two rules
    out += text.slice(at, r.start) + r.text
    at = r.end
  }
  return out + text.slice(at)
}

/** `text` with credential literals replaced by '***'. Never throws; linear in the input. */
export function maskMongoSecrets(text: string): string {
  if (!text) return text
  return maskUrlCredentials(maskShellText(text, false))
}
