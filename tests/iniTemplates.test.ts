import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { ServerProfile, IniTemplateContent, IniTemplateProfileOverride, ModEventHistoryEntry } from '../shared/types'

function makeProfile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 'p1',
    name: 'Island Server',
    game: 'ark-ascended',
    installDir: '/tmp/ark',
    map: 'TheIsland_WP',
    moddedMapEnabled: false,
    moddedMapId: '',
    gamePort: 7777,
    rconPort: 27020,
    queryPort: 27015,
    serverPlatform: 'PC',
    maxPlayers: 70,
    backupDir: '',
    maxBackups: 10,
    backupScheduleEnabled: false,
    playerProfileBackupEnabled: false,
    playerProfileBackupMaxPerPlayer: 20,
    mods: [],
    clusterEnabled: false,
    clusterId: '',
    clusterDirOverride: '',
    noTransferFromFiltering: false,
    externalIp: '',
    cultureSettings: 'none',
    disableBattlEye: false,
    rconTribeLog: false,
    forceRespawnDinos: false,
    noSound: false,
    maxDinoLevel: '',
    serverPassword: '',
    autoManageMods: false,
    extraArgs: '',
    scheduledRestartEnabled: false,
    scheduledRestartTime: '00:00',
    scheduledRestartDays: [],
    scheduledRestartUpdateAfter: false,
    scheduledRestartStartAfter: false,
    scheduledDinoWipeEnabled: false,
    scheduledDinoWipeTime: '00:00',
    scheduledDinoWipeDays: [],
    startOnManagerLaunch: false,
    hidden: false,
    group: '',
    crashWatchEnabled: false,
    zombieDetectionEnabled: false,
    zombieDetectionTimeoutMinutes: 10,
    zombieDetectionAutoRestart: false,
    clusterLogArchiveMaxSizeMB: 10,
    ...overrides
  }
}

const { mockGeneric, mockOverrides, mockHistory, mockProfiles } = vi.hoisted(() => ({
  mockGeneric: { value: { gameUserSettingsIni: '', gameIni: '' } as IniTemplateContent },
  mockOverrides: { value: new Map<string, IniTemplateProfileOverride>() },
  mockHistory: { value: [] as ModEventHistoryEntry[] },
  mockProfiles: { value: [] as ServerProfile[] }
}))

vi.mock('../src/main/store', () => ({
  listProfiles: () => mockProfiles.value,
  getIniTemplateGeneric: () => mockGeneric.value,
  getIniTemplateOverride: (profileId: string) => mockOverrides.value.get(profileId),
  recordConfigFileHistory: (profileId: string, relPath: string, content: string) => {
    mockHistory.value.push({
      id: `h-${mockHistory.value.length}`,
      eventId: profileId,
      eventName: relPath,
      action: 'activated',
      timestamp: Date.now(),
      profileIds: [profileId]
    } as unknown as ModEventHistoryEntry)
    void content
  }
}))

describe('applyIniTemplate/applyIniTemplateToAll', () => {
  let tmpDir: string
  let installDir: string
  let configDir: string
  let gusPath: string
  let gamePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ini-templates-test-'))
    installDir = path.join(tmpDir, 'install')
    configDir = path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer')
    fs.mkdirSync(configDir, { recursive: true })
    gusPath = path.join(configDir, 'GameUserSettings.ini')
    gamePath = path.join(configDir, 'Game.ini')
    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '' }
    mockOverrides.value = new Map()
    mockHistory.value = []
    mockProfiles.value = []
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('applies the generic template, then force-sets SessionName to the profile name', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nServerPVE=False\nMaxPlayers=70', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir, name: 'My Cool Server' }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content).toContain('ServerPVE=False')
    expect(content).toContain('MaxPlayers=70')
    expect(content).toContain('[SessionSettings]')
    expect(content).toContain('SessionName=My Cool Server')
  })

  it('sets SessionName by replacing its value in place, not by adding a separate block for it', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    fs.writeFileSync(gusPath, '[SessionSettings]\nSessionName=Old Name\nPort=7777\n', 'utf-8')
    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir, name: 'My Cool Server' }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content).toContain('SessionName=My Cool Server')
    expect(content).not.toContain('Old Name')
    expect(content.match(/SessionName=/g)).toHaveLength(1)
    expect(content.match(/\[SessionSettings\]/g)).toHaveLength(1)
  })

  it("merges a new key into a section the real file already has, instead of creating a second copy of that section - the exact bug report: DifficultyOffset and the existing XPMultiplier end up together", async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    fs.writeFileSync(gusPath, '[ServerSettings]\nXPMultiplier=10.0\n', 'utf-8')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nDifficultyOffset=1.0', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content.match(/\[ServerSettings\]/g)).toHaveLength(1)
    expect(content).toContain('XPMultiplier=10.0')
    expect(content).toContain('DifficultyOffset=1.0')
  })

  it('re-applying updates an already-applied key in place instead of leaving the old value sitting there too', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nDifficultyOffset=1.0', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir }))
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nDifficultyOffset=2.0', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content.match(/DifficultyOffset=/g)).toHaveLength(1)
    expect(content).toContain('DifficultyOffset=2.0')
    expect(content).not.toContain('DifficultyOffset=1.0')
  })

  it("carries a template key's own comment along only when that key is new to the real file", async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    fs.writeFileSync(gusPath, '[ServerSettings]\nXPMultiplier=10.0\n', 'utf-8')
    mockGeneric.value = {
      gameUserSettingsIni: '[ServerSettings]\n; Harvest rate for the whole cluster\nHarvestAmountMultiplier=3.0',
      gameIni: ''
    }
    applyIniTemplate(makeProfile({ installDir }))

    const lines = fs.readFileSync(gusPath, 'utf-8').split(/\r\n|\n/)
    const commentIndex = lines.indexOf('; Harvest rate for the whole cluster')
    expect(commentIndex).toBeGreaterThan(-1)
    expect(lines[commentIndex + 1]).toBe('HarvestAmountMultiplier=3.0')
  })

  it("the override's own value wins over the generic template for the same key, merged into the same section", async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    mockOverrides.value.set('p1', { profileId: 'p1', gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=10', gameIni: '', sessionName: '' })
    applyIniTemplate(makeProfile({ installDir }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content.match(/\[ServerSettings\]/g)).toHaveLength(1)
    expect(content.match(/MaxPlayers=/g)).toHaveLength(1)
    expect(content).toContain('MaxPlayers=10')
    expect(content).not.toContain('MaxPlayers=70')
  })

  it("the forced SessionName always wins, even if the server's own override or generic template tries to set its own", async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[SessionSettings]\nSessionName=Generic Placeholder', gameIni: '' }
    mockOverrides.value.set('p1', {
      profileId: 'p1',
      gameUserSettingsIni: '[SessionSettings]\nSessionName=Some Other Name\n[ServerSettings]\nMaxPlayers=10',
      gameIni: '',
      sessionName: ''
    })
    applyIniTemplate(makeProfile({ installDir, name: 'My Cool Server' }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content).toContain('SessionName=My Cool Server')
    expect(content).not.toContain('Generic Placeholder')
    expect(content).not.toContain('Some Other Name')
    expect(content.match(/SessionName=/g)).toHaveLength(1)
    expect(content).toContain('MaxPlayers=10')
  })

  it("an override's own sessionName field wins over the profile's Manager name", async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '' }
    mockOverrides.value.set('p1', { profileId: 'p1', gameUserSettingsIni: '', gameIni: '', sessionName: '[EU] My Cluster - Island PvE' })
    applyIniTemplate(makeProfile({ installDir, name: 'Island' }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content).toContain('SessionName=[EU] My Cluster - Island PvE')
    expect(content).not.toMatch(/SessionName=Island\b/)
  })

  it('falls back to the Manager profile name when the override has no sessionName of its own', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '' }
    mockOverrides.value.set('p1', { profileId: 'p1', gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=10', gameIni: '', sessionName: '' })
    applyIniTemplate(makeProfile({ installDir, name: 'Island' }))

    expect(fs.readFileSync(gusPath, 'utf-8')).toContain('SessionName=Island')
  })

  it('re-applying with a changed override updates the same key in place instead of leaving the old value too', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    mockOverrides.value.set('p1', { profileId: 'p1', gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=10', gameIni: '', sessionName: '' })
    applyIniTemplate(makeProfile({ installDir }))
    mockOverrides.value.set('p1', { profileId: 'p1', gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=20', gameIni: '', sessionName: '' })
    applyIniTemplate(makeProfile({ installDir }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content.match(/\[ServerSettings\]/g)).toHaveLength(1)
    expect(content.match(/MaxPlayers=/g)).toHaveLength(1)
    expect(content).toContain('MaxPlayers=20')
    expect(content).not.toContain('MaxPlayers=10')
  })

  it('clearing the override and re-applying reverts the key to whatever the generic template alone says', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    mockOverrides.value.set('p1', { profileId: 'p1', gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=10', gameIni: '', sessionName: '' })
    applyIniTemplate(makeProfile({ installDir }))
    mockOverrides.value.delete('p1')
    applyIniTemplate(makeProfile({ installDir }))

    const content = fs.readFileSync(gusPath, 'utf-8')
    expect(content.match(/MaxPlayers=/g)).toHaveLength(1)
    expect(content).toContain('MaxPlayers=70')
    expect(content).not.toContain('MaxPlayers=10')
  })

  it('writes to Game.ini too, independently of GameUserSettings.ini, keeping its own dotted section name intact', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = {
      gameUserSettingsIni: '',
      gameIni: '[/script/shootergame.shootergamemode]\nXPMultiplier=2.0\nTamingSpeedMultiplier=3.0'
    }
    applyIniTemplate(makeProfile({ installDir }))

    const content = fs.readFileSync(gamePath, 'utf-8')
    expect(content).toContain('[/script/shootergame.shootergamemode]')
    expect(content).toContain('XPMultiplier=2.0')
    expect(content).toContain('TamingSpeedMultiplier=3.0')
  })

  it('leaves Game.ini untouched entirely when neither template has anything for it', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir }))

    expect(fs.existsSync(gamePath)).toBe(false)
  })

  it('never touches a manually-added line the templates never mention', async () => {
    const { applyIniTemplate } = await import('../src/main/lib/iniTemplates')
    fs.writeFileSync(gusPath, '[ServerSettings]\nServerAdminPassword=secret\n', 'utf-8')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    applyIniTemplate(makeProfile({ installDir }))

    expect(fs.readFileSync(gusPath, 'utf-8')).toContain('ServerAdminPassword=secret')
  })

  it("applyIniTemplateToAll reports each profile's own outcome without one failure blocking the rest", async () => {
    const { applyIniTemplateToAll } = await import('../src/main/lib/iniTemplates')
    const goodInstallDir = path.join(tmpDir, 'install-good')
    const badInstallDir = path.join(tmpDir, 'install-bad')
    fs.mkdirSync(path.join(goodInstallDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer'), { recursive: true })
    fs.mkdirSync(path.join(badInstallDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer'), { recursive: true })

    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    mockProfiles.value = [
      makeProfile({ id: 'good', name: 'Good Server', installDir: goodInstallDir }),
      makeProfile({ id: 'bad', name: 'Bad Server', installDir: badInstallDir })
    ]

    // A real disk/permission failure (e.g. the config dir locked read-only while the server
    // is running) - same reasoning as upsertIniKey's own disk-failure test in
    // gameConfigWrite.test.ts.
    const realWriteFileSync = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, ...rest: unknown[]) => {
      if (String(filePath).includes('install-bad')) throw new Error('simulated disk failure')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realWriteFileSync as any)(filePath, ...rest)
    })
    try {
      const results = await applyIniTemplateToAll()
      expect(results).toEqual([
        { profileId: 'good', profileName: 'Good Server', ok: true },
        { profileId: 'bad', profileName: 'Bad Server', ok: false, error: expect.stringContaining('simulated disk failure') }
      ])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('generatePendingIniTemplate/confirmPendingIniTemplate/discardPendingIniTemplate', () => {
  let tmpDir: string
  let installDir: string
  let configDir: string
  let gusPath: string
  let gusPendingPath: string
  let gamePath: string
  let gamePendingPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ini-templates-pending-test-'))
    installDir = path.join(tmpDir, 'install')
    configDir = path.join(installDir, 'ShooterGame', 'Saved', 'Config', 'WindowsServer')
    fs.mkdirSync(configDir, { recursive: true })
    gusPath = path.join(configDir, 'GameUserSettings.ini')
    gusPendingPath = path.join(configDir, 'GameUserSettings.pending.ini')
    gamePath = path.join(configDir, 'Game.ini')
    gamePendingPath = path.join(configDir, 'Game.pending.ini')
    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '' }
    mockOverrides.value = new Map()
    mockHistory.value = []
    mockProfiles.value = []
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stages the merged result into a *.pending.ini file without touching the real one', async () => {
    const { generatePendingIniTemplate } = await import('../src/main/lib/iniTemplates')
    fs.writeFileSync(gusPath, '[ServerSettings]\nServerAdminPassword=secret\n', 'utf-8')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }

    const result = generatePendingIniTemplate(makeProfile({ installDir, name: 'My Cool Server' }))

    expect(fs.readFileSync(gusPath, 'utf-8')).toBe('[ServerSettings]\nServerAdminPassword=secret\n')
    const pendingContent = fs.readFileSync(gusPendingPath, 'utf-8')
    expect(pendingContent).toContain('ServerAdminPassword=secret')
    expect(pendingContent).toContain('MaxPlayers=70')
    expect(pendingContent).toContain('SessionName=My Cool Server')
    expect(result.gameUserSettingsIniPath).toBe(path.join('ShooterGame', 'Saved', 'Config', 'WindowsServer', 'GameUserSettings.pending.ini'))
    expect(result.gameIniPath).toBeNull()
    expect(fs.existsSync(gamePendingPath)).toBe(false)
  })

  it('getPendingIniTemplateStatus reflects what was last staged, or null if nothing was', async () => {
    const { generatePendingIniTemplate, getPendingIniTemplateStatus } = await import('../src/main/lib/iniTemplates')
    const profile = makeProfile({ installDir })

    expect(getPendingIniTemplateStatus(profile)).toBeNull()
    generatePendingIniTemplate(profile)
    expect(getPendingIniTemplateStatus(profile)).not.toBeNull()
  })

  it('confirmPendingIniTemplate replaces the real file with the pending file verbatim - hand-edits included - and removes it', async () => {
    const { generatePendingIniTemplate, confirmPendingIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=70', gameIni: '' }
    const profile = makeProfile({ installDir, name: 'My Cool Server' })
    generatePendingIniTemplate(profile)

    // The whole point of staging into a real file: the user can hand-edit it before confirming.
    const handEdited = fs.readFileSync(gusPendingPath, 'utf-8').replace('MaxPlayers=70', 'MaxPlayers=10')
    fs.writeFileSync(gusPendingPath, handEdited, 'utf-8')

    confirmPendingIniTemplate(profile)

    expect(fs.readFileSync(gusPath, 'utf-8')).toBe(handEdited)
    expect(fs.existsSync(gusPendingPath)).toBe(false)
    expect(mockHistory.value).toHaveLength(1)
  })

  it('confirmPendingIniTemplate throws when nothing was staged', async () => {
    const { confirmPendingIniTemplate } = await import('../src/main/lib/iniTemplates')
    expect(() => confirmPendingIniTemplate(makeProfile({ installDir }))).toThrow(/nothing staged/i)
  })

  it('discardPendingIniTemplate removes the staged files without touching the real ones', async () => {
    const { generatePendingIniTemplate, discardPendingIniTemplate } = await import('../src/main/lib/iniTemplates')
    fs.writeFileSync(gusPath, '[ServerSettings]\nMaxPlayers=70\n', 'utf-8')
    mockGeneric.value = { gameUserSettingsIni: '[ServerSettings]\nMaxPlayers=10', gameIni: '' }
    const profile = makeProfile({ installDir })
    generatePendingIniTemplate(profile)

    discardPendingIniTemplate(profile)

    expect(fs.existsSync(gusPendingPath)).toBe(false)
    expect(fs.readFileSync(gusPath, 'utf-8')).toBe('[ServerSettings]\nMaxPlayers=70\n')
  })

  it('discardPendingIniTemplate is a no-op, not an error, when nothing was staged', async () => {
    const { discardPendingIniTemplate } = await import('../src/main/lib/iniTemplates')
    expect(() => discardPendingIniTemplate(makeProfile({ installDir }))).not.toThrow()
  })

  it('a re-generate drops a stale Game.pending.ini once the override no longer has any Game.ini entries', async () => {
    const { generatePendingIniTemplate } = await import('../src/main/lib/iniTemplates')
    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '[/script/shootergame.shootergamemode]\nXPMultiplier=2.0' }
    const profile = makeProfile({ installDir })
    const first = generatePendingIniTemplate(profile)
    expect(first.gameIniPath).not.toBeNull()
    expect(fs.existsSync(gamePendingPath)).toBe(true)

    mockGeneric.value = { gameUserSettingsIni: '', gameIni: '' }
    const second = generatePendingIniTemplate(profile)

    expect(second.gameIniPath).toBeNull()
    expect(fs.existsSync(gamePendingPath)).toBe(false)
  })
})
