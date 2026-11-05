#!/usr/bin/env node
/**
 * Regenerates the voice-dictation test clips in test/fixtures/voice (macOS only).
 *
 * Every clip is 16 kHz mono 16-bit WAV spoken by macOS `say` (Samantha), with
 * its expected transcript in a .txt file of the same name. The app plays them
 * instead of the microphone when launched with TEDOOO_CODE_VOICE_TEST_CLIPS=1
 * (see .claude/skills/verify/SKILL.md).
 *
 *   node scripts/generate-voice-fixtures.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 16000
const VOICE = 'Samantha'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'voice')

const SHORT_COMMAND = 'Create a new ticket for the login bug on the home page.'

const SENTENCE =
  'Please move the settings button to the top right corner of the window, make it a little bigger, ' +
  'and give it the same color as the other buttons on the toolbar.'

const PARAGRAPH =
  'I looked at the crash report from this morning. The app closes when the user opens a project ' +
  'while the board is still loading. I think the loading state is cleared too early, so the page ' +
  'tries to read a list that does not exist yet. Can you add a check before we read the list, and ' +
  'write a test that opens a project during loading? It would also help to show a small spinner ' +
  'in the sidebar, so people know the board is not ready. When you are done, send me the branch ' +
  'and I will review it after lunch.'

const MONOLOGUE =
  'Here is the plan for the release this week. First, we finish the voice work, because the team ' +
  'has been waiting for it and the design is already approved. The live preview should show the ' +
  'words above the pill while the user is talking, and the final text should be ready as soon as ' +
  'they press the key again. Second, we clean up the settings page. Some of the labels are too long, ' +
  'and two of the switches do the same thing, so we should merge them into one. Third, we look at ' +
  'the startup time. The app takes almost three seconds to show the first window on an older laptop, ' +
  'and most of that time is spent loading data we do not need yet. If we load it later, the window ' +
  'should appear much faster. Finally, we write the release notes and send them to the support team ' +
  'before Friday, so they know what changed and can answer questions from users. If anything ' +
  'slips, tell me early, and we can move it to the next release instead of rushing it. I would ' +
  'rather ship fewer things that work well than many things that break on the first day. Thanks, ' +
  'everyone, for the hard work this month.'

const PAUSE_BEFORE = 'Open the terminal for this project.'
const PAUSE_AFTER = 'Then run all of the tests again.'
const PAUSE_SECONDS = 7

const SPEECH_AT_START = 'Hello, can you rename this branch to main?'

const SILENCE_SECONDS = 3

function say(text, dir, name) {
  const path = join(dir, `${name}.wav`)
  execFileSync('/usr/bin/say', [
    '-v',
    VOICE,
    '--file-format=WAVE',
    `--data-format=LEI16@${SAMPLE_RATE}`,
    '-o',
    path,
    text
  ])
  return readPcm16(readFileSync(path))
}

/** Minimal reader for `say`'s output: 16-bit little-endian PCM, mono, 16 kHz. */
function readPcm16(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let format = null
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      if (!format || format.channels !== 1 || format.bits !== 16 || format.sampleRate !== SAMPLE_RATE) {
        throw new Error(`unexpected say output format: ${JSON.stringify(format)}`)
      }
      return new Int16Array(bytes.slice(body, body + size).buffer)
    }
    offset = body + size + (size % 2)
  }
  throw new Error('no data chunk in say output')
}

function writeWav(name, samples, text) {
  const header = Buffer.alloc(44)
  const dataBytes = samples.length * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  const data = Buffer.from(samples.buffer, samples.byteOffset, dataBytes)
  writeFileSync(join(OUT_DIR, `${name}.wav`), Buffer.concat([header, data]))
  writeFileSync(join(OUT_DIR, `${name}.txt`), text ? `${text}\n` : '')
  const seconds = (samples.length / SAMPLE_RATE).toFixed(2)
  console.log(`${name}.wav  ${seconds} s  ${((44 + dataBytes) / 1024).toFixed(0)} KiB`)
}

function concat(...parts) {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Drop everything before the first clearly audible sample, so speech starts at sample 0. */
function trimLeading(samples) {
  const threshold = 0.02 * 32768
  const first = samples.findIndex((sample) => Math.abs(sample) > threshold)
  return first > 0 ? samples.slice(first) : samples
}

const work = mkdtempSync(join(tmpdir(), 'voice-fixtures-'))
try {
  writeWav('short-command', say(SHORT_COMMAND, work, 'short'), SHORT_COMMAND)
  writeWav('sentence', say(SENTENCE, work, 'sentence'), SENTENCE)
  writeWav('paragraph', say(PARAGRAPH, work, 'paragraph'), PARAGRAPH)
  writeWav('monologue', say(MONOLOGUE, work, 'monologue'), MONOLOGUE)
  writeWav(
    'pause-mid',
    concat(
      say(PAUSE_BEFORE, work, 'pause-before'),
      new Int16Array(PAUSE_SECONDS * SAMPLE_RATE),
      say(PAUSE_AFTER, work, 'pause-after')
    ),
    `${PAUSE_BEFORE} ${PAUSE_AFTER}`
  )
  writeWav('speech-at-start', trimLeading(say(SPEECH_AT_START, work, 'start')), SPEECH_AT_START)
  writeWav('silence', new Int16Array(SILENCE_SECONDS * SAMPLE_RATE), '')
} finally {
  rmSync(work, { recursive: true, force: true })
}
