export const CLAUDE_DOCKER_WRAPPER_SOURCE = String.raw`#!/usr/bin/env node
const { spawn } = require('child_process')
const { Transform } = require('stream')

function debug(message, data) {
  if (process.env.HIVE_DOCKER_SANDBOX_DEBUG !== '1') return
  const suffix = data ? ' ' + JSON.stringify(data) : ''
  process.stderr.write('[HiveClaudeDockerWrapper] ' + message + suffix + '\n')
}

function fail(message) {
  process.stderr.write(message + '\n')
  process.exit(1)
}

function writeControlSuccess(requestId, response) {
  process.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response
      }
    }) + '\n'
  )
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    fail('Missing required environment variable: ' + name)
  }
  return value
}

function stripSdkEntrypoint(args) {
  const filtered = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--include-partial-messages') continue
    if (arg === '--input-format') {
      index += 1
      continue
    }
    if (arg === '--setting-sources' && args[index + 1] === '') {
      index += 1
      continue
    }
    if (arg.endsWith('/cli.js') || arg.endsWith('/cli.mjs')) continue

    filtered.push(arg)
  }

  return filtered
}

function createJsonLineFilter(output) {
  let buffer = ''

  function flushLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return

    const jsonStart = trimmed.indexOf('{')
    if (jsonStart >= 0) {
      output.write(trimmed.slice(jsonStart) + '\n')
      return
    }

    debug('filtered-non-json-stdout', { line: trimmed.slice(0, 200) })
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        flushLine(line)
      }

      callback()
    },
    flush(callback) {
      if (buffer) {
        flushLine(buffer)
      }
      callback()
    }
  })
}

function readInitialPrompt() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false

    function cleanup() {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
    }

    function finish(error, value) {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }

    function onError(error) {
      finish(error)
    }

    function onEnd() {
      finish(new Error('Claude SDK stdin ended before the initial prompt message arrived'))
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const newlineIndex = buffer.indexOf(10)
        if (newlineIndex === -1) return

        const lineBuffer = buffer.subarray(0, newlineIndex)
        const remainder = buffer.subarray(newlineIndex + 1)
        buffer = remainder

        const line = lineBuffer.toString('utf8').trim()

        if (!line) {
          continue
        }

        let message
        try {
          message = JSON.parse(line)
        } catch (error) {
          finish(new Error('Failed to parse initial Claude SDK stdin JSON: ' + error.message))
          return
        }

        if (message.type !== 'user' || !message.message || !Array.isArray(message.message.content)) {
          if (
            message.type === 'control_request' &&
            message.request &&
            message.request.subtype === 'initialize' &&
            typeof message.request_id === 'string'
          ) {
            writeControlSuccess(message.request_id, {
              commands: [],
              models: []
            })
          }

          debug('buffering-non-user-stdin', {
            type: message.type || 'unknown',
            subtype: message.subtype || null,
            preview: line.slice(0, 200)
          })
          continue
        }

        const promptParts = []
        for (const part of message.message.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            promptParts.push(part.text)
          }
        }

        const prompt = promptParts.join('\n').trim()
        if (!prompt) {
          finish(new Error('Initial Claude SDK stdin user message did not contain text content'))
          return
        }

        finish(null, {
          prompt,
          remainder: buffer
        })
        return
      }
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

async function main() {
  const sandboxName = requireEnv('HIVE_DOCKER_SANDBOX_NAME')
  const sdkArgs = stripSdkEntrypoint(process.argv.slice(2))
  const initialPrompt = await readInitialPrompt()
  const dockerArgs = ['sandbox', 'exec']
  let stderrBuffer = ''

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    dockerArgs.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=' + process.env.CLAUDE_CODE_OAUTH_TOKEN)
  }

  dockerArgs.push(sandboxName, 'claude', '--print', ...sdkArgs, initialPrompt.prompt)

  process.stderr.write(
    '[HiveClaudeDockerWrapper] exec ' +
      JSON.stringify({
        sandboxName,
        dockerArgs: ['docker', ...dockerArgs],
        sdkArgs
      }) +
      '\n'
  )

  debug('launching-docker-sandbox', {
    sandboxName,
    dockerArgs
  })

  const child = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true
  })

  const stdoutFilter = createJsonLineFilter(process.stdout)
  child.stdout.pipe(stdoutFilter)
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    stderrBuffer += text
    if (stderrBuffer.length > 8000) {
      stderrBuffer = stderrBuffer.slice(-8000)
    }
    process.stderr.write(text)
  })
  child.stdin.end()

  process.stdin.on('data', () => {})
  process.stdin.resume()

  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))

  child.on('error', (error) => {
    fail('Failed to spawn docker sandbox wrapper child: ' + error.message)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    if (code && code !== 0) {
      process.stderr.write(
        '[HiveClaudeDockerWrapper] child-exit ' +
          JSON.stringify({
            code,
            sandboxName,
            dockerArgs: ['docker', ...dockerArgs],
            stderrTail: stderrBuffer.slice(-2000)
          }) +
          '\n'
      )
    }

    process.exit(code === null ? 1 : code)
  })
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
`
