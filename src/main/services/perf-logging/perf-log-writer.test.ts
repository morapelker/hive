import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PerfLogWriter } from './perf-log-writer'

describe('PerfLogWriter', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-log-writer-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('queues records and writes them as JSON lines on flush', () => {
    const writer = new PerfLogWriter({ dir, fileName: 'perf-test.jsonl' })
    writer.write({ kind: 'a', n: 1 })
    writer.write({ kind: 'b', n: 2 })
    expect(writer.queuedCount()).toBe(2)
    writer.flush()
    const lines = readFileSync(writer.filePath, 'utf8').trim().split('\n')
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { kind: 'a', n: 1 },
      { kind: 'b', n: 2 }
    ])
    writer.close()
  })

  it('flushes on its own once the queue reaches the burst threshold', () => {
    const writer = new PerfLogWriter({ dir, fileName: 'perf-test.jsonl', flushAtQueueSize: 3 })
    writer.write({ n: 1 })
    writer.write({ n: 2 })
    writer.write({ n: 3 })
    expect(writer.queuedCount()).toBe(0)
    expect(readFileSync(writer.filePath, 'utf8').trim().split('\n')).toHaveLength(3)
    writer.close()
  })

  it('rotates the file once it crosses the size limit', () => {
    const writer = new PerfLogWriter({
      dir,
      fileName: 'perf-test.jsonl',
      maxBytes: 64,
      maxRotatedFiles: 2
    })
    writeFileSync(writer.filePath, 'x'.repeat(60) + '\n')
    writer.write({ kind: 'after-rotation', padding: 'y'.repeat(20) })
    writer.flush()
    expect(readFileSync(`${writer.filePath}.1`, 'utf8')).toBe('x'.repeat(60) + '\n')
    expect(readFileSync(writer.filePath, 'utf8')).toContain('after-rotation')
    writer.close()
  })

  it('drops records after close and reports write errors without throwing', () => {
    const errors: unknown[] = []
    const writer = new PerfLogWriter({
      dir: join(dir, 'file-not-dir'),
      fileName: 'perf-test.jsonl',
      onError: (error) => errors.push(error)
    })
    writeFileSync(join(dir, 'file-not-dir'), '')
    writer.write({ n: 1 })
    expect(() => writer.flush()).not.toThrow()
    expect(errors).toHaveLength(1)
    writer.close()
    writer.write({ n: 2 })
    expect(writer.queuedCount()).toBe(0)
  })
})
