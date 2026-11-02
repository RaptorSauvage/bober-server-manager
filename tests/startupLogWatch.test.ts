import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeTailReadStart, watchLogFile, watchLogFileForMarker } from '../src/main/lib/serverProcess'

const MARKER = 'READY_MARKER'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('computeTailReadStart', () => {
  it('reads from the previous size when the file has grown', () => {
    expect(computeTailReadStart(100, 250)).toBe(100)
  })

  it('returns null when the size is unchanged', () => {
    expect(computeTailReadStart(100, 100)).toBeNull()
  })

  it('restarts from 0 when the file shrank (rotated/truncated)', () => {
    expect(computeTailReadStart(500, 20)).toBe(0)
  })
})

describe('watchLogFileForMarker', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-log-watch-test-'))
    const logDir = path.join(tmpDir, 'ShooterGame', 'Saved', 'Logs')
    fs.mkdirSync(logDir, { recursive: true })
    logPath = path.join(logDir, 'ShooterGame.log')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not fire on content already in the file before this session (since is after it was written)', async () => {
    fs.writeFileSync(logPath, `${MARKER}\n`)
    const since = Date.now() + 50 // the file's mtime is before this, as if left over from a previous session

    let fired = false
    const stop = watchLogFileForMarker(tmpDir, MARKER, () => (fired = true), since, 20)
    await wait(150)
    stop()

    expect(fired).toBe(false)
  })

  it('fires immediately when the marker is already in the file as of this session (since is at/before it was written)', async () => {
    const since = Date.now() - 1000 // comfortably before the write below, like a real startedAt would be
    fs.writeFileSync(logPath, `${MARKER}\n`)

    let fired = false
    const stop = watchLogFileForMarker(tmpDir, MARKER, () => (fired = true), since, 20)
    await wait(60)
    stop()

    expect(fired).toBe(true)
  })

  it('fires once new content containing the marker is appended', async () => {
    const since = Date.now()
    fs.writeFileSync(logPath, 'Loading map...\n')

    let fired = false
    const stop = watchLogFileForMarker(tmpDir, MARKER, () => (fired = true), since, 20)
    await wait(60)
    fs.appendFileSync(logPath, `${MARKER}\n`)
    await wait(150)
    stop()

    expect(fired).toBe(true)
  })

  it('does not fire while the marker is absent', async () => {
    const since = Date.now()
    fs.writeFileSync(logPath, 'Loading map...\n')

    let fired = false
    const stop = watchLogFileForMarker(tmpDir, MARKER, () => (fired = true), since, 20)
    await wait(60)
    fs.appendFileSync(logPath, 'still loading...\n')
    await wait(150)
    stop()

    expect(fired).toBe(false)
  })

  it('handles the log file not existing yet when watching starts', async () => {
    const since = Date.now()
    let fired = false
    const stop = watchLogFileForMarker(tmpDir, MARKER, () => (fired = true), since, 20)
    await wait(60)
    fs.writeFileSync(logPath, 'starting up...\n')
    await wait(60)
    fs.appendFileSync(logPath, `${MARKER}\n`)
    await wait(150)
    stop()

    expect(fired).toBe(true)
  })

  it('stops polling once stop() is called', async () => {
    const since = Date.now()
    fs.writeFileSync(logPath, 'Loading map...\n')

    let fired = false
    const stop = watchLogFileForMarker(tmpDir, MARKER, () => (fired = true), since, 20)
    await wait(40)
    stop()
    fs.appendFileSync(logPath, `${MARKER}\n`)
    await wait(150)

    expect(fired).toBe(false)
  })
})

describe('watchLogFile', () => {
  let tmpDir: string
  let logPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-log-watch-test-'))
    const logDir = path.join(tmpDir, 'ShooterGame', 'Saved', 'Logs')
    fs.mkdirSync(logDir, { recursive: true })
    logPath = path.join(logDir, 'ShooterGame.log')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('detects a server restart even when the new log already exceeds the old one\'s size by the next poll', async () => {
    fs.writeFileSync(logPath, 'old session line 1\nold session line 2\n')

    const chunks: string[] = []
    const rotatedFlags: boolean[] = []
    const stop = watchLogFile(
      tmpDir,
      (chunk, rotated) => {
        chunks.push(chunk)
        rotatedFlags.push(rotated)
      },
      20
    )
    await wait(60) // let it capture the old file's size as the baseline first

    // Simulate a restart that completes within a single poll interval: the old log is
    // rotated away to a backup filename (as ARK does on every server start, so the old
    // inode stays alive under the new name rather than being freed/reused) and a brand
    // new, already-bigger log is written before the tailer gets a chance to notice the
    // file shrank first.
    fs.renameSync(logPath, logPath + '.bak')
    fs.writeFileSync(logPath, 'new session line 1\nnew session line 2\nnew session line 3\n')

    await wait(150)
    stop()

    const combined = chunks.join('')
    expect(combined).toContain('new session line 1')
    expect(combined).not.toContain('old session line')
    expect(rotatedFlags).toContain(true)
  })

  it('reports rotated as false for ordinary growth of the same log file', async () => {
    fs.writeFileSync(logPath, 'line 1\n')

    const rotatedFlags: boolean[] = []
    const stop = watchLogFile(tmpDir, (_chunk, rotated) => rotatedFlags.push(rotated), 20)
    await wait(60)

    fs.appendFileSync(logPath, 'line 2\n')
    await wait(150)
    stop()

    expect(rotatedFlags.length).toBeGreaterThan(0)
    expect(rotatedFlags.every((r) => r === false)).toBe(true)
  })
})
