export type ReviewPromptType = 'superpowers' | 'adversarial' | 'standard'

export const REVIEW_PROMPT_LABELS: Record<ReviewPromptType, string> = {
  superpowers: 'Superpowers',
  adversarial: 'Adversarial',
  standard: 'Standard',
}

export const DEFAULT_REVIEW_PROMPT_TYPE: ReviewPromptType = 'standard'

export const REVIEW_PROMPTS: Record<ReviewPromptType, string> = {
  superpowers: `Please review the changes on the current branch.

Use the superpowers:code-reviewer skill.

Focus on: bugs, logic errors, and code quality.`,

  adversarial: `## Adversarial Code Review - Break This Code

You are a hostile code reviewer. Your mission is to BREAK this code. Find every way it can fail, crash, corrupt data, or behave incorrectly. Assume Murphy's Law: anything that can go wrong will go wrong.

You are not here to be helpful or suggest improvements. You are here to find defects.

### Phase 1: Reconnaissance (parallel)

Launch these agents in parallel:

1. **Sonnet agent - Attack surface mapping**: Use mcp__conductor__GetWorkspaceDiff to get all changes. For every modified function, class, or module, list:
   - All inputs (parameters, props, state, environment)
   - All external dependencies (APIs, file system, network, other modules)
   - All side effects (state mutations, DOM changes, I/O)
   - All assumptions the code makes about its environment

2. **PR context**: If this workspace has an associated PR, read the title and description. Understanding what the author INTENDED helps you find where the implementation DIVERGES from the intent.

3. **Haiku agent - CLAUDE.md rules**: Return file paths for all CLAUDE.md and AGENTS.md files relevant to modified directories.

### Phase 2: Attack Execution (launch 6 agents in parallel)

Each agent receives the attack surface map and PR context. All agents use mcp__conductor__GetWorkspaceDiff.

**Agent 1: Opus - Input Abuse**
Try to break every input:
- null, undefined, empty string, empty array, empty object
- Extremely long strings, negative numbers, NaN, Infinity
- Unexpected types (number where string expected, object where array expected)
- Unicode edge cases, special characters, injection payloads
- Inputs at boundary values (0, -1, MAX_SAFE_INTEGER)
- For each input, trace what happens if it is malformed. Does the code crash? Return wrong results? Silently corrupt state?

**Agent 2: Opus - Race Conditions and Timing**
Try to break the code with concurrency and timing:
- What if two users/processes call this simultaneously?
- What if an async operation completes after the component unmounts?
- What if a callback fires after state has been reset?
- What if network requests return out of order?
- What if a promise rejects while another is still pending?
- Stale closure bugs: does any callback capture a variable that changes?
- Missing cleanup: event listeners, intervals, subscriptions that leak

**Agent 3: Opus - State Corruption**
Try to corrupt the application state:
- What if the store is in an unexpected state when this code runs?
- What if a required field is missing from the state?
- What if state is mutated directly instead of through the proper API?
- What happens during partial updates (some fields updated, others stale)?
- Can any operation leave the state in an inconsistent intermediate form?
- What if localStorage/sessionStorage is corrupted or unavailable?

**Agent 4: Opus - Error Path Exploitation**
Try to make every error path fail:
- What if a try/catch catches an error but the recovery logic also throws?
- What if an error handler receives an unexpected error type?
- Are there any unhandled promise rejections?
- What if an API returns an error in an unexpected format?
- What if a file operation fails with ENOENT, EACCES, EMFILE?
- Does error state properly reset, or does it get stuck?

**Agent 5: Opus - Security Holes**
Try to exploit security weaknesses:
- Is any user input used without sanitization?
- Are there any command injection vectors (shell commands, eval, innerHTML)?
- Can any API call be manipulated to access unauthorized data?
- Are secrets/tokens ever exposed in logs, error messages, or state?
- Is there any path traversal possible in file operations?
- Are permissions checked before every privileged operation?

**Agent 6: Sonnet - Contract Violations**
Check for violations of contracts and conventions:
- CLAUDE.md / AGENTS.md rule violations (only rules in scope for modified files)
- TypeScript type safety bypasses (as any, type assertions, @ts-ignore)
- API contract violations (wrong request/response shapes)
- Interface/type mismatches between modules
- Missing required fields in objects passed between boundaries

**Every agent must provide a concrete reproduction scenario for each issue.** Not "this might fail" but "given input X in state Y, this line will throw Z because..."

### Phase 3: Validation

For every issue from Phase 2, launch an Opus validation subagent that must:

1. Confirm the issue exists in the actual code (not a theoretical concern)
2. Verify it is introduced by this diff (not pre-existing)
3. Provide a specific reproduction: the exact input, state, or sequence of events that triggers the defect
4. Rate the exploitability: how likely is this to occur in real usage?

**Kill any issue that:**
- Is pre-existing (not introduced by this diff)
- Is purely theoretical with no concrete reproduction path
- Would require an attacker to have access they should not have
- Is a nitpick or style preference
- Would be caught by a linter or type checker

### Phase 4: Damage Report

List all confirmed defects, ordered by severity:

#### Crash / Data Loss
\`\`\`
### **#1 [Title]**

[What breaks and how]

Reproduction: [Exact steps/input to trigger]
Impact: [What happens when this fails]
File: [path]
\`\`\`

#### Incorrect Behavior
\`\`\`
### **#2 [Title]**

[What goes wrong]

Reproduction: [Exact steps/input]
Expected: [What should happen]
Actual: [What actually happens]
File: [path]
\`\`\`

#### Security / Injection
\`\`\`
### **#3 [Title]**

[The vulnerability]

Reproduction: [How to exploit]
Impact: [What an attacker gains]
File: [path]
\`\`\`

#### Silent Failures
\`\`\`
### **#4 [Title]**

[What fails silently and why it matters]

Reproduction: [When this occurs]
File: [path]
\`\`\`

If no defects survive validation, state: "This code survived adversarial review. No exploitable defects found."

### Notes

- All subagents must be explicitly instructed not to post comments themselves. Only you, the main agent, should post comments.
- Do not use the AskUserQuestion tool. Complete the entire review without user intervention.
- Use gh CLI to interact with GitHub. Do not use web fetch.
- Every reported issue must have a concrete reproduction scenario. No hand-waving.`,

  standard: `Please review the changes on the current branch.
Focus on: bugs, logic errors, and code quality.`,
}
