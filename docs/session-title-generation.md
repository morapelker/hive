# Session Title Generation — Reference Spec

> Research extracted from the [opencode](https://github.com/sst/opencode) project.
> Use this document to implement automatic session title generation in Hive.

---

## Overview

When a user starts a new session, it gets a placeholder title (e.g. `"New session - 2026-02-21T10:30:00.000Z"`). On the **first user message**, a background LLM call generates a real title using the cheapest available model. The title is never regenerated unless it still matches the default placeholder pattern.

---

## Flow

```
1. Session created → default title assigned ("New session - <ISO timestamp>")
2. User sends first message → message processing loop begins
3. At step 1 of processing → ensureTitle() fires (NOT awaited, runs in background)
4. Guard checks:
   a. Not a child/subtask session
   b. Title still matches default pattern (regex check)
   c. Exactly one non-synthetic user message in history
5. Resolve model (smallest/cheapest available)
6. Stream LLM call with title prompt + conversation context
7. Post-process response → strip think tags, take first non-empty line, truncate
8. Update session title (without touching updated_at timestamp)
```

Key design decisions:

- **Fire-and-forget** — title generation never blocks the assistant response stream
- **One-shot** — only runs once, on the very first user message
- **Idempotent** — if the title is already non-default (user renamed it), skip entirely
- **Cheap** — always targets the smallest model available with minimal reasoning effort

---

## System Prompt

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

---

## User Message Format

The user message sent alongside the system prompt:

```
Generate a title for this conversation:
<followed by the conversation context messages>
```

The conversation context is the full set of messages from the session (converted to model message format). If the session only has subtask prompts, those prompts are joined with newlines instead.

---

## LLM Call Parameters

| Parameter     | Value                                             |
| ------------- | ------------------------------------------------- |
| `temperature` | `0.5`                                             |
| `tools`       | None (all denied)                                 |
| `small`       | `true` (reduces reasoning effort)                 |
| `retries`     | `2`                                               |
| `system`      | Title prompt above (no additional system prompts) |

When `small: true`:

- OpenAI models → `reasoningEffort: "minimal"`
- Google models → `thinkingBudget: 0`
- General intent → use the cheapest inference path available

---

## Model Selection Priority

1. **User override** — if the user configured a specific model for title generation, use it
2. **Smallest model for the active provider** — priority list:
   - `claude-haiku-4-5` / `claude-haiku-4.5` / `3-5-haiku` / `3.5-haiku`
   - `gemini-3-flash` / `gemini-2.5-flash`
   - `gpt-5-nano`
3. **Fallback** — the session's own model (whatever the user is chatting with)

The idea: never waste tokens from an expensive model on a title. Haiku/Flash/Nano are more than sufficient.

---

## Post-Processing

```
1. Strip <think>...</think> tags (reasoning model artifacts)
2. Split by newlines
3. Trim each line
4. Take the first non-empty line
5. If longer than 100 chars → truncate to 97 chars + "..."
6. Update the session record
```

The session update uses `{ touch: false }` so the `updated_at` timestamp is not modified — the title is metadata, not a content change.

---

## Guard Conditions (all must pass)

| Condition                     | Reason                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| Not a child/subtask session   | Child sessions inherit context, their titles are less useful |
| Title matches default pattern | If user already renamed it, respect their choice             |
| Exactly one real user message | Only generate on the first message, not on subsequent ones   |

---

## Manual Override

Users can manually rename a session title (e.g. via a PATCH API call or inline edit). Once renamed, the title no longer matches the default pattern, so `ensureTitle()` will never overwrite it.

---

## Separate Feature: Per-Message Summary Titles

opencode also generates per-message summary titles (distinct from the session title). These use the **same title agent and model** but with a different user message:

```
The following is the text to summarize:
<text>
${message text}
</text>
```

This runs on each user message (not just the first) and stores the result on the message record itself (`message.summary.title`), not on the session. This is useful for long sessions where each turn covers a different topic.
