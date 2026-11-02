/**
 * The two shell programs behind project shell commands. Both are constants: user text
 * (the steps) only ever travels as positional argv, never interpolated into them.
 *
 * They are byte-exact copies of the scripts that were measured against zsh, bash 3.2,
 * bash 5, sh, ksh and dash; shell-command-scripts.test.ts pins their sha256. Do not
 * reformat them. String.raw keeps every backslash literal, so neither text may contain
 * a backtick or a dollar sign followed by an opening brace.
 */

/** argv0 of the wrapper (it shows up in the shell's own error messages). */
export const SHELL_COMMAND_ARGV0 = 'hive-shell-command'
/** argv0 of the detached host. */
export const DETACHED_HOST_ARGV0 = 'hive-shell-host'

/**
 * The -c script of the user's shell, for in-app AND detached runs.
 * argv: $0 = SHELL_COMMAND_ARGV0, then (label, step) pairs.
 *
 * - set +m keeps every child in the shell's process group, so a group kill reaches them.
 * - Each step is eval'd in this one shell (cd / export persist); the first failing step
 *   ends the run with that step's status. The assignment appended after two newlines is
 *   how a step that fails to PARSE is detected (bash 3.2 reports 0 for it): both
 *   newlines are load-bearing.
 * - The EXIT trap prints the final strip, and writes the status to
 *   $HIVE_SHELL_RUN_DIR/inner.exit when the detached host set that variable.
 */
export const SHELL_COMMAND_WRAPPER = String.raw`set +m
if [ -n "$ZSH_VERSION" ]; then setopt interactive_comments; fi
__tc_dir=$HIVE_SHELL_RUN_DIR
unset HIVE_SHELL_RUN_DIR
__tc_total=$(($# / 2)) __tc_i=0 __tc_rc=0 __tc_ev=0 __tc_have= __tc_once= __tc_done=
__tc_status() { return "$1"; }
__tc_finish() {
  trap - EXIT
  if [ -n "$__tc_dir" ]; then printf '%s\n' "$1" >| "$__tc_dir/inner.exit"; fi 2>/dev/null
  if [ "$1" -ne 0 ]; then
    printf '\n\033[1;31m[hive] Failed at step %s/%s\033[0m\033[2m (exit %s)\033[0m\n' "$__tc_i" "$__tc_total" "$1"
  elif [ -n "$__tc_done" ]; then
    printf '\n\033[1;32m[hive] Succeeded\033[0m\033[2m (exit 0)\033[0m\n'
  else
    printf '\n\033[1;33m[hive] Stopped at step %s/%s\033[0m\033[2m (exit 0)\033[0m\n' "$__tc_i" "$__tc_total"
  fi
}
trap '__tc_finish "$?"' EXIT
trap 'exit 130' INT
for __tc_arg do
  if [ -z "$__tc_have" ]; then
    __tc_have=1
    __tc_i=$((__tc_i + 1))
    if [ "$__tc_i" -gt 1 ]; then printf '\n'; fi
    printf '\033[2m[%s/%s]\033[0m \033[1m$ %s\033[0m\n' "$__tc_i" "$__tc_total" "$__tc_arg"
    continue
  fi
  __tc_have=
  __tc_rc=
  for __tc_once in 1; do
    eval " $__tc_arg

__tc_rc=\$?"
  done
  __tc_ev=$?
  if [ -z "$__tc_rc" ]; then
    __tc_rc=$__tc_ev
    if [ "$__tc_rc" -eq 0 ]; then __tc_rc=2; fi
  fi
  if [ "$__tc_rc" -gt 255 ]; then __tc_rc=2; fi
  if [ "$__tc_rc" -ne 0 ]; then break; fi
done
if [ "$__tc_rc" -eq 0 ]; then __tc_done=1; fi
__tc_status "$__tc_rc"
`

/**
 * The -c script of /bin/sh for a detached run: its own session, system binaries only.
 * argv: $0 = DETACHED_HOST_ARGV0, $1 = run dir, $2 = cols, $3 = rows,
 *       $4... = <shell> <flags> SHELL_COMMAND_WRAPPER SHELL_COMMAND_ARGV0 <pairs...>
 *
 * It holds the run's FIFO open on fd 3 (which is what makes the run "live"), feeds it
 * to script(1) through cat, lets script(1) write the terminal bytes to output.log, and
 * finally records script's and the wrapper's statuses in the exit file. The feeder's
 * pid is read BEFORE the exit file appears: the app removes the control files as soon
 * as it sees that file, and a feeder left unkilled would hold the host forever.
 */
export const DETACHED_HOST_SCRIPT = String.raw`d=$1; c=$2; r=$3; shift 3
exec 3<> "$d/stdin" || exit 97
printf '%s\n' "$$" > "$d/host.pid.tmp" && mv -f "$d/host.pid.tmp" "$d/host.pid"
if [ -n "$HIVE_SHELL_LOG_LIMIT_BLOCKS" ]; then ulimit -S -f "$HIVE_SHELL_LOG_LIMIT_BLOCKS" 2>/dev/null; fi
export HIVE_SHELL_RUN_DIR="$d"
set -- /bin/sh -c 'stty cols "$2" rows "$3" 2>/dev/null; ulimit -S -f unlimited 2>/dev/null; unset HIVE_SHELL_LOG_LIMIT_BLOCKS SCRIPT; printf "pid=%s\ntty=%s\n" "$$" "$(tty 2>/dev/null)" > "$1/inner.tmp" && mv -f "$1/inner.tmp" "$1/inner"; shift 3; exec "$@"' hive-shell-pty "$d" "$c" "$r" "$@"
/bin/sh -c 'printf "%s\n" "$$" > "$1/feeder.pid"; exec cat' hive-shell-feeder "$d" <&3 3<&- | {
  case "$(uname -s)" in
    Darwin)
      /usr/bin/script -q -a -F "$d/output.log" "$@" >/dev/null 2>"$d/host.err" 3<&- ;;
    *)
      TSC_N=$#; i=0
      for a in "$@"; do i=$((i+1)); export "TSC_A$i=$a"; done
      export TSC_N TSC_SHELL="$SHELL"
      SHELL=/bin/sh script -q -e -c 'n=$TSC_N; i=0; while [ "$i" -lt "$n" ]; do i=$((i+1)); eval "set -- \"\$@\" \"\$TSC_A$i\""; unset "TSC_A$i"; done; unset TSC_N; if [ -n "$TSC_SHELL" ]; then export SHELL="$TSC_SHELL"; else unset SHELL; fi; unset TSC_SHELL; exec "$@"' /dev/null >>"$d/output.log" 2>"$d/host.err" 3<&- ;;
  esac
  rc=$?
  i=0; while [ ! -s "$d/feeder.pid" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done
  f=$(cat "$d/feeder.pid" 2>/dev/null)
  { printf 'script=%s\n' "$rc"; if [ -s "$d/inner.exit" ]; then printf 'wrapper=%s\n' "$(cat "$d/inner.exit")"; fi; } > "$d/exit.tmp"
  mv -f "$d/exit.tmp" "$d/exit"
  kill "$f" 2>/dev/null
}
`
