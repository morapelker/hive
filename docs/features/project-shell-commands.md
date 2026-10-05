# Project Shell Commands

Project shell commands are named, pre-configured shell snippets that you run from the project or worktree right-click menu. Each run opens its own terminal tab, and can be tracked as a ticket on the board.

They are different from [Custom Project Commands](./custom-project-commands.md): a custom command is a prompt template that is sent to an AI session, a shell command is executed by your shell. Shell commands appear with a terminal icon in menus, custom commands with a lightning bolt.

## Defining Commands

Open **Project Settings** (right-click the project) and choose the **Shell Commands** tab. Each command has:

- **Name**: shown in the menus, on the terminal tab and as the ticket title (up to 80 characters).
- **Steps**: one step per line, run in order.
- **Keep running if the app quits**: see [below](#keep-running-if-the-app-quits).

Rows with a blank name or no steps are dropped when you save. A row that is filled in but cannot run (for example, only comment lines) blocks the save with a message naming the command. A project can hold up to 50 commands.

### How Steps Run

- Every line is one step. Steps run in order, in the same shell, so a `cd` or an exported variable in one step is seen by the next.
- A failing step stops the run; later steps are not executed.
- Blank lines and lines starting with `#` are ignored.
- A line ending in a backslash is joined with the next line.
- To put several commands in one step, join them with `;` or `&&`.
- Steps run in your login shell, started interactively, so your `PATH`, aliases and shell functions apply.
- Steps use POSIX shell syntax.

### Example

```sh
# Build and install the desktop app
pnpm install
pnpm build && pnpm test
pnpm install:mac
```

## Running Commands

| Where you right-click                                     | Where the command runs      |
| --------------------------------------------------------- | --------------------------- |
| A project                                                 | The project's base worktree |
| A worktree in the sidebar (right-click or its `...` menu) | That worktree               |
| A pinned worktree (right-click or its `...` menu)         | That worktree               |

Up to five commands are listed directly in the menu. With more than five they are grouped under **Run Command**.

The command palette also has **Run Shell Command** when the selected project has commands. It runs in the active worktree when that worktree belongs to the selected project, otherwise in the base worktree.

Every launch creates a new terminal session and switches to it. Launching a command that is already running starts a second, independent run.

The script is copied into the session when it is launched. Editing the command in Project Settings later does not change runs that already exist, including when you use **Run again**.

## Tickets

A launch creates a ticket in **In Progress** when **Automatically create ticket** is on (Settings > General), or when your organization enforces board mode. The ticket is titled with the command name and is linked to the run's terminal, so opening the ticket shows the same terminal output.

The project is pinned only when a ticket was created, following the **Auto-pin project on board prompts** setting.

When the run ends, the ticket moves from **In Progress** to **Review**:

| Outcome                                         | Ticket                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| Succeeded                                       | Review                                                    |
| Failed                                          | Review, with a red Error badge that carries the exit code |
| Interrupted (the app quit while it was running) | Review, with a red Error badge                            |
| Stopped by you                                  | Review, without an error badge                            |

## The Terminal Tab

The tab is a regular terminal while the command runs: you can type into it, for example to answer a prompt. A strip above the terminal shows the state of the run:

- **Running**, with a **Stop** button.
- **Succeeded**, **Failed (exit N)**, **Stopped** or **Interrupted**, with a **Run again** button.

**Run again** reruns the same script in the same session and ticket: the terminal is cleared, the ticket goes back to In Progress and any error badge is removed. After a run finishes the terminal is a read-only transcript; there is no shell left behind it.

## Keep Running If the App Quits

By default a command runs inside the app. If the app quits while it is running, the run is marked **Interrupted** the next time the app starts.

Tick **Keep running if the app quits** for commands that restart, reinstall or replace Hive itself, or that should simply outlive the app. Such a run is started outside the app:

- It keeps running when the app quits, is force-quit, or is replaced by a new build.
- When the app starts again, a run that is still going is picked up and shown as Running; a run that finished in the meantime shows its result and its full output.
- You can still type into it and stop it.

Things to know:

- It needs the system `script` utility (part of macOS and of most Linux distributions). If it is missing, the run fails to start with a message saying so.
- The terminal is slightly less faithful than a normal one: output arrives in small batches, window resizes are applied with a short delay, and a large amount of typed-ahead input can be dropped.
- The output of a run in progress is not trimmed. A run that writes an extreme amount of output (hundreds of megabytes) is ended and marked as failed with "output limit reached".

## Where Output Is Stored

Output is saved under `~/.hive/shell-command-runs`, one folder per session and run, and is removed when the session is deleted. The saved transcript is capped at 5 MiB per run; for longer output the oldest part is dropped.

Commands can print secrets. The saved output is readable only by your user account, but it is kept on disk as long as the session exists.

## Limitations

- Not available on Windows.
- Not available for connection projects.
- Multi-line shell constructs are not supported: every line must be a complete command on its own. Heredocs and `if` / `for` blocks spread over several lines fail at their first line. Put such logic in a script file and call it from a step.
- Background jobs started with `&` or `nohup` can outlive the run, and are not stopped by **Stop** if they detach from the terminal.
- Not available from paired phones: runs cannot be started from a phone, and a phone cannot show a run's output.
- Runs on a worktree that has been teleported to another machine are rejected.
