#!/usr/bin/env python3
"""Drive an interactive CLI (the codex TUI) inside a pseudo-terminal from a step script.

Used by the live Codex CLI verification (src/main/services/__tests__/codex-cli-live.test.ts)
to exercise the real `codex` binary the way Hive's PTY bridge does: spawn with Hive's
argv, wait for the terminal-title run-state, press Shift+Tab, paste a prompt, and quit.
node-pty is built for Electron's ABI in this repo, so plain-node test runs cannot load
it; Python's pty module needs nothing.

stdin JSON:
  {
    "command": "/opt/homebrew/bin/codex",
    "args": [...],
    "cwd": "/path",
    "env": {"KEY": "VALUE"},          # merged over the current environment
    "cols": 140, "rows": 40,
    "logPath": "/tmp/out.log",        # raw PTY output is appended here
    "steps": [
      ["wait", "<regex>", <timeout_s>],   # wait until the regex matches output not yet consumed by an earlier wait
      ["send", "<text>"],                 # write raw bytes (escape sequences allowed)
      ["paste", "<text>"],                # bracketed paste + Enter, like Hive's prompt injection
      ["sleep", <seconds>],
      ["quit", <timeout_s>]               # Ctrl+C while idle, then wait for exit (Ctrl+D fallback)
    ]
  }
Prints a JSON result on stdout: {"exitCode": n, "timedOut": bool, "matched": [...]}.
"""
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import fcntl
import time


def set_winsize(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    spec = json.load(sys.stdin)
    command = spec["command"]
    args = spec.get("args", [])
    cwd = spec.get("cwd") or os.getcwd()
    env = dict(os.environ)
    env.update(spec.get("env") or {})
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    env.pop("COLUMNS", None)
    env.pop("LINES", None)
    cols = int(spec.get("cols", 140))
    rows = int(spec.get("rows", 40))
    log_path = spec.get("logPath")
    steps = spec.get("steps", [])

    pid, fd = pty.fork()
    if pid == 0:
        try:
            set_winsize(0, rows, cols)
        except Exception:
            pass
        os.chdir(cwd)
        os.execvpe(command, [command] + args, env)
        os._exit(127)

    set_winsize(fd, rows, cols)
    output = bytearray()
    log = open(log_path, "ab") if log_path else None
    exit_code = None
    timed_out = False
    matched = []
    # Each wait searches only past the end of the previous match, so a stale
    # "Ready" from startup can never satisfy a later wait for the post-turn Ready
    # (events during sleeps are still seen: the cursor only advances on matches).
    search_from = 0

    def pump(timeout):
        nonlocal exit_code
        if exit_code is not None:
            return False
        r, _, _ = select.select([fd], [], [], timeout)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                finished, status = os.waitpid(pid, 0)
                exit_code = os.waitstatus_to_exitcode(status)
                return False
            output.extend(chunk)
            if log:
                log.write(chunk)
                log.flush()
            return True
        # Child may have exited without closing the fd yet.
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished == pid:
            exit_code = os.waitstatus_to_exitcode(status)
            return False
        return True

    def write(text):
        os.write(fd, text.encode("utf-8"))

    def wait_for(pattern, timeout):
        nonlocal timed_out, search_from
        regex = re.compile(pattern.encode("utf-8"), re.DOTALL)
        deadline = time.time() + timeout
        while time.time() < deadline:
            m = regex.search(output, search_from)
            if m:
                search_from = m.end()
                matched.append(pattern)
                return True
            if not pump(0.1):
                return False
        timed_out = True
        matched.append("TIMEOUT:" + pattern)
        return False

    try:
        for step in steps:
            kind = step[0]
            if kind == "wait":
                wait_for(step[1], float(step[2]) if len(step) > 2 else 30)
            elif kind == "send":
                write(step[1])
            elif kind == "paste":
                write("\x1b[200~" + step[1] + "\x1b[201~\r")
            elif kind == "sleep":
                deadline = time.time() + float(step[1])
                while time.time() < deadline:
                    if not pump(0.1):
                        break
            elif kind == "quit":
                timeout = float(step[1]) if len(step) > 1 else 15
                write("\x03")
                deadline = time.time() + timeout
                while exit_code is None and time.time() < deadline:
                    pump(0.2)
                if exit_code is None:
                    write("\x04")
                    deadline = time.time() + 5
                    while exit_code is None and time.time() < deadline:
                        pump(0.2)
            if exit_code is not None:
                break
        # Drain briefly.
        deadline = time.time() + 1
        while exit_code is None and time.time() < deadline:
            pump(0.1)
    finally:
        if exit_code is None:
            try:
                os.kill(pid, signal.SIGHUP)
                time.sleep(0.5)
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
            try:
                finished, status = os.waitpid(pid, 0)
                exit_code = os.waitstatus_to_exitcode(status)
            except Exception:
                pass
        if log:
            log.close()

    print(json.dumps({"exitCode": exit_code, "timedOut": timed_out, "matched": matched}))


if __name__ == "__main__":
    main()
