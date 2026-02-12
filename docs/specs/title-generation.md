# Session Title Generation

How the OpenCode server automatically generates session titles, and how to replicate it in a custom client.

## Overview

Session titles go through two phases:

1. **Placeholder** — on creation, every session gets a default title like `New session - 2026-02-10T12:34:56.789Z`
2. **LLM-generated** — on the first user message, the server fires a background LLM call that replaces the placeholder with a short, descriptive title

There is also a **per-message summary title** (stored on individual user messages), which is a separate mechanism from the session-level title.

---

## Phase 1: Default Title (Session Creation)

When a session is created, the title is set to:

```
"New session - " + new Date().toISOString()
// e.g. "New session - 2026-02-10T12:34:56.789Z"
```

Child sessions (spawned from a parent) get:

```
"Child session - " + new Date().toISOString()
```

The server detects whether a title is still a default using this regex:

```
/^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
```

Source: `packages/opencode/src/session/index.ts:29-39`

---

## Phase 2: Automatic Title Generation (`ensureTitle`)

### When it triggers

The title generation runs **once**, at the start of the very first LLM processing step (`step === 1`), as a **fire-and-forget** async call (not awaited — it runs in the background while the main response streams).

Source: `packages/opencode/src/session/prompt.ts:315-322`

### Guard conditions (all must pass)

1. **Not a child session** — if `session.parentID` is set, skip
2. **Title is still the default** — if someone already set a custom title, skip
3. **First real user message** — only runs when there is exactly one non-synthetic user message in the history. "Synthetic" messages are system-injected messages (e.g. context, file attachments), not typed by the user.

Source: `packages/opencode/src/session/prompt.ts:1804-1816`

### The LLM call

**System prompt** — the full title prompt template (see below).

**User messages sent to the model:**

```
[
  { role: "user", content: "Generate a title for this conversation:\n" },
  ...contextMessages  // all messages up to and including the first real user message
]
```

If the first user message contains only subtask parts (from command invocations), the prompts from those subtask parts are concatenated and sent directly instead of the full message context.

**Model selection** (in priority order):

1. If the user configured `agent.title.model` in their config, use that model
2. Otherwise, use a "small" model from the same provider (see Small Model Selection below)
3. If no small model is available, fall back to the session's own model

**LLM parameters:**

- `temperature: 0.5`
- `small: true` (reduces reasoning effort for reasoning models)
- `retries: 2`
- No tools are available to the title agent

Source: `packages/opencode/src/session/prompt.ts:1828-1855`

### Post-processing

```javascript
const cleaned = text
  .replace(/<think>[\s\S]*?<\/think>\s*/g, "") // strip reasoning model thinking tags
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line.length > 0) // take first non-empty line

const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
```

The cleaned title is saved to the session via `Session.update()` with `{ touch: false }` (doesn't update the `time.updated` timestamp).

Source: `packages/opencode/src/session/prompt.ts:1857-1872`

---

## Title Prompt Template

This is the full system prompt used for the title LLM call. Copy it verbatim for your implementation.

```
You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>
```

Source: `packages/opencode/src/agent/prompt/title.txt`

---

## Small Model Selection

When no explicit title model is configured, the server picks a cheap/fast model from the same provider. The priority list:

| Provider           | Priority Order                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Default**        | `claude-haiku-4-5`, `claude-haiku-4.5`, `3-5-haiku`, `3.5-haiku`, `gemini-3-flash`, `gemini-2.5-flash`, `gpt-5-nano` |
| **opencode**       | `gpt-5-nano`                                                                                                         |
| **github-copilot** | `gpt-5-mini`, `claude-haiku-4.5`, then the default list                                                              |

The match is substring-based — a model ID containing the priority string is selected. If no small model matches, the session's primary model is used as fallback.

Users can also set `small_model` in their config to override all small model selection.

Source: `packages/opencode/src/provider/provider.ts:1147-1200`

---

## Per-Message Summary Title (Separate from Session Title)

In addition to the session-level title, each user message can have its own `summary.title`. This is a distinct feature used for message-level navigation.

**Trigger:** Also fires on `step === 1`, via `SessionSummary.summarize()`, as another fire-and-forget call. It also fires again when an assistant message finishes streaming.

**Guard:** Only runs if the user message has a text part and `summary.title` is not yet set.

**LLM call:**

```
messages: [
  {
    role: "user",
    content: `
      The following is the text to summarize:
      <text>
      ${userMessageText}
      </text>
    `
  }
]
```

Uses the same title agent (same system prompt, temperature, and model selection). The result is stored on `message.summary.title`, not on the session.

Source: `packages/opencode/src/session/summary.ts:120-167`

---

## Manual Title Override (API)

The server exposes a PATCH endpoint to manually set a session title:

```
PATCH /session/:sessionID

Body: { "title": "My custom title" }

Response: Updated Session object
```

This allows users to rename sessions from the UI. Once a title is manually set, it will no longer match the default title regex, so `ensureTitle` will never overwrite it.

Source: `packages/opencode/src/server/routes/session.ts:241-292`

---

## Implementation Checklist for Custom Client

1. **On session creation** — set `title` to `"New session - " + new Date().toISOString()`
2. **On first user message** — fire a background LLM call using:
   - The title system prompt above
   - The user's first message as context
   - A small/cheap model (Haiku, Flash, or Nano)
   - `temperature: 0.5`
3. **Post-process the result** — strip `<think>` tags, take first non-empty line, truncate to 100 chars
4. **Update the session title** — write the cleaned title back to the session
5. **Skip title generation if:**
   - Session is a child session
   - Title has already been customized
   - This is not the first user message
6. **Allow manual rename** — call `PATCH /session/:sessionID` with `{ title: "..." }`
7. **Detect default titles** with regex: `/^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`

### If relying on the server

If your client talks to the OpenCode server via its API, **you don't need to implement title generation yourself**. The server handles it automatically when you send the first message via `POST /session/:sessionID/message`. The session title will be updated asynchronously and you'll receive the update through the session event stream (`session.updated` event). You only need to:

- Display the title from the session object
- Listen for `session.updated` events to refresh it
- Provide UI for manual rename via `PATCH /session/:sessionID`
