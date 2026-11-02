import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isValidArkInstall, detectGameFromInstall, detectProfileFields, uniqueProfileName } from '../src/main/lib/detect'

describe('uniqueProfileName', () => {
  it('returns the base name when it is not taken', () => {
    expect(uniqueProfileName('My Server', ['Other'])).toBe('My Server')
  })

  it('appends an incrementing suffix on collision', () => {
    expect(uniqueProfileName('My Server', ['My Server'])).toBe('My Server (2)')
    expect(uniqueProfileName('My Server', ['My Server', 'My Server (2)'])).toBe('My Server (3)')
  })

  it('falls back to a generic name when the base is blank', () => {
    expect(uniqueProfileName('  ', [])).toBe('Imported Server')
  })
})

describe('install detection', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-detect-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports an invalid install when no server executable is present', async () => {
    expect(await isValidArkInstall(tmpDir, 'ark-ascended')).toBe(false)
  })

  it('reports a valid install once the Windows executable exists', async () => {
    const binDir = path.join(tmpDir, 'ShooterGame', 'Binaries', 'Win64')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'ArkAscendedServer.exe'), '')
    expect(await isValidArkInstall(tmpDir, 'ark-ascended')).toBe(true)
  })

  it('does not mistake an ark-evolved install for an ark-ascended one, and vice versa', async () => {
    const binDir = path.join(tmpDir, 'ShooterGame', 'Binaries', 'Win64')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'ShooterGameServer.exe'), '')
    expect(await isValidArkInstall(tmpDir, 'ark-evolved')).toBe(true)
    expect(await isValidArkInstall(tmpDir, 'ark-ascended')).toBe(false)
  })

  it('detectGameFromInstall returns null when no known executable is present', async () => {
    expect(await detectGameFromInstall(tmpDir)).toBeNull()
  })

  it('detectGameFromInstall recognizes an ark-ascended install', async () => {
    const binDir = path.join(tmpDir, 'ShooterGame', 'Binaries', 'Win64')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'ArkAscendedServer.exe'), '')
    expect(await detectGameFromInstall(tmpDir)).toBe('ark-ascended')
  })

  it('detectGameFromInstall recognizes an ark-evolved install', async () => {
    const binDir = path.join(tmpDir, 'ShooterGame', 'Binaries', 'Win64')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'ShooterGameServer.exe'), '')
    expect(await detectGameFromInstall(tmpDir)).toBe('ark-evolved')
  })

  it('detects the map from the SavedArks folder and mods from the ini', () => {
    const mapDir = path.join(tmpDir, 'ShooterGame', 'Saved', 'SavedArks', 'TheIsland_WP')
    fs.mkdirSync(mapDir, { recursive: true })

    const configDir = path.join(tmpDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'GameUserSettings.ini'),
      ['[ServerSettings]', 'ActiveMods=111,222'].join('\n')
    )

    const detected = detectProfileFields(tmpDir)
    expect(detected.map).toBe('TheIsland_WP')
    expect(detected.mods).toEqual([
      { id: '111', enabled: true, passive: false, dev: false },
      { id: '222', enabled: true, passive: false, dev: false }
    ])
  })

  it('falls back to sensible empty values when nothing can be detected', () => {
    const detected = detectProfileFields(tmpDir)
    expect(detected.map).toBe('')
    expect(detected.mods).toEqual([])
    expect(detected.gamePort).toBeUndefined()
  })
})
