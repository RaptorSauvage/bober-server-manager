import { useEffect, useState } from 'react'
import type { AppSettings, ServerProfile } from '@shared/types'
import { confirmAction } from '../lib/confirmAction'

interface ManageGroupsDialogProps {
  profiles: ServerProfile[]
  onProfilesChange: (profiles: ServerProfile[]) => void
  onClose: () => void
}

/** File > Manage Groups - the one place a dashboard group gets created, renamed, or deleted
 *  outright (a server card's own "Group" submenu only ever assigns an existing one, or spins
 *  up a brand new one in passing). Renaming/deleting here also updates every profile
 *  currently carrying that group name, since ServerProfile.group is just a free-form string
 *  rather than a reference to some separate group record. */
export default function ManageGroupsDialog({ profiles, onProfilesChange, onClose }: ManageGroupsDialogProps): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [renamingName, setRenamingName] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    window.api.settings.get().then(setSettings)
  }, [])

  const groupNamesRaw = Array.from(
    new Set([
      ...profiles.filter((p) => p.group.trim()).map((p) => p.group.trim()),
      ...(settings?.registeredGroups ?? [])
    ])
  )
  const groupOrder = settings?.groupOrder ?? []
  const groupNames = [
    ...groupOrder.filter((name) => groupNamesRaw.includes(name)),
    ...groupNamesRaw.filter((name) => !groupOrder.includes(name)).sort((a, b) => a.localeCompare(b))
  ]

  function countInGroup(name: string): number {
    return profiles.filter((p) => p.group.trim() === name).length
  }

  // Takes a function of the *freshly re-fetched* settings rather than a plain patch object -
  // this dialog's own `settings` snapshot (fetched once on mount) can go stale if something
  // else saves settings while it's open (the Settings screen, another window, the web
  // dashboard's own HTTP routes), and settings.save() replaces the whole stored object rather
  // than merging it, so computing the patch from a stale base risks losing those other changes
  // even though this dialog clearly only means to touch its own group fields.
  async function persistSettings(computePatch: (current: AppSettings) => Partial<AppSettings>): Promise<AppSettings> {
    const current = await window.api.settings.get()
    const next = { ...current, ...computePatch(current) }
    await window.api.settings.save(next)
    setSettings(next)
    return next
  }

  async function createGroup(): Promise<void> {
    const trimmed = newGroupName.trim()
    if (!trimmed || !settings) return
    if (groupNames.includes(trimmed)) {
      setError(`A group named "${trimmed}" already exists.`)
      return
    }
    setError('')
    await persistSettings((current) => ({ registeredGroups: [...current.registeredGroups, trimmed] }))
    setNewGroupName('')
  }

  async function renameGroup(oldName: string): Promise<void> {
    const trimmed = renameValue.trim()
    if (!trimmed || !settings) {
      setRenamingName(null)
      return
    }
    if (trimmed === oldName) {
      setRenamingName(null)
      return
    }
    if (groupNames.includes(trimmed)) {
      setError(`A group named "${trimmed}" already exists.`)
      return
    }
    setError('')
    setBusy(true)
    try {
      const renameInList = (list: string[]): string[] => list.map((n) => (n === oldName ? trimmed : n))
      await persistSettings((current) => {
        // oldName may only have existed implicitly (a profile's free-text group, never
        // explicitly registered) - add it first so the rename below still has something to act
        // on, same as how a brand new group gets registered the first time it's used.
        const registeredWithOld = current.registeredGroups.includes(oldName)
          ? current.registeredGroups
          : [...current.registeredGroups, oldName]
        return {
          registeredGroups: renameInList(registeredWithOld),
          groupOrder: renameInList(current.groupOrder),
          collapsedGroups: renameInList(current.collapsedGroups)
        }
      })

      const affected = profiles.filter((p) => p.group.trim() === oldName)
      let latest = profiles
      for (const profile of affected) {
        latest = await window.api.profiles.save({ ...profile, group: trimmed })
      }
      if (affected.length > 0) onProfilesChange(latest)
      setRenamingName(null)
    } finally {
      setBusy(false)
    }
  }

  async function deleteGroup(name: string): Promise<void> {
    if (!settings) return
    const count = countInGroup(name)
    const warning =
      count > 0
        ? `Delete the group "${name}"? ${count} server(s) in it will become ungrouped (not deleted).`
        : `Delete the empty group "${name}"?`
    if (!confirmAction(warning)) return
    setBusy(true)
    setError('')
    try {
      await persistSettings((current) => ({
        registeredGroups: current.registeredGroups.filter((n) => n !== name),
        groupOrder: current.groupOrder.filter((n) => n !== name),
        collapsedGroups: current.collapsedGroups.filter((n) => n !== name)
      }))

      const affected = profiles.filter((p) => p.group.trim() === name)
      let latest = profiles
      for (const profile of affected) {
        latest = await window.api.profiles.save({ ...profile, group: '' })
      }
      if (affected.length > 0) onProfilesChange(latest)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="wizard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wizard-header">
          <span className="wizard-header-icon">🗂️</span>
          <h2>Manage Groups</h2>
          <button type="button" className="wizard-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="wizard-subtitle">
          Create, rename, or delete the groups your servers can be sorted into on the Dashboard. Assign a server to
          one from its own card menu.
        </p>

        {error && <p className="error-message">{error}</p>}

        <div className="manage-groups-list">
          {groupNames.length === 0 && <p className="empty-state">No groups yet - create one below.</p>}
          {groupNames.map((name) => (
            <div className="manage-groups-row" key={name}>
              {renamingName === name ? (
                <form
                  className="manage-groups-rename-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void renameGroup(name)
                  }}
                >
                  <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus disabled={busy} />
                  <button type="submit" disabled={busy}>
                    Save
                  </button>
                  <button type="button" onClick={() => setRenamingName(null)} disabled={busy}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="manage-groups-name">{name}</span>
                  <span className="manage-groups-count">
                    {countInGroup(name)} server{countInGroup(name) === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRenamingName(name)
                      setRenameValue(name)
                      setError('')
                    }}
                  >
                    Rename
                  </button>
                  <button type="button" className="danger" disabled={busy} onClick={() => void deleteGroup(name)}>
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        <form
          className="manage-groups-new-form"
          onSubmit={(e) => {
            e.preventDefault()
            void createGroup()
          }}
        >
          <input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="New group name"
            disabled={busy}
          />
          <button type="submit" className="wizard-primary" disabled={busy || !newGroupName.trim()}>
            + Add Group
          </button>
        </form>

        <div className="wizard-footer">
          <div />
          <div>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
