// Stand-in for an app instance that starts a detached shell-command run and is then
// killed (shell-command-detached.integration.test.ts, "survives its parent").
//
//   node shell-command-detached-parent.cjs <spec.json>
//
// spec.json: { command, args, cwd, env } - the prebuilt host spawn. The host is spawned
// exactly like createDetachedRunHost spawns it; this process then prints the host's pid
// and stays alive until the test kills its process group.
const { spawn } = require('node:child_process')
const { readFileSync } = require('node:fs')

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const child = spawn(spec.command, spec.args, {
  detached: true,
  stdio: 'ignore',
  cwd: spec.cwd,
  env: spec.env
})
child.unref()
process.stdout.write(`host=${child.pid}\n`)
setInterval(() => {}, 1000)
