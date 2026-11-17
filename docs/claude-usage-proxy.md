# Real-time Claude usage via the local API proxy

Hive shows each Claude account's subscription usage (the 7-day window
and, on plans that still have one, the 5-hour window) in the usage bars. Until
this proxy existed the numbers came only from polling
`GET https://api.anthropic.com/api/oauth/usage` on timers, with a burn-rate
predictor guessing between polls. Now the Claude Code processes the app
launches talk to Anthropic through a loopback proxy, and the proxy reads the
usage Anthropic already returns on every response.

One kind of session cannot use the proxy: an interactive Claude CLI session
that asks for Code Mode, which the CLI offers only when it talks to the
Anthropic API directly. Such a session is launched off the proxy, and its usage
is read from a log of response headers that the CLI writes to disk while the
session runs. That second transport, the file it writes and what those sessions
give up are described in
[Code Mode sessions](#code-mode-sessions-usage-from-the-clis-debug-log).

The 5-hour window is not a given: Anthropic dropped that limit from many plans
in late 2026. For such an account the poll reports `five_hour: null` (its
`limits[]` array has no `session` row) and `/v1/messages` responses carry no
`anthropic-ratelimit-unified-5h-*` headers at all, only the `-7d-*` set with
`-representative-claim: seven_day`. Both paths keep that as `five_hour: null`
in `UsageData` (null means "no such window", not "unknown"), and the UI draws
no 5h bar for the account instead of a fake 0%.

## How it works

```
claude (PTY / Agent SDK / tmux / terminal)
   │  ANTHROPIC_BASE_URL=http://127.0.0.1:42411
   ▼
Electron main — claude-api-proxy (src/main/services/claude-api-proxy/)
   │  bytes forwarded unchanged (SSE streamed, compression untouched)
   ▼
https://api.anthropic.com   (or the user's own ANTHROPIC_BASE_URL gateway)
```

1. **`main/index.ts`** awaits `startClaudeApiProxy()` right after `loadShellEnv()`
   and before the backend child is spawned. On success it exports
   `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and
   `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` on `process.env`, so the server
   child, PTYs, Ghostty surfaces, tmux launches, the Agent SDK and title
   generation all inherit them. The spawn builders for the Claude CLI and the
   Agent SDK additionally spread `getClaudeApiProxyEnv()` last, so an
   `ANTHROPIC_BASE_URL` configured in Settings → Environment Variables becomes
   the proxy's *upstream* instead of bypassing it. The one launch that leaves
   the proxy is an interactive CLI session that asks for Code Mode: its spawn
   adds none of this and removes the two inherited variables
   ([The launch](#the-launch)).
2. **`local-api-proxy.ts`** is a provider-agnostic tunnel on Node's `http`/`https`:
   it strips only hop-by-hop headers, streams request and response bodies
   through byte-for-byte (`content-length`, `content-encoding` and
   `accept-encoding` pass untouched), propagates client aborts upstream, and
   answers an Anthropic-shaped `502` when the upstream is unreachable. It rejects
   non-loopback peers and foreign `Host` headers. Observers receive the request
   headers (credentials removed), a bounded copy of the request body and the
   response headers as soon as the upstream answers. The tunnel writes none of
   that to disk: with performance logging on it records one line per request
   (method, path, status, timings and the request id, no other header and no
   body), and nothing otherwise. This holds for the proxy only. Live usage does
   put response headers on disk in one place, the log of a Code Mode session,
   which never passes through the tunnel
   ([The header log on disk](#the-header-log-on-disk)).
   The upstream TLS leg trusts the same roots the CLI does when it terminates
   TLS itself — Node's bundled roots, the OS trust store (where corporate
   TLS-inspection roots live) and any `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`
   bundle, honouring `CLAUDE_CODE_CERT_STORE` — because Electron's Node only
   reads those variables at launch, and a Dock-launched app has no shell env
   then. Waking from sleep drops only idle pooled upstream sockets; in-flight
   streams are left to resume or fail on their own.
3. **`anthropic-rate-limit-headers.ts`** parses `anthropic-ratelimit-unified-*`
   (`-5h-utilization`, `-5h-reset`, `-7d-*`, `-7d_<bucket>-*`, `-status`,
   `-representative-claim`, `-overage-*`). Utilization is a 0..1 fraction on the
   wire and becomes 0..100 percent; resets are epoch seconds and become ISO
   strings — the same `UsageData` shape the polled endpoint produces. A window
   the headers do not name is carried over from the last poll, or stays null;
   it is never fabricated as 0%. It also
   pulls the `account_uuid` out of the request body's `metadata.user_id` with a
   byte search (no full JSON parse of multi-megabyte bodies); that uuid is only
   a last-resort attribution key, see below.
4. **`claude-usage-live-updater.ts`** attributes each observation to the managed
   account whose access token the request carried — the account Anthropic
   actually bills. The tunnel hands it a SHA-256 fingerprint of the bearer token
   (never the token), and the account store exposes each managed account's
   current token fingerprint. The live credentials are compared first: nearly
   every request carries the signed-in account's token, so one Keychain read
   settles it (and captures a live account nothing manages yet) without reading
   every account's entry. Only a token that is not the live one — a request
   still in flight on the account just switched away from — needs the
   per-account list. A token nobody recognises triggers at most one rescan
   (rotations), backs off, and is dropped rather than guessed. Resolutions are
   cached per token, and the identity file is re-parsed only when its stat
   changes. It then merges the header windows into that
   account's `saved_usage_accounts.last_usage_json` (keeping `extra_usage` and
   the per-model windows only the poll provides) **without touching the row's
   `last_fetched_at` / `status`** — those describe the last poll, which keeps
   its own cadence — and publishes `usage:claudeLive`. It also decides, against
   the CLI's own identity file (rewritten by a switch before the switch reports
   success), whether the request's account is the one signed in right now
   (`isLiveAccount`). Bursts are coalesced per account (leading + trailing edge,
   250 ms).
5. **Renderer**: `useClaudeLiveUsageListener` feeds `useUsageStore.applyClaudeLiveUsage`,
   which updates the attributed row's snapshot in the popover and — only when
   the payload says the account is the live one and the observation postdates
   the renderer's own switch stamp — the bottom bar, the rate-limit overlay
   (without triggering the overlay's early poll) and `anthropicUsageFromFetch`.
   It never advances `anthropicLastFetchedAt` or clears a pending Retry-After:
   the usage-endpoint poll stays the owner of its clock. The popover shows
   **Live** instead of a refresh countdown while updates are fresh, and the
   burn-rate predictor stands down.

Attribution is by the credential on each request, not by the selected account
and not by the `account_uuid` the client reports. Both matter when accounts are
switched while sessions run:

- a request already in flight on the previous account's token keeps updating
  *that* account's row;
- a running CLI adopts the new account's token from the Keychain within
  moments of a switch but keeps stamping `metadata.user_id` with the account it
  started on. Going by that uuid credited the new account's usage to the old
  account (and never marked the new one live); going by the token credits the
  account that is billed.

The reported uuid is used only where no token can be read to compare against.

A reading from a Code Mode session comes from a log in which the token is
masked, so it cannot be placed by its credential. It is placed by the
organization the response was billed to, through the organization stored per
account, and never by the reported uuid
([Attribution by organization](#attribution-by-organization)).

Independently, the identity file must never carry another account's uuid or
organization (new sessions read it). `switchClaudeAccount` drops the outgoing
account's `accountUuid` when the target's uuid is unknown instead of leaving it
behind. Whether or not the uuid is known, it writes the organization stored for
the target (`saved_usage_accounts.org_uuid`) as `organizationUuid`, or removes
the field when none is stored, and removes `profileFetchedAt`, so the CLI
fetches the new account's profile on its next launch. Selecting the account
that is already live leaves its block as the CLI wrote it, unless the stored
organization disagrees with the one in the file. On startup the proxy repairs
an identity file an older switch left inconsistent (only when the proxy starts:
with the proxy disabled or skipped there is no repair): a uuid that belongs to a
different managed account, an organization that differs from the one stored for
the live account, or, when nothing is stored for the live account, an
organization stored for a different account.

### How an account's organization is learned

The stored organization is learned from this traffic. A proxied response also
carries `anthropic-organization-id`, the organization that was billed. When the
request's token placed it on a managed account, the updater stores that value
as the account's `org_uuid`, replacing an older one and writing nothing when it
is already there. A request placed by the reported uuid, or not placed at all,
teaches nothing, and neither does a response without the header. A token's
first pairing with the signed-in account is not stored from straight away (a
switch caught half applied can pair the incoming token with the outgoing
identity): it is looked at again about 16 seconds later and stored once the
pairing held, so a single request is still enough. Only responses that carry
usage headers are looked at.

An account that sends no proxied traffic (one that only runs Code Mode
sessions, or one that is not signed in) learns its organization directly, with
its own credential, in the server child where the accounts' tokens are used:

- **The usage poll.** A successful `/api/oauth/usage` response names the
  organization in the same `anthropic-organization-id` header.
  `fetchClaudeUsage` hands it back and the per-account poll
  (`fetchForSavedAccount`) stores it for the account it polled, inside that
  account's lock. The poll already runs for every managed account at launch and
  for a new account right after sign-in, so this costs no request. Only a 2xx
  is read; a failed or rate-limited poll teaches nothing and is reported
  exactly as before. The signed-in account's own fetch (`usage:fetch`) stores
  nothing and does not pass the organization on to the renderer.
- **The organization learner** (`claude-organization-learner.ts`), for the
  accounts the poll left without one: the poll failed or is backing off, or the
  row was created without a poll (an imported shared account, the signed-in
  account captured by its first fetch) or deleted and recreated. It asks for
  the account's profile (`GET /api/oauth/profile`, `organization.uuid` in the
  body), a request of its own that leaves the poll's clock, its rate limit and
  the account's row alone. Account maintenance runs it once the launch poll is
  over and then every minute; it only looks at rows with no organization, so an
  account that has one is never asked about. It reads the account's token
  under the account lock and sends the request outside it, never refreshes a
  token, and stores nothing over a value that arrived meanwhile. A failure
  stores nothing and is retried per account after 5 minutes, doubling up to 6
  hours; an account that cannot be asked (no token, or one about to expire,
  which is left to the token watcher) waits the same way. A 429 is honoured
  for at least its `retry-after` and pauses the learner for every account for
  that long (a minute when none is given).

The two processes are connected both ways. When the live updater holds a
reading for an organization no account is mapped to, it asks for organizations
(`setClaudeOrganizationsNeededHandler`, connected at app start by
`connectClaudeOrganizationLearning`): the request travels to the server child
as the `usage:claudeOrganizationsNeeded` backend event and starts a learner
sweep at once, within the same back-off. When the child stores an organization,
from either source, it tells main (the `claudeOrganizationLearned` desktop
command), and the updater applies the readings it was holding
(`notifyClaudeOrganizationsLearned`) without waiting for its one-second
re-check.

### The usage poll

The polled path (`/api/oauth/usage`) remains as the fallback for idle accounts,
for the first load, and for the fields the headers do not carry (extra usage,
per-model weekly windows). Live updates do not move the poll's clock
(`anthropicLastFetchedAt`, and `last_fetched_at` on the account's row): the
poll keeps its own cadence whatever arrives live, from either transport. What
stands down while the newest live reading is less than two minutes old
(`LIVE_USAGE_FRESH_MS`) is the burn-rate predictor's early poll, and the
popover says **Live** for that long.

## The proxy host process

The tunnel runs in its own Electron utility process
(`claude-proxy-host.ts`, bundled as `out/main/claude-proxy-host.js`), managed by
`claude-proxy-host-manager.ts` in main. Main still owns the policy (the upstream
URL, re-read from Settings every 15 s and pushed down; the perf-logging switch)
and the consumers (the live usage updater, the DB, the Keychain); the host only
owns sockets. Each exchange crosses the boundary without its body — the host
extracts the account uuid from the body itself.

Why: main also hosts PTYs, file watchers, SQLite, the usage sweep and the hook
server, all sharing one libuv thread pool. When that pool wedged (async file
reads and `getaddrinfo` stopped completing while the event loop stayed
responsive), every session's request hung for the CLI's full 4 + 10 minute
timeout and only an app restart helped. Now:

- the host resolves `api.anthropic.com` with c-ares (`upstream-dns.ts`, cached,
  `getaddrinfo` only as a deadline-bound fallback), so DNS never waits on the
  pool;
- a fresh upstream socket must finish TCP + TLS within
  `HIVE_CLAUDE_API_PROXY_CONNECT_TIMEOUT_MS` (default 15 s) or the CLI
  gets a retryable 502 at once;
- the host runs the thread-pool heartbeat (`threadpool-probe.ts`) and exits
  with code 70 when it stalls; main pings it every 15 s and restarts it after
  two missed pongs, an exit, or a stall report — on the same port (retried for
  8 s before falling back to an ephemeral one), with a budget of 5 restarts per
  10 minutes before backing off a minute;
- every request outcome is logged with its phase (`connecting`, `sending`,
  `waiting`, `streaming`) and elapsed time, so "the client gave up after
  600 s" is no longer logged as "upstream request failed", and error statuses
  are logged with the Anthropic error type and `request-id`.

`HIVE_CLAUDE_API_PROXY_HOST=in-process` keeps the tunnel inside main
(tests and environments without `utilityProcess` do this automatically).

## Session recovery

`claude-cli-session-recovery.ts` watches `StopFailure` hooks. A failure that
looks transient (no response, connection lost, the Mac slept, 5xx/529) arms a
recovery: 20 s later, and every 30 s after, main asks the host to probe
`GET /v1/models` through the proxy; once any HTTP answer comes back and the
session is still idle on that failure with no user input since, a short
"continue" prompt is typed into its PTY (the same path Telegram uses). At most
3 resumes per session per hour; 30 minutes before giving up; off via Settings →
Advanced → "Resume sessions after API errors". The renderer shows a toast on
each resume (`claude-cli:auto-resume`).

## Code Mode sessions: usage from the CLI's debug log

The Claude CLI's experimental Code Mode (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`)
starts only when the CLI talks to the Anthropic API directly:
`ANTHROPIC_BASE_URL` has to be unset or name `api.anthropic.com`, and
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` does not change that. Behind the
proxy the CLI says "Code Mode (experimental) isn't available" and starts with
its ordinary tools.

So an interactive session that asks for Code Mode is launched off the proxy,
and the app reads its usage from the CLI's own debug log instead. At log level
`debug` the Anthropic SDK inside the CLI logs the headers of every API
response; the CLI is told to write those lines to a file of the app's choosing,
and the app follows that file.

```
claude --debug-file <launch dir>/usage.log --debug=console.log
   │  ANTHROPIC_LOG=debug, no ANTHROPIC_BASE_URL: talks to api.anthropic.com directly
   ▼  appends a few lines per API request
<data dir>/claude-cli-debug/<launch>/usage.log
   ▼  followed and parsed in Electron main (claude-debug-log/)
ClaudeUsageLiveUpdater ── usage:claudeLive ──▶ renderer
   (the same updater, event and usage bars as the proxy's readings)
```

The feature was specified in a product requirements document (the PRD) that is
not part of this repository; code comments and this section cite its
requirements by number (FR-5, SEC-10 and so on). This section describes what
was built. Where the two differ, this document follows the code, and the
differences are listed in [Differences from the PRD](#differences-from-the-prd).

### Which sessions get it

One place decides: `createClaudeCliTerminal`, for a Claude CLI process that is
about to start in a local PTY (`ClaudeCliUsageLaunches.decide`, with the rules
in `claude-usage-transport.ts`). Each such launch gets one of three transports:

| Transport | When | The launch |
| --- | --- | --- |
| `proxy` | The default. Also whenever Code Mode could not work anyway (below). | As described above. |
| `debug-log` | Code Mode is requested, nothing excludes it, and live usage for Code Mode sessions is on. | Off the proxy; the debug log is written and followed. |
| `none` | Code Mode is requested and nothing excludes it, but live usage for Code Mode sessions is off (the setting, the kill switch, or the auto-disable), or the launch's directory could not be prepared. | Off the proxy, so Code Mode works; no debug options and nothing on disk. The session's usage comes from the usage poll. |

Code Mode counts as requested when `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` is
exactly `1` (spaces around it are ignored; `true`, `yes` and any other value do
not count) in the first of these sources that defines the variable:

1. Settings → Environment Variables;
2. the app's own environment, which holds the login shell's variables;
3. the `env` block of the user-level Claude settings file (`settings.json` in
   `CLAUDE_CONFIG_DIR`, `~/.claude` by default). Project, local and managed
   settings files are not read.

The first source that defines the variable decides, also when it turns it off:
`0` or an empty value in Settings beats `1` in the shell.

A launch stays on `proxy`, whatever was asked, when Code Mode could not work
for it. The same three sources are read, in the same order:

- the session runs through a custom provider command (the app cannot see what
  that command sets);
- the user has an `ANTHROPIC_BASE_URL` of their own whose host is not exactly
  `api.anthropic.com` (a value that cannot be parsed counts as such);
- a third-party provider variable is set (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`,
  `_FOUNDRY`, `_ANTHROPIC_AWS`, `_ANTHROPIC_GOOGLE_CLOUD`).

Nothing is decided for the other ways the app runs Claude, so they are
unchanged and Code Mode stays unavailable in them:

- Agent SDK sessions, headless (`-p`) runs, title generation and the data
  assistant. They must never get the debug options: outside the interactive
  terminal the SDK's log goes to standard output, which those callers parse.
- Remote tmux launches. They outlive the app, so following their log would
  need a stored path and a restart of the follower; they stay on the proxy.
- A `claude` typed by hand into an in-app terminal. That shell inherits the
  proxy's address.

On Windows the launch directory is never prepared, so a Code Mode session there
gets `none`.

The decision is made once per process. A view that attaches to a session whose
process is already running decides nothing, and a session that is started again
(a restart, a resume) is a new launch, decided afresh. The setting and the kill
switch therefore take effect with the next process that starts. If the decision
itself fails, the launch stays on the proxy. Each launch that asks for Code
Mode writes one line to the app log (`ClaudeUsageTransport`, "Usage transport
for a Code Mode launch") with the transport, the source and the exclusion, and
never a variable's value.

The decision does not depend on the proxy. With the proxy disabled
(`HIVE_DISABLE_CLAUDE_API_PROXY=1`) or skipped for a corporate proxy,
mTLS or a unix socket, a Code Mode session still gets `debug-log`, and the live
updater it feeds exists whether or not the proxy started
(`claude-usage-live.ts`, built on first use; `submitClaudeUsageObservation` is
its entry point).

### The launch

`buildClaudeCliPtySpawn` (`claude-cli-spawner.ts`) changes four things for a
`debug-log` launch:

- **Arguments** `--debug-file <launch dir>/usage.log --debug=console.log`,
  after the other options and before the prompt. `--debug-file` turns the CLI's
  debug mode on and names the file. `--debug=console.log` lets only the SDK's
  lines into it. The filter is a security control as much as a matter of size:
  unfiltered, the CLI's debug log holds paths under the home directory, the
  standard error of MCP servers and fragments of shell commands.
- **`ANTHROPIC_LOG=debug`**, the only level at which the SDK logs response
  headers.
- **`CLAUDE_ENV_FILE=<launch dir>/env.sh`**, a file of the app's that takes
  `ANTHROPIC_LOG` out again for the shell commands the session runs (below).
- **No proxy.** The proxy's variables are not added, and `ANTHROPIC_BASE_URL`
  and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` are removed from the
  environment the PTY inherits from the app (`PtyCreateOpts.unsetEnv`; leaving
  them out is not enough, because the running proxy exports both on the app's
  own environment). Only what the app put there is removed: when the launch
  carries the user's own `ANTHROPIC_BASE_URL` from Settings, that address stays
  and only the marker goes, and when the proxy is not running nothing is
  removed.

Both variables are set after the user's own, so an `ANTHROPIC_LOG` or a
`CLAUDE_ENV_FILE` from Settings or the shell cannot override them. A `none`
launch leaves the proxy in the same way and adds nothing else: a user's own
`ANTHROPIC_LOG` or `CLAUDE_ENV_FILE` reaches the session as before.

`env.sh` holds one command, `unset ANTHROPIC_LOG`. The CLI runs the file's text
in front of every shell command of the session, so the commands Claude runs do
not see the variable; with it, any script that uses an Anthropic SDK would
print its requests, prompts included. When the user has a `CLAUDE_ENV_FILE` of
their own (Settings, else the app's environment), the app's file sources it
first, so it keeps its effect:

```sh
if [ -f '/path/to/their/file' ]; then . '/path/to/their/file'; fi
unset ANTHROPIC_LOG
```

Hook commands and MCP servers are not covered by that file; see the
[known limitation](#known-limitation-hooks-and-mcp-servers-inherit-anthropic_logdebug)
below.

Two limits of the launch:

- The two variables are set in the process environment only. The CLI applies
  the `env` block of the user's Claude settings files over its environment, so
  an `ANTHROPIC_LOG` or a `CLAUDE_ENV_FILE` set there could still lower the log
  level or replace the environment file. This was not tested. A lowered log
  level shows as a degraded session
  ([Health and fallback](#health-and-fallback)).
- Whether the CLI still applies the environment file when the user sets
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` was not measured. A reading of the CLI
  binary suggested it does not; shell commands would then see
  `ANTHROPIC_LOG=debug`.

### What the user sees

- **The debug banner.** At the top of the session the CLI prints
  "Debug mode enabled · logging to `<launch dir>/usage.log`", and the PRD
  expects a "Debug" tag in its status line. Neither can be switched off while
  the debug log is in use, and the app does not try to hide them: the feature
  uses the CLI's documented options, and by the PRD's reading of the CLI its
  start-up telemetry records that debug mode is on. The only explanation
  inside the app is the description of the setting below.
- **Code Mode itself.** With Code Mode on, the CLI shows "Code Mode
  (experimental) is on · this session can be resumed only with Code Mode on".
- **The CLI's consent dialog.** Until it has been accepted once, the CLI asks
  for consent to Code Mode, and the dialog's default answer is "No, start
  without it". With "No" the session runs without Code Mode but is still a
  `debug-log` launch: it stays off the proxy and its usage is still read live.
  After "Yes, turn on Code Mode" the CLI restarts itself with the same
  arguments and environment, and the log and the options survive that.
- **A session resumed into Code Mode.** A session first started without Code
  Mode and resumed with it requested gets the `debug-log` launch, and its log
  is read, while the CLI says "Code Mode is on, but this session isn't using
  it".
- **The usage bars.** Unchanged. A reading from the log arrives on the same
  `usage:claudeLive` event as a proxied one, and the popover says **Live** in
  the same way.

### The setting and the kill switch

Two switches turn live usage for Code Mode sessions off. Either one gives new
Code Mode launches the transport `none`: Code Mode keeps working, there is no
debug banner and no log on disk, and the session's usage comes from the usage
poll. Both are read at each launch decision, with no caching, so they apply to
the next process that starts; a running session keeps what it was started
with.

- **Settings → Advanced → "Live usage in Code Mode sessions"**, on by default.
  It is stored as `claudeCodeModeLiveUsage` in the `app_settings` blob, and
  only a stored `false` turns it off: a fresh install, an older blob and a
  database that cannot be read all count as on. Its description reads: "Keep
  the usage bars up to date while a Claude session runs in Code Mode. Those
  sessions show a "Debug mode enabled" line and write a small diagnostic log,
  which Hive deletes when the session ends. Turn this off and Code Mode
  keeps working, with usage updated less often."
- **`HIVE_DISABLE_CLAUDE_DEBUG_USAGE`**, the kill switch. Unset, empty,
  `0`, `false` and `no` leave the feature alone; any other value (`1`, `true`,
  `yes`, ...) turns it off, whatever the setting says. It is read from
  Settings → Environment Variables first and the app's environment second.
  The settings page does not show that the kill switch is in force: the switch
  can read on while the feature is off.

The main process asks both through `isClaudeDebugUsageEnabled`
(`claude-api-proxy/claude-debug-usage-setting.ts`).

### The header log on disk

This is the one place where live usage writes to disk.

**Where.** Each launch of the CLI gets a directory of its own:

```
<data dir>/claude-cli-debug/<sessionId>-<app pid>-<16 hex digits>/
```

`<data dir>` is the directory of the app's database, `~/.hive` by default (a
verify slot or another isolated instance has its own). The directory is per
launch and never reused, because the log does not say which session wrote it
and because the CLI drops files beside its log. The app's process id is part of
the name because two apps can run on one data directory (a development build
beside the installed app), and each must leave the other's directories alone.

| File | Made by | What it is |
| --- | --- | --- |
| `usage.log` | the app, empty; the CLI appends to it | The debug log. |
| `env.sh` | the app | The environment file of [The launch](#the-launch). |
| `usage.log.old` | the app | The log after the app retired it at 1 MiB; deleted once it has been read to its end. |
| `usage.log.1` | the CLI | The log after the CLI's own rotation at 10 MiB; deleted by the app once read to its end. |
| `latest` | the CLI | A symbolic link the CLI keeps next to its log. |

**Who can read it.** The directory has mode 0700 and the two files 0600: the
current user only. It is never under `/tmp` or another shared place, because
the CLI follows a symbolic link at the log path, and a directory someone else
can write to would let them point the log at any file of the user. Nothing that
already exists is adopted: every piece is created exclusively, and the launch
becomes `none` when anything is already at the target, or when
`claude-cli-debug` is not a real directory of the current user with mode 0700
exactly (a looser one is refused, not tightened). After a rotation the CLI
recreates the log with the permissions the umask gives; the app sets it back
to 0600 when it opens it, and refuses to read a symbolic link, anything that is
not a regular file, or a file owned by someone else.

**What it contains.** With the filter, only the lines of the Anthropic SDK: a
few per API request, each a timestamp, a level and the SDK's text.

- The request line: method, URL, the model's name, a summary of the body cut
  off at the first level (`messages: [Array]`, `system: [Array]`,
  `tools: [Array]`) and the request headers: user agent, the beta header list,
  the SDK's own `x-stainless-*` headers.
- The response lines: URL, status and the response headers. That is the
  rate-limit headers the app is after, `anthropic-organization-id`, the request
  id, the Cloudflare ray id and the date; for a failed request also the API's
  error message.

The PRD's list of what identifies anything in the file (measured on CLI
2.1.326): organization id, workspace id, request ids, client request id, prompt
id, user agent, beta header list, Cloudflare ray id.

**What it does not contain.** This is what the PRD's captures and the lines
kept as parser fixtures show, all written by CLI 2.1.326:

- No access token and no API key. `authorization` is masked twice, by the SDK
  and then by the CLI's redactor, and reads `[REDACTED]` in the file.
- Nothing else the CLI's redactor masks: the value of any header whose name
  contains `token`, `key`, `secret`, `cookie` or `session-id`. That covers
  `set-cookie` and the CLI's session id, and also harmless ones such as
  `anthropic-ratelimit-tokens-remaining`. The unified rate-limit headers and
  the organization id are not affected.
- No e-mail address and no account id.
- No prompt, file content, command or tool output: request bodies are cut off
  at the first level, as shown above. The captures made for the PRD had no
  token-like string and no hit for prompt text, file contents, commands,
  outputs or planted fake secrets.
- No output of hooks or MCP servers: in the sessions measured for the
  limitation below, no line of a child process reached the filtered file. The
  parser does not depend on that. It reads a line only when its text starts
  with the SDK's own prefix, so SDK output quoted inside another entry is
  ignored.

The filter and the masking are the CLI's and the SDK's, not the app's, so the
app does not rely on them alone. The file is treated as internal diagnostic
data: it stays in its private directory, and it is never uploaded or copied.
What the app takes from a line is the line's time, the HTTP status, the
`anthropic-ratelimit-unified-*` headers and the organization id. A line is
parsed in memory and dropped. No line, and nothing else read from the file,
goes to the app log, the performance log, the database or a usage report; a
line that cannot be read is counted, not recorded.

**How large it gets.** About 4.4 KB per API request and nothing while the
session is idle (the PRD's measurement). The app retires the log once it is at
least 1 MiB and has been read to its end, so a running session holds about
1 MiB plus a retired file for the moment it takes to read it. A log larger than
32 MiB is deleted unread and the session becomes degraded (`hard-cap`).

**When it is deleted.**

- When the process of the launch ends, whatever ended it: the log is read one
  last time, then the whole directory is deleted. Closing a session does not
  delete it directly; the exit of its process does, a moment later. A CLI that
  still runs would make the directory again on its next log line, and not a
  private one.
- At once, when the process never started.
- At quit, once the PTYs have been reaped. Two cases keep their directory
  (still private) for the sweep of the next start: a process that was told to
  end just before the quit and has not reported its end, and every process
  when the reap fails.
- By the sweep, at app start and every hour. It deletes the directories of
  app processes that are no longer running (a crash, a force quit) and of this
  process's sessions that have no launch, and it leaves the directories of
  another app process that is still running. A launch whose process is gone
  without its exit ever being reported is ended by the second sweep in a row
  that finds it so, which means its directory can stay for up to two hours.

So the setting's "deletes when the session ends" is the normal case; after a
crash or a force quit the directory is deleted at the next start.

The directory is the work of `ClaudeCliDebugDirs`
(`claude-cli-debug-dir.ts`), and when it is made and deleted is decided by
`ClaudeCliUsageLaunches` (`claude-cli-usage-launches.ts`).

### Reading the log

`ClaudeDebugLogUsageSource` (`claude-debug-log/claude-debug-log-usage-source.ts`)
follows the log of every running `debug-log` launch. A launch is registered
before its process starts and unregistered, after a final read, when it ends.

- **One timer for all sessions**, and none while no session is registered. A
  busy session is checked every 250 ms, an idle one every 2 seconds. Busy means
  a turn is in progress (the session's hook status is `working` or
  `planning`), or it is less than 15 seconds since the session was registered,
  its log grew or its turn ended. The 15 seconds cover the requests no turn
  announces: the start-up quota check, title generation, background agents.
- **Cheap checks.** A check of an unchanged log is one `lstat`. One check reads
  at most 256 KiB; a backlog continues on the next. Everything is synchronous,
  bounded file work on the main thread, which keeps it off the libuv thread
  pool that has wedged before. A check that was missed (a blocked event loop, a
  sleeping Mac) is not made up for.
- **Complete lines only** (`DebugLogFollower`,
  `claude-debug-log-follower.ts`). A partial line waits for its newline, and a
  line longer than 1 MiB is skipped. The follower keeps its own descriptor on
  the file, so a log that is renamed or deleted under it, by the CLI's rotation
  or the app's own, is read to its end before the new file at the path is read
  from the start. Its limits: lines in a log that is truncated in place before
  they were read are lost, and a log that is replaced twice between two checks
  loses the file in the middle.
- **Two kinds of entry are read** (`parseClaudeDebugLogLine`,
  `claude-debug-log/claude-debug-log-entry-parser.ts`): `response start`,
  written when a response's headers arrive and before its first streamed byte,
  and `response error (…)`, written for any failed request. A plan-limit 429
  is expected to arrive that way; a real one was not captured. A masked header
  value counts as absent. The headers go through the same
  `parseUnifiedRateLimitHeaders` as a proxied response's, so the weekly window,
  the 5-hour window where the plan has one, and model-scoped buckets come out
  the same.

Every entry that carries usage and an organization becomes one observation for
the live updater: no credential fingerprint, no account uuid, the organization,
the session's id, and as its time the timestamp written in the log line, not
the moment it was read. An entry without usage (a 404, say) or without a
readable organization is dropped and counted.

The target is a reading published within 500 ms of the response starting, at
the 95th percentile, for a session with a turn in progress: up to 250 ms until
the next check and up to 250 ms of the updater's coalescing. The unit test that
measures it writes the log itself, so the CLI's own write delay (up to 60 ms in
the PRD's measurements) comes on top.

### Attribution by organization

The log holds neither the token nor an account id, so a reading from it cannot
be placed the way a proxied one is. Each entry does name the organization the
request was billed to (`anthropic-organization-id`), and the updater places the
reading through the organization stored per account
(`saved_usage_accounts.org_uuid`, compared trimmed and lower-cased). The stored
organizations are read from the database for every reading, and only accounts
that are still in the account store count.

- **Exactly one managed account has the organization:** it is credited, whether
  or not it is the signed-in one. This is what keeps an account switch in the
  middle of a response right: the entry of the request in flight was written
  when its headers arrived, under the organization of the account it was billed
  to, and the next request's entry names the new one.
- **No managed account has it:** the reading is not guessed at. The newest
  reading for that organization is held in memory (one per organization, 20
  organizations at most) for 60 seconds from its arrival, and the updater asks
  for organizations to be learned, at most once a minute per organization. Held
  readings are looked at again every second, and at once when an organization
  is stored. A reading whose organization got an account in time is applied;
  the others are dropped, with the app-log line "Live Claude usage for an
  organization no managed account is mapped to; dropped" (`ClaudeUsageLive`,
  the first 8 characters of the organization, at most once per 10 minutes per
  organization).
- **Several managed accounts share it:** see the limit below.

Whether the credited account is the signed-in one (`isLiveAccount`, which
decides whether the bottom bar moves) is found as for a proxied reading, by
comparing its e-mail with the identity file's. The identity file's organization
is not used for that. Bursts are coalesced per organization (leading and
trailing edge, 250 ms), where proxied readings are coalesced per credential.

How the stored organizations get there is described in
[How an account's organization is learned](#how-an-accounts-organization-is-learned):
from proxied traffic, from the usage poll and from the organization learner.
An account that only ever runs Code Mode sessions depends on the last two. Two
things follow for Code Mode readings:

- An account's organization has to be stored before its readings can be placed.
  The launch poll normally stores it, so this costs nothing; until it is
  stored, the 60-second hold above covers the gap.
- A stored organization can be out of date: when the same e-mail signs in
  again under a different organization, the old value stays until the next
  successful poll replaces it (the learner only fills an empty one). Readings
  in between are held and dropped as "no managed account is mapped to". The
  same line is what to look for when a Code Mode session never shows **Live**:
  it was seen once in a verify slot, for an account whose stored organization
  differed from the billed one, and was not explained.

**The shared-organization limit.** Two managed accounts in the same
organization (seats of one team) cannot be told apart from the log. A reading
for such an organization goes to the signed-in account, and only when that
account is one of them and no account switch happened in the 30 seconds before
the reading. The 30 seconds are measured from the reading's own time, so a
reading made before a switch and read late from the log is dropped. Anything
else is dropped, never held and never guessed, with the app-log line "Live
Claude usage for an organization several accounts share; not attributed" and
the reason `not-signed-in` or `recent-switch`. For team seats this means:

- a Code Mode session still running on the seat that is no longer signed in
  gives no live readings; that seat's numbers come from the usage poll;
- readings are dropped for 30 seconds after a switch;
- "the last switch" is the `lastUpdated` stamp of the account index
  (`sequence.json`), or the moment the updater itself saw the signed-in e-mail
  change. Adding or removing an account moves that stamp too, so it can report
  a switch that was not one, never miss one made through the index;
- a switch writes the identity file a few milliseconds before it stamps the
  index. A reading that lands in that gap could be credited to the new
  account.

Personal subscriptions each have an organization of their own, so this concerns
team seats. The rule was tested with simulated accounts, not with a real team.

### Health and fallback

The log's format belongs to the CLI and can change with an update, and a log
the CLI cannot write fails without a word. A `debug-log` session whose log
gives no readings is **degraded**:

| Reason | When |
| --- | --- |
| `log-empty` | A turn completed and nothing was ever read from the log: it is missing or empty. An unwritable location looks like this, because the CLI then runs normally and writes nothing. |
| `unparsed-responses` | A turn completed, responses were logged (the SDK's "succeeded with status" line, or a response entry that could not be read) and no response entry has ever been read. A changed format looks like this, and so does a log level below `debug`. |
| `hard-cap` | The app deleted a log larger than 32 MiB. Reported at once. |
| `unsafe-file` | A symbolic link, something that is not a regular file, or a file of another user is at the log's path. Reported at once. |

The first two are judged when a turn completes and at no other time: when the
session's hook status goes from `working` or `planning` to `completed` or
`unread`. A session that sent no request has nothing in its log to be wrong,
and a turn that waits for the person (a question, a permission) is not judged.

Falling back needs nothing switched over. The usage poll runs on its own
schedule whatever a session's transport is, so for a degraded session the
poll's numbers are simply the only ones left. What happens is the telling:

- One warning per launch in the app log (`ClaudeCliUsageLaunches`): "The debug
  log of a Code Mode session gives no usage readings: its usage comes from the
  usage poll", with the session id, the reason, the CLI's version and counters
  (turns completed, bytes read, status lines, entries parsed, parse failures),
  and nothing from the log.
- The event `usage:claudeLiveHealth` (`{ provider, sessionId, degraded,
  reason, at }`). The usage store takes **Live** back when it rested on that
  session's last reading, and the popover returns to its refresh countdown. A
  reading that session gave before it went quiet is still applied to the bars,
  without the Live mark.

A degraded launch stays a `debug-log` launch and keeps being followed. It is
healthy again with the next response entry that can be read, also one without
usage figures; the recovery is logged at info level and published on the same
event. A session that is restarted or resumed is a new launch and can warn
again.

### Auto-disable for a CLI version

After a CLI update that changes the log, every new Code Mode session would
start with the debug banner, give no readings and fall back to the poll. So the
launches are counted by how they turn out
(`claude-debug-log/claude-debug-usage-auto-disable.ts`):

- **A failure:** the launch's log became degraded before one response in it
  could be read, whatever the reason.
- **Healthy:** a response in the launch's log could be read. This is looked for
  when a turn completes, when a degraded launch recovers and in the final read.
- **Neither:** a launch that made no request or completed no turn, one that
  started as `none`, and one whose CLI version is not known.

Three failures in a row on one version of the Claude CLI switch the debug log
off for it: new Code Mode launches get `none`. A healthy launch in between
starts the count again, each launch counts once, and launches that are running
keep their debug log.

- The switch-off is for one CLI version on one app version. The CLI's version
  is what `claude --version` prints for the binary the session starts, asked
  again when the file behind that path changes.
- It is kept in the database (the `settings` rows
  `claude_code_mode_usage.auto_disable` and
  `claude_code_mode_usage.auto_disable_notice`), so it survives a restart. What
  is stored is two version strings, a count and a time, and nothing of a log.
- It is lifted by the first launch decision that finds the CLI's version or the
  app's version changed. Nothing else lifts it: there is no expiry and no
  switch for it in Settings.
- When in doubt the debug log stays on: a database that cannot be read, a
  record that is not one, and an unknown version all mean "not switched off",
  and are not counted.
- The person is told once per switch-off, by a warning toast that stays until
  it is closed: "Live usage is unavailable in Code Mode with this version of
  Claude Code", and under it "Hive could not read live usage from
  Claude Code `<version>`. Code Mode sessions keep working, with usage updated
  less often, until Claude Code or Hive is updated." The cue
  (`usage:claudeCodeModeLiveUsageUnavailable`) goes to every window and comes
  again with each launch that is kept off the debug log until one window has
  claimed the notice (`usageOps.claimCodeModeUsageUnavailableNotice`).
- The app log has a warning at the switch-off (`ClaudeDebugUsageAutoDisable`,
  with both versions and the count), an info line for each launch that starts
  without live usage because of it, and an info line when it is lifted.

### What Code Mode sessions give up

A `debug-log` session does not go through the proxy. Compared with a proxied
session it gives up:

- **Attribution by token.** Readings are placed by organization instead, with
  the hold for an unknown organization and the shared-organization limit
  described above.
- **The proxy's resilience.** The 15-second connect deadline with its retryable
  502 and the c-ares DNS path apply to proxied sessions only. A Code Mode
  session has the CLI's own timeouts.
- **Request records in the performance log.** Its requests do not appear in
  `perf-claude-proxy.jsonl`. What the app does while reading its log is counted
  instead ([Performance counters](#performance-counters)).
- **A clean session header.** The debug banner is visible.
- **A session that leaves nothing on disk.** The header log exists while the
  session runs.
- **An unchanged environment for hooks and MCP servers.** They inherit
  `ANTHROPIC_LOG=debug`; see the limitation below.
- **Teaching the app its organization.** A proxied response stores the
  organization of the account that sent it; a response read from the log does
  not. An account that runs nothing but Code Mode sessions learns its
  organization from the usage poll or the organization learner.

Unchanged for these sessions: the usage poll, and session recovery, which is
triggered by hooks and probes through the proxy host as before.

A `none` session is off the proxy as well, so it also runs on the CLI's own
timeouts and leaves no request records. It has no banner, no log and no
inherited variable, and no live readings at all.

### Known limitation: hooks and MCP servers inherit `ANTHROPIC_LOG=debug`

To read live usage in a Code Mode session, Hive starts the Claude CLI with the environment variable
`ANTHROPIC_LOG=debug`. Shell commands that Claude runs do not see the variable. Your hook commands and stdio MCP
servers do, because the CLI passes its environment on to them and has no option to hold one variable back.

This only matters for a hook or server that itself calls Claude. In a Code Mode session:

- **A hook written with the Anthropic JavaScript/TypeScript SDK, or a hook that runs `claude -p`, can silently stop
  working.** Debug output is mixed into the hook's standard output. If the hook answers with JSON, for example a
  `PreToolUse` hook that returns `"permissionDecision": "deny"`, the answer is ignored and the tool call goes ahead.
  Nothing on screen shows that this happened. If the hook prints context for Claude, the debug output is added to
  the conversation too.
- **A hook written with the Anthropic Python SDK keeps working**, but its debug output goes to standard error. If the
  hook blocks with exit code 2, the reason shown to you and to Claude starts with that output, which includes the
  request the hook sent, and the hook's own message comes last.
- **An MCP server that uses the Anthropic JavaScript SDK keeps working.** Claude Code discards the extra lines.
- Hooks and servers that do not call Claude are not affected. Sessions without Code Mode are not affected.

**To fix a hook**, remove the variable for that command by putting `env -u ANTHROPIC_LOG` in front of it:

```json
{ "type": "command", "command": "env -u ANTHROPIC_LOG node ~/.claude/hooks/review-command.mjs" }
```

**To quieten an MCP server**, set the variable to `off` in that server's configuration:

```json
{ "command": "node", "args": ["server.mjs"], "env": { "ANTHROPIC_LOG": "off" } }
```

If you maintain the hook or server, you can instead pass `logLevel: 'off'` when you create the JavaScript SDK
client. That takes precedence over the variable.

**To avoid the variable altogether**, turn off Settings → Advanced → "Live usage in Code Mode sessions", or start
Hive with `HIVE_DISABLE_CLAUDE_DEBUG_USAGE=1`. Code Mode sessions then start without debug mode, and
their usage is updated by the regular poll instead of live.

Tested with Claude CLI 2.1.326, `@anthropic-ai/sdk` 1.9.0 and `anthropic` (Python) 2.9.0.

The text above is the wording of the measurements made for this feature, with
the versions named above (worth repeating when the CLI or an SDK is updated).
For whoever maintains this:

- Nothing the app can apply on its side helps. The environment file,
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and `BASH_ENV` were tried and had no
  effect on hooks or MCP servers.
- The limit is stated here and not next to the setting: the setting's
  description (quoted above) does not mention hooks or MCP servers.
- Accepting this as a documented limit was decided before the hook result was
  known. The measurements ask for that decision to be confirmed, because a
  permission hook that fails open is a different matter from the corrupted MCP
  stream the PRD expected.

### Performance counters

While performance logging is on (Settings → Advanced → Performance logging),
the source reports to `perf-electron-main.jsonl`: a `claudeDebugLog` gauge in
every 30-second sample (sessions, passes, checks, bytes read, entries parsed,
parse failures, durations, rotations, degraded) and one `claude-debug-log`
record whenever a log is rotated or a session becomes degraded. Counts,
durations and reason codes only: no session id, no path, no organization and
nothing read from a log. While performance logging is off nothing is counted.

- Gauge `claudeDebugLog` (role `electron-main`; all zeros while no Code Mode
  session runs): `sessions` registered when the sample was taken, and for the
  time since the previous sample: `passes` (times the source's one timer
  fired), `checks` (looks at one session's log, the final read of a session
  that ended included), `bytesRead`, `entriesParsed` (API response entries),
  `parseFailures` (lines that started like one and could not be read),
  `checkTotalMs` / `checkMaxMs`, `passTotalMs` / `passMaxMs` (a pass over 50
  sessions is meant to stay under 2 ms when nothing changed and under 10 ms
  when every log did), `rotations` and `degraded`. The first sample after
  performance logging is switched on starts from zero.
- Record `claude-debug-log` (role `electron-main`), written the moment it
  happens: `event` `rotated` with its `cause` (`own`: the app retired the log
  at 1 MiB; `replaced`: another file is at the path, the CLI's own rotation;
  `removed`; `truncated`), or `event` `degraded` with its `reason`
  (`log-empty`, `unparsed-responses`, `hard-cap`, `unsafe-file` with `detail`
  `symlink` / `not-regular-file` / `foreign-owner`). Which session it was is
  in the app log (`ClaudeCliUsageLaunches`, one warning per degraded session).

### Differences from the PRD

The PRD was written before the implementation. Where they differ,
the code is as described in this document. The differences:

| PRD | What the PRD says | What was built |
| --- | --- | --- |
| FR-1, FR-2 | Code Mode is requested when the variable is `1` in Settings, the app's environment or the Claude settings file. | The first source that defines the variable decides, also with `0` or an empty value. The Claude settings file comes last, although the CLI itself lets its settings file win over the shell: with `0` in the shell and `1` in the file the session stays on the proxy. |
| FR-3 | The user's own API address is looked for in "Settings or shell". | The exclusions also read the Claude settings file's `env` block, last. Any address whose host is not exactly `api.anthropic.com` counts, one that cannot be parsed included. |
| FR-5 | The kill switch is `HIVE_DISABLE_CLAUDE_DEBUG_USAGE=1`. | Any value other than empty, `0`, `false` and `no` turns the feature off, and the variable is also read from Settings → Environment Variables. |
| FR-10 | Remove both proxy variables from the inherited environment. | Both are removed only when the inherited address is the proxy's own. With the user's own address from Settings only the marker is removed, and with no proxy running nothing is. |
| FR-12, FR-14 | `ANTHROPIC_LOG=debug` and the environment file win over the user's. | They win over Settings and the shell. They are not put into the CLI's `--settings`, so the `env` block of a Claude settings file can still override them. |
| FR-16 | Remote tmux launches are a follow-up. | Not built. They stay on the proxy. |
| FR-30 | Degraded when a turn completes with a missing or empty file, or when status lines are seen and no `response start` entry parses. | The second case also counts a response entry that could not be read, and both are judged only when a turn completes. Any response entry that can be read is the recovery, also one without usage. |
| FR-31 | One warning per session; the usage UI shows the polled state. | One warning per launch (a restarted or resumed session can warn again). The UI is told on `usage:claudeLiveHealth`. |
| FR-32 | Three consecutive new sessions that degrade on one CLI version switch the transport off for it. | A launch counts as a failure only when it degrades before one response could be read, and a launch that made no request or completed no turn counts as neither. The notice is a toast, shown once in one window. |
| AT-3 | Learn an account's organization from the usage poll's header, the sign-in token response or a profile request, in that order. | The usage poll's header and a profile request. The token response at sign-in is not used. |
| AT-5 | Hold an unknown organization's reading for 60 seconds; for a shared organization, no switch in the last 30 seconds. | The 60 seconds run from the reading's arrival and start again with a newer reading. The 30 seconds are measured from the reading's own time. "The last switch" is the account index's stamp, which adding or removing an account also moves. |
| AT-7 | On a switch, write the target's stored organization, or delete `organizationUuid` and `profileFetchedAt` when it is unknown. | `profileFetchedAt` is removed on every switch to a different account, also when the organization is known, because the rest of the profile in the file is still the previous account's. |
| LF-1 | The directory is `<sessionId>-<launch nonce>`. | `<sessionId>-<app pid>-<16 hex digits>`, so that two apps on one data directory sweep only after themselves and after processes that are gone. |
| LF-2 | When the path is gone, close the old descriptor at once. | The descriptor stays open while nothing is at the path, so a write that had already opened the old file is still read. The retired file is found by scanning the directory, under whatever name it has. |
| LF-5 | Any file over 32 MiB in a session directory is deleted. | The check is on the log being followed and on a retired log still being read. |
| LF-6 | Delete the directory on PTY exit and on every destroy path. | Always on the exit of the process, never before it: closing or reaping a session ends its launch a moment later, and at quit a directory whose process is not known to be gone is left for the next start. |
| LF-7 | Sweep directories that have no live PTY. | The sweep also deletes everything of an app process that is gone and leaves the directories of another running app. A launch without a PTY is ended by the second sweep in a row. |
| PF-2 | 250 ms for sessions with a turn in progress, 2 s otherwise. | The 250 ms pace also holds for 15 seconds after a session was registered, its log grew or its turn ended. |
| PF-6 | Report tailer counters to the perf log. | A gauge in the 30-second sample and a record per rotation and per degraded event; no record per check, no average and no percentile. |
| SEC-2 | Refuse to start the transport when anything unexpected already exists. | Also refused: an empty directory at the target, and a `claude-cli-debug` directory with looser permissions (it is not tightened). On Windows nothing is prepared. |
| SEC-8 | An MCP server using the JavaScript SDK could have its protocol stream corrupted; document the limit next to the setting. | Measured: the MCP server keeps working, and it is hooks that break ([known limitation](#known-limitation-hooks-and-mcp-servers-inherit-anthropic_logdebug)). The limit is documented here; the setting's description does not carry it. |
| FR-22, FR-23 | Take the status and the header map from each entry; a value of `[REDACTED]` is absent. | Only the `anthropic-ratelimit-unified-*` headers and the organization id leave the parser; every other header is dropped there. `***` counts as masked too, although in the file a masked value always reads `[REDACTED]` (the CLI's redactor runs after the SDK's). A kept value longer than 256 characters is dropped, and an organization value that does not look like an id is ignored. |
| Section 4 | `CLAUDE_ENV_FILE` is sourced by the CLI before each Bash command. | From a reading of the CLI binary, the CLI puts the file's text in front of each command instead. `env.sh` is therefore two lines at most, without comments, and sources the user's file by path. |
| Section 11 | The CLI's restart into Code Mode was not observed. | Observed: after consent the CLI restarts itself, and the log and options survive. The consent dialog and its default "No" are not in the PRD. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `HIVE_DISABLE_CLAUDE_API_PROXY=1` | Don't start the proxy; usage stays poll-based, except for Code Mode sessions, whose usage is read from their debug log with or without the proxy. |
| `HIVE_CLAUDE_API_PROXY_PORT=<port>` | Preferred loopback port (default `42411`; `0` = ephemeral). Falls back to an ephemeral port when taken. |
| `ANTHROPIC_BASE_URL` (shell or Settings) | Used as the proxy's upstream; the CLI itself always gets the proxy URL. |
| `HIVE_CLAUDE_API_PROXY_HOST=in-process` | Run the tunnel inside main instead of the utility process. |
| `HIVE_CLAUDE_API_PROXY_CONNECT_TIMEOUT_MS=<ms>` | TCP + TLS budget for a new upstream socket (default 15000; 0 disables). |
| `HIVE_DISABLE_CLAUDE_DEBUG_USAGE=1` (shell or Settings) | The kill switch for live usage in Code Mode sessions. New Code Mode sessions start without the debug log (no `ANTHROPIC_LOG=debug`, no banner, nothing on disk) and their usage comes from the poll; Code Mode itself keeps working. Wins over the Advanced setting. Any value other than empty, `0`, `false` and `no` counts. See [The setting and the kill switch](#the-setting-and-the-kill-switch). |
| `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` (Settings, shell or the Claude settings file) | Not the app's variable: it asks the Claude CLI for Code Mode. The app only reads it, to launch the session off the proxy. See [Which sessions get it](#which-sessions-get-it). |

The proxy is skipped automatically when the environment (shell env merged
with Settings → Environment Variables, as the CLI sees it) already relies on a
corporate HTTP(S) proxy (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`), mTLS
(`CLAUDE_CODE_CLIENT_CERT`), `ANTHROPIC_UNIX_SOCKET`, or a non-Anthropic provider
(`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`,
`_ANTHROPIC_GOOGLE_CLOUD`). The decision is made at app start,
so adding one of those variables in Settings takes effect on the next launch.
The two switches differ in when they are read: the proxy's at app start, the
kill switch for the debug log each time a Claude CLI session starts.

Custom providers whose command inlines its own `ANTHROPIC_BASE_URL=` keep
bypassing the proxy — those are not Anthropic subscription accounts.

## Tests

Every command below runs from the repository root. `--project main` covers the
main process and the server child; `--project renderer` covers the renderer and
the suites under `test/`.

### The proxy and the live updater

```sh
pnpm exec vitest run --project main src/main/services/claude-api-proxy
```

Header parsing, body uuid extraction, the tunnel against a fake upstream
(including TLS trust with an `openssl`-minted CA) and the lifecycle's env
handling. The live updater is in the same directory: attribution by token and
coalescing, attribution by organization with the hold and the
shared-organization rule (`claude-usage-live-updater.organization.test.ts`),
learning an organization from proxied traffic
(`claude-usage-live-updater.learning.test.ts`), the updater with the proxy
disabled (`claude-usage-live.test.ts`), and the Advanced switch with its kill
switch (`claude-debug-usage-setting.test.ts`). The directory's two live tests
are skipped.

```sh
pnpm exec vitest run --project main src/main/services/__tests__/account-store-claude.identity-uuid.test.ts
pnpm exec vitest run --project renderer src/renderer/src/stores/__tests__/useUsageStore.live-usage.test.ts
```

The identity-file handling, and the usage store: applying a live reading, and
taking **Live** back for a degraded Code Mode session.

### Organization learning

```sh
pnpm exec vitest run --project main src/main/services/__tests__/claude-organization-learner src/main/services/usage/__tests__/claude-organization-signal.test.ts src/server/claude-organization-forwarder.test.ts src/main/db/saved-usage-account-org.test.ts
pnpm exec vitest run --project renderer test/usage/usage-service.organization.test.ts test/usage/saved-usage-orchestrator.organization.test.ts test/usage/account-maintenance.organization.test.ts
```

The first: the learner (back-off, rate limits, no request for a known
organization) and its wiring on the account store and its lock, the request
from main to the server child and the answer back, and the `org_uuid` column.
The second: the poll stores the organization and is otherwise unchanged, and
account maintenance runs the learner. An unknown-organization reading that goes
through the learner and lands on the right account is
`claude-organization-learning.test.ts`, in the proxy directory above.

### Code Mode sessions

```sh
pnpm exec vitest run --project main src/main/services/__tests__/claude-usage-transport.test.ts src/main/services/__tests__/claude-cli-spawner.test.ts src/main/services/__tests__/pty-service
```

The transport decision for every source of the Code Mode variable and every
exclusion; the launch's arguments and environment; removing inherited
variables from a PTY, once with a real process in a real PTY
(`pty-service.integration.test.ts`).

```sh
pnpm exec vitest run --project main src/main/services/claude-cli-debug-dir.test.ts src/main/services/claude-debug-log-follower.test.ts src/main/services/claude-cli-usage-launches.test.ts src/main/services/terminal-pty-bridge.usage-launch.test.ts
```

The launch directory (creation, refusals, the environment file in four shells,
removal, the sweep); the follower (partial lines, every kind of rotation, the
hard cap, unsafe files); the lifecycle of a launch, its health warning and
what it reports to the auto-disable; and the wiring in
`createClaudeCliTerminal`.

```sh
pnpm exec vitest run --project main src/main/services/claude-debug-log/
```

The entry parser against lines the CLI wrote (`__fixtures__/`), the usage
source (its schedule, health, the 500 ms target and the cost of a pass over 50
sessions), the source connected to the updater, the performance counters, the
auto-disable, and the helper of the live test. The live test itself is skipped.
Two of these tests measure real time and can fail on a heavily loaded machine;
`CLAUDE_DEBUG_LOG_USAGE_REPORT=1` in front of the command prints what they
measured.

```sh
pnpm exec vitest run --project main src/main/services/__tests__/claude-binary-resolver.test.ts src/server/rpc/domains/usage-ops.code-mode-notice.test.ts
pnpm exec vitest run --project renderer src/renderer/src/hooks/__tests__/useClaudeLiveUsageListener.test.tsx src/renderer/src/components/settings/SettingsAdvanced.test.tsx src/renderer/src/stores/__tests__/useSettingsStore.code-mode-live-usage.test.ts
```

Reading the CLI's version and claiming the "unavailable" notice once; in the
renderer, the listener with its toast, the Advanced switch and its stored
default.

### Live, opt-in

These run the real `claude` binary against the real Anthropic API, on the
account that is signed in. Each is skipped unless its variable is `1`, and each
costs a few tokens.

**Code Mode sessions.** The check to run when a new version of the Claude CLI
ships, because the usage of a Code Mode session is read from a log whose format
is the CLI's to change:

```sh
CODE_MODE_USAGE_LIVE=1 pnpm exec vitest run --project main src/main/services/claude-debug-log/__tests__/claude-code-mode-usage.live.test.ts
```

It starts an interactive session the way the app does (`createClaudeCliTerminal`,
a real PTY, Code Mode asked for in Settings → Environment Variables, the
proxy's address on the environment) and asserts the chain end to end: the
launch is taken off the proxy and the screen says "Code Mode (experimental) is
on"; the log receives a `response start` entry; follower and parser turn it
into a reading with a weekly window; the reading's organization is the one the
app learns for the signed-in account from that account's own token;
`printenv ANTHROPIC_LOG` in a shell command of the session prints nothing;
nothing reached the proxy's address; and no file of the launch remains after
the process has ended. The database, the hook server and the renderer are
stand-ins, and the launch directory is in a temporary place, never beside the
app's data.

- **Needs** `claude` on `PATH`, signed in to a claude.ai subscription that has
  accepted Code Mode once, and network. The test answers no dialog: when the
  CLI asks for consent it stops and says to start
  `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude` once and choose "Yes, turn on
  Code Mode".
- **`CLAUDE_BIN`** names the binary to use instead of the one on `PATH`.
  **`CODE_MODE_USAGE_LIVE_MODEL`** picks the model (default `haiku`).
- **Costs** one tiny prompt, a second turn that the CLI starts after the shell
  command and that is cut short when the session closes, and one profile
  request with the account's access token.
- **Leaves behind** one entry under `projects` in `~/.claude.json` (the test
  marks its temporary folder as trusted, as the app does for every session
  folder) and the CLI's usual transcript under `~/.claude/projects`. Its
  temporary folder is removed. The session runs with the options of a
  build-mode session, `--dangerously-skip-permissions` among them, in that
  empty folder.
- **Fails with a message, not a timeout,** when the CLI is missing, nobody is
  signed in, the kill switch is set, or the CLI does not turn Code Mode on (it
  quotes the CLI's own refusal). It prints no token, no e-mail address, no log
  line and at most the first 8 characters of an organization id.

**The proxy** (one prompt on haiku; `CLAUDE_API_PROXY_LIVE_MODEL` picks another
model):

```sh
CLAUDE_API_PROXY_LIVE=1 pnpm exec vitest run --project main src/main/services/claude-api-proxy/__tests__/claude-api-proxy.live.test.ts
```

It drives the real `claude` binary through the proxy and asserts the attributed
observation.

**Organization learning** (one prompt on haiku, then the usage poll and the
profile request once each; `CLAUDE_ORGANIZATION_LIVE_MODEL` picks another
model):

```sh
CLAUDE_ORGANIZATION_LIVE=1 pnpm exec vitest run --project main src/main/services/claude-api-proxy/__tests__/claude-organization.live.test.ts
```

It checks that the usage poll, the profile request and the learner give the
signed-in account the organization a real model response names; it refreshes no
token and writes nothing.

These two look for the binary at `CLAUDE_BIN`, or `~/.local/bin/claude` when it
is unset, and are skipped without a word when it is not there.

## Adding Codex

`startLocalApiProxy` is provider-agnostic: a Codex tunnel needs its own
upstream resolver and an observer for OpenAI's rate-limit headers, published on
a sibling channel. The usage shapes already share `UsageData`.
