import { createHash } from 'node:crypto'

/**
 * Codex CLI hook injection.
 *
 * The claude CLI takes its hooks as `--settings <json>` with an `http` handler
 * type that POSTs straight to Hive's hook server. The codex TUI (codex-cli
 * 0.153) has a hooks system with the same event vocabulary but only `command`
 * / `mcp_tool` handlers, and hooks are configured through config layers rather
 * than a flag. Two codex facts shape everything here:
 *
 * 1. `-c 'hooks.<Event>=[{hooks=[{type="command",command="…"}]}]'` overrides
 *    are read as the "session flags" config layer and DO contribute hooks
 *    (`codex-rs/hooks/src/engine/discovery.rs`, `load_toml_hooks_from_layer`).
 *    So Hive injects per-session hooks without touching `~/.codex`.
 * 2. Hooks are trust-gated: an untrusted hook is silently skipped unless the
 *    user reviews it in the TUI ("Hooks need review") or the config carries a
 *    matching `hooks.state.<key>.trusted_hash`. The hash is deterministic —
 *    sha256 over the canonical JSON of the normalized handler — and the
 *    session-flags layer may supply `hooks.state` too, so Hive pre-trusts
 *    exactly the hooks it injects (`-c 'hooks.state={…}'`). No
 *    `--dangerously-bypass-hook-trust` (which would also admit every
 *    untrusted hook in the user's own files and print a warning banner).
 *
 * The command handler is a curl shim: codex writes the event JSON to the
 * hook's stdin and treats its stdout as the hook output, so `curl --data-binary
 * @-` against the hook server reproduces claude's http hooks exactly — the
 * server's response body becomes the hook's JSON reply.
 */

/** Codex hook events Hive subscribes to and the server path each one posts to. */
export const CODEX_CLI_HOOK_EVENTS: ReadonlyArray<{ event: CodexHookEventName; path: string }> = [
  { event: 'SessionStart', path: 'session' },
  { event: 'SessionEnd', path: 'session' },
  { event: 'UserPromptSubmit', path: 'start' },
  { event: 'Stop', path: 'stop' },
  { event: 'Interrupt', path: 'stop' },
  { event: 'SubagentStart', path: 'subagent' },
  { event: 'SubagentStop', path: 'subagent' },
  { event: 'PreToolUse', path: 'tool' },
  { event: 'PostToolUse', path: 'tool' },
  { event: 'PermissionRequest', path: 'permission' }
]

export type CodexHookEventName =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'Interrupt'

/** `hook_event_key_label` in codex-rs/hooks/src/lib.rs — the snake_case label used in trust keys and hashes. */
export const CODEX_HOOK_EVENT_LABELS: Record<CodexHookEventName, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
  Interrupt: 'interrupt'
}

/** Synthetic source path codex assigns to hooks that arrive through `-c` overrides (`synthetic_layer_path`). */
export const CODEX_SESSION_FLAGS_HOOK_SOURCE = '/<session-flags>/config.toml'

/** codex default hook timeout, and the SessionEnd/Interrupt default + cap (`events/session_end.rs`). */
const DEFAULT_HOOK_TIMEOUT_SEC = 600
const SESSION_END_DEFAULT_TIMEOUT_SEC = 1
const SESSION_END_MAX_TIMEOUT_SEC = 3

/**
 * How long the curl shim waits for the hook server. Well under the codex hook
 * timeout so a stalled server fails the hook (codex continues) instead of
 * freezing the TUI for ten minutes; long enough for the server's normal
 * synchronous work. SessionEnd/Interrupt hooks are killed by codex after 3s
 * regardless, and a localhost POST completes in milliseconds.
 */
const CURL_MAX_TIME_SEC = 20

export interface CodexCommandHook {
  command: string
  /** Explicit timeout in seconds (omit for codex's per-event default). */
  timeoutSec?: number
  async?: boolean
  statusMessage?: string
}

function resolveHookTimeoutSec(event: CodexHookEventName, timeoutSec: number | undefined): number {
  if (event === 'SessionEnd' || event === 'Interrupt') {
    const value = timeoutSec ?? SESSION_END_DEFAULT_TIMEOUT_SEC
    return Math.min(Math.max(value, 1), SESSION_END_MAX_TIMEOUT_SEC)
  }
  return Math.max(timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC, 1)
}

/**
 * Recursively sort object keys — codex's `canonical_json` — so the compact
 * serialization is byte-identical to the one codex hashes.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key])
    }
    return sorted
  }
  return value
}

/**
 * The trust hash codex computes for a command hook (`hook_hash` in
 * codex-rs/hooks/src/engine/discovery.rs + `version_for_toml` in
 * codex-rs/config/src/fingerprint.rs): the normalized identity
 * `{event_name, matcher?, hooks:[{type:"command", command, timeout:<resolved>,
 * async, statusMessage?}]}` serialized as TOML → JSON → key-sorted compact JSON
 * → sha256. `commandWindows` is dropped from the identity; a default
 * `additionalContextLimit` is omitted. Known vector (verified against codex
 * 0.153.4's `hooks/list`): a Stop hook running `/tmp/codex-hook-probe/hook.sh`
 * hashes to `sha256:1f82e2f79ad43ede047010d5f31328ed0787935478340593c5589f7dfc8f5844`.
 */
export function computeCodexHookTrustHash(
  event: CodexHookEventName,
  hook: CodexCommandHook,
  matcher?: string
): string {
  const identity: Record<string, unknown> = {
    event_name: CODEX_HOOK_EVENT_LABELS[event],
    hooks: [
      {
        type: 'command',
        command: hook.command,
        timeout: resolveHookTimeoutSec(event, hook.timeoutSec),
        async: hook.async ?? false,
        ...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {})
      }
    ]
  }
  if (matcher !== undefined) identity.matcher = matcher
  const serialized = JSON.stringify(canonicalize(identity))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

/** `hook_key(source, event, group, handler)` — the `hooks.state` key of an injected hook. */
export function codexSessionFlagsHookKey(
  event: CodexHookEventName,
  groupIndex = 0,
  handlerIndex = 0
): string {
  return `${CODEX_SESSION_FLAGS_HOOK_SOURCE}:${CODEX_HOOK_EVENT_LABELS[event]}:${groupIndex}:${handlerIndex}`
}

/**
 * Quote a string as a TOML basic string. Everything Hive puts in overrides
 * (URLs, absolute paths, the curl command) is plain ASCII, but paths may carry
 * backslashes (Windows) or quotes, so escape the full basic-string set.
 */
export function tomlString(value: string): string {
  let out = '"'
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"'
        break
      case '\\':
        out += '\\\\'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\t':
        out += '\\t'
        break
      default: {
        const code = ch.codePointAt(0) ?? 0
        if (code < 0x20 || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, '0')}`
        } else {
          out += ch
        }
      }
    }
  }
  return out + '"'
}

export function codexCliHookUrl(port: number, hiveSessionId: string, path: string): string {
  return `http://127.0.0.1:${port}/codex-hook/${encodeURIComponent(hiveSessionId)}/${path}`
}

/**
 * The shell command codex runs for a hook: forward stdin to the hook server
 * and print its reply. `|| echo '{}'` keeps a dead/unreachable server (the app
 * quit, the port changed) from failing the hook in codex's UI — the TUI just
 * runs on without Hive following it. Windows codex runs `commandWindows`
 * through cmd.exe; `curl.exe` ships with Windows 10+.
 */
export function buildCodexCliHookCommand(port: number, hiveSessionId: string, path: string): string {
  const url = codexCliHookUrl(port, hiveSessionId, path)
  return `curl -sS -m ${CURL_MAX_TIME_SEC} -X POST -H 'content-type: application/json' --data-binary @- ${url} 2>/dev/null || echo '{}'`
}

export function buildCodexCliHookCommandWindows(
  port: number,
  hiveSessionId: string,
  path: string
): string {
  const url = codexCliHookUrl(port, hiveSessionId, path)
  return `curl.exe -sS -m ${CURL_MAX_TIME_SEC} -X POST -H "content-type: application/json" --data-binary @- ${url} 2>nul || echo {}`
}

export interface CodexCliHookOverrides {
  /** `-c key=value` pairs, one per hook event plus the trust state, ready to splice into argv. */
  args: string[]
  /** hooks.state key → trusted hash, for diagnostics/tests. */
  trustedHashes: Record<string, string>
}

/**
 * Build the `-c` overrides that install Hive's hooks for one session and
 * pre-trust them. One matcher-less group with one command handler per event,
 * so every key is `/<session-flags>/config.toml:<label>:0:0`.
 *
 * The state must ride as a single inline table (`hooks.state={…}`): codex's
 * `-c` parser splits the key path on `.` without quoted-segment support, so a
 * dotted path containing the `.toml` of the hook key would be mangled.
 */
export function buildCodexCliHookOverrides(port: number, hiveSessionId: string): CodexCliHookOverrides {
  const args: string[] = []
  const trustedHashes: Record<string, string> = {}
  const stateEntries: string[] = []

  for (const { event, path } of CODEX_CLI_HOOK_EVENTS) {
    const command = buildCodexCliHookCommand(port, hiveSessionId, path)
    const commandWindows = buildCodexCliHookCommandWindows(port, hiveSessionId, path)
    // SessionEnd/Interrupt default to 1s in codex; give the POST the full
    // (capped) 3s so a briefly busy server still receives the event.
    const timeoutSec = event === 'SessionEnd' || event === 'Interrupt' ? SESSION_END_MAX_TIMEOUT_SEC : undefined
    const hook: CodexCommandHook = { command, timeoutSec }
    const handler =
      `{type="command",command=${tomlString(command)},commandWindows=${tomlString(commandWindows)}` +
      (timeoutSec !== undefined ? `,timeout=${timeoutSec}` : '') +
      '}'
    args.push('-c', `hooks.${event}=[{hooks=[${handler}]}]`)

    const key = codexSessionFlagsHookKey(event)
    const hash = computeCodexHookTrustHash(event, hook)
    trustedHashes[key] = hash
    stateEntries.push(`${tomlString(key)}={trusted_hash=${tomlString(hash)}}`)
  }

  args.push('-c', `hooks.state={${stateEntries.join(',')}}`)
  return { args, trustedHashes }
}
