import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { platform } from 'node:process'
import type { ServerProfile } from '../shared/types'

class FakeChildProcess extends EventEmitter {
  pid: number | undefined
  unref = vi.fn()
  kill = vi.fn()
  constructor(pid: number | undefined = 4242) {
    super()
    this.pid = pid
  }
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn(() => new FakeChildProcess()) }))
vi.mock('node:child_process', () => ({ spawn: spawnMock, exec: vi.fn() }))

import { startServer, serverEvents, getExecutablePath, __resetServerSpawnQueueForTests } from '../src/main/lib/serverProcess'
import type { ServerStatus } from '../shared/types'

beforeEach(() => {
  __resetServerSpawnQueueForTests()
})

function makeProfile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 'cwd-test',
    name: 'CWD Test',
    game: 'ark-evolved',
    installDir: platform === 'win32' ? 'A:\\Serveur\\ASE\\ASE Servers Data\\Gen2' : '/srv/ase/gen2',
    map: 'Gen2',
    moddedMapEnabled: false,
    moddedMapId: '',
    gamePort: 8004,
    rconPort: 8202,
    queryPort: 8102,
    serverPlatform: 'PC',
    maxPlayers: 10,
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

describe('startServer spawn options', () => {
  it("spawns with cwd set to the executable's own directory, not the install root", () => {
    spawnMock.mockClear()
    const profile = makeProfile()
    startServer(profile)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, , options] = spawnMock.mock.calls[0]
    const exe = getExecutablePath(profile)
    expect(options.cwd).toBe(path.dirname(exe))
    expect(options.cwd).not.toBe(profile.installDir)
  })

  it('spawns with windowsVerbatimArguments (a harmless no-op for a direct-spawned profile, kept for parity)', () => {
    spawnMock.mockClear()
    startServer(makeProfile({ id: 'verbatim-test' }))

    const [, , options] = spawnMock.mock.calls[0]
    expect(options.windowsVerbatimArguments).toBe(true)
  })

  it('attaches the error listener before checking pid, so a deferred async spawn failure never throws unhandled and the real OS error replaces the generic "no pid" message', () => {
    spawnMock.mockClear()
    // spawn() returning with pid already undefined, then reporting the real failure
    // (ENOENT/EACCES, the common real-world case) a tick later via 'error' - the exact shape
    // Node itself uses for a spawn that fails without throwing synchronously.
    const failingChild = new FakeChildProcess(undefined)
    spawnMock.mockReturnValueOnce(failingChild)
    const profile = makeProfile({ id: 'no-pid-test' })

    const immediate = startServer(profile)
    expect(immediate.state).toBe('error')
    expect(immediate.lastError).toBe('Process started without a pid.')

    // A failed spawn never ends up in the `running` map, so getStatus() (which only reads
    // from there) can't observe this - subscribe to the raw broadcast instead, same as every
    // other real listener (the IPC status push, crashWatch, ...) does.
    const seen: ServerStatus[] = []
    const onStatus = (status: ServerStatus): void => {
      if (status.profileId === profile.id) seen.push(status)
    }
    serverEvents.on('status', onStatus)

    // If the fix's listener weren't already attached at this point, this emit() would throw
    // instead of returning - EventEmitter's own special case for 'error' with zero listeners -
    // failing this test outright rather than silently passing.
    try {
      expect(() => failingChild.emit('error', new Error('spawn ENOENT'))).not.toThrow()
    } finally {
      serverEvents.off('status', onStatus)
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ profileId: profile.id, state: 'error', lastError: 'spawn ENOENT' })
  })
})
