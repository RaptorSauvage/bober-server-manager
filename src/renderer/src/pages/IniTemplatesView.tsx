import { Fragment, useEffect, useState } from 'react'
import type {
  IniTemplateApplyResult,
  IniTemplateContent,
  IniTemplatePendingResult,
  IniTemplateProfileOverride,
  ServerProfile
} from '@shared/types'
import { confirmAction } from '../lib/confirmAction'

interface IniTemplatesViewProps {
  profiles: ServerProfile[]
  onBack: () => void
}

const EMPTY_CONTENT: IniTemplateContent = { gameUserSettingsIni: '', gameIni: '' }

interface OverrideFormState {
  profile: ServerProfile
  content: IniTemplateContent
  /** Independent of the profile's own name in the Manager - blank falls back to it. */
  sessionName: string
}

/** Tools > INI Templates - a cluster-wide generic GameUserSettings.ini/Game.ini template,
 *  plus an optional per-server override, merged key-by-key into each profile's real config
 *  files (an existing key is updated right where it already is, a new one is inserted into
 *  its section), the override winning over the generic template for anything both set (see
 *  src/main/lib/iniTemplates.ts).
 *
 *  Per-server Apply is a two-step generate/confirm flow: "Generate Preview" stages the merged
 *  result into a real `*.pending.ini` file sitting right next to the real one (so it opens in
 *  whatever editor the user already hand-edits configs with via "Open Preview"), and nothing
 *  about the real file changes until "Confirm Replace" is clicked - at which point whatever
 *  the pending file holds, hand-edits included, becomes the real file verbatim. "Apply to
 *  All" (header button) deliberately skips this staging step - see its own doc comment. */
export default function IniTemplatesView({ profiles, onBack }: IniTemplatesViewProps): JSX.Element {
  // Same convention as the Dashboard/PlayersView: a server hidden there is hidden here too
  // (nothing to apply a template to that the user has deliberately tucked away), and the
  // rest are organized by their own ServerProfile.group - ungrouped first, then each named
  // group alphabetically - instead of one long flat list.
  const visibleProfiles = profiles.filter((p) => !p.hidden)
  const ungroupedProfiles = visibleProfiles.filter((p) => !p.group.trim())
  const groupNames = Array.from(new Set(visibleProfiles.filter((p) => p.group.trim()).map((p) => p.group.trim()))).sort(
    (a, b) => a.localeCompare(b)
  )

  const [generic, setGeneric] = useState<IniTemplateContent>(EMPTY_CONTENT)
  const [loading, setLoading] = useState(true)
  const [savingGeneric, setSavingGeneric] = useState(false)
  const [genericStatus, setGenericStatus] = useState('')
  const [genericImportError, setGenericImportError] = useState('')
  const [overridesByProfile, setOverridesByProfile] = useState<Record<string, IniTemplateProfileOverride | null>>({})

  const [applyingAll, setApplyingAll] = useState(false)
  const [applyResults, setApplyResults] = useState<IniTemplateApplyResult[] | null>(null)
  const [applyErrorById, setApplyErrorById] = useState<Record<string, string>>({})
  const [applySuccessId, setApplySuccessId] = useState<string | null>(null)

  // Generate/Confirm staging state for the per-server flow - pendingByProfile mirrors what
  // generatePendingIniTemplate most recently staged on disk for each profile (or null once
  // confirmed/discarded/never generated), refreshed from getPendingStatus on load so leaving
  // and coming back to this page doesn't lose track of an already-staged preview. busyId is
  // the one profile currently mid-generate/confirm/discard (only one action per row at a time
  // makes sense, so a single id covers all three instead of three separate maps).
  const [pendingByProfile, setPendingByProfile] = useState<Record<string, IniTemplatePendingResult | null>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  const [overrideForm, setOverrideForm] = useState<OverrideFormState | null>(null)
  const [savingOverride, setSavingOverride] = useState(false)
  const [overrideError, setOverrideError] = useState('')

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [genericContent, overrideEntries, pendingEntries] = await Promise.all([
        window.api.iniTemplates.getGeneric(),
        Promise.all(visibleProfiles.map(async (p) => [p.id, await window.api.iniTemplates.getOverride(p.id)] as const)),
        Promise.all(visibleProfiles.map(async (p) => [p.id, await window.api.iniTemplates.getPendingStatus(p.id)] as const))
      ])
      setGeneric(genericContent)
      setOverridesByProfile(Object.fromEntries(overrideEntries))
      setPendingByProfile(Object.fromEntries(pendingEntries))
    } finally {
      setLoading(false)
    }
  }

  /** Opens the native file picker and, if a file was chosen, hands its raw text to
   *  `onLoaded` - lets any of the four textareas below be filled from a .ini file the user
   *  already has on disk instead of retyping it. */
  async function importIniFile(onLoaded: (text: string) => void, onError: (message: string) => void): Promise<void> {
    onError('')
    const filePath = await window.api.dialog.selectIniFile()
    if (!filePath) return
    try {
      onLoaded(await window.api.iniTemplates.readFile(filePath))
    } catch (err) {
      onError((err as Error).message)
    }
  }

  async function saveGeneric(): Promise<void> {
    setSavingGeneric(true)
    try {
      setGeneric(await window.api.iniTemplates.saveGeneric(generic))
      setGenericStatus('Saved')
      setTimeout(() => setGenericStatus(''), 2000)
    } finally {
      setSavingGeneric(false)
    }
  }

  async function openOverrideForm(profile: ServerProfile): Promise<void> {
    setOverrideError('')
    const existing = await window.api.iniTemplates.getOverride(profile.id)
    setOverrideForm({ profile, content: existing ?? { ...EMPTY_CONTENT }, sessionName: existing?.sessionName ?? '' })
  }

  async function saveOverride(): Promise<void> {
    if (!overrideForm) return
    setSavingOverride(true)
    setOverrideError('')
    try {
      const updated = await window.api.iniTemplates.saveOverride({
        profileId: overrideForm.profile.id,
        ...overrideForm.content,
        sessionName: overrideForm.sessionName
      })
      const saved = updated.find((o) => o.profileId === overrideForm.profile.id) ?? null
      setOverridesByProfile((prev) => ({ ...prev, [overrideForm.profile.id]: saved }))
      setOverrideForm(null)
    } catch (err) {
      setOverrideError((err as Error).message)
    } finally {
      setSavingOverride(false)
    }
  }

  async function clearOverride(): Promise<void> {
    if (!overrideForm) return
    if (
      !confirmAction(
        `Clear ${overrideForm.profile.name}'s override? It'll go back to using only the generic template next time you apply.`
      )
    )
      return
    setSavingOverride(true)
    try {
      await window.api.iniTemplates.deleteOverride(overrideForm.profile.id)
      setOverridesByProfile((prev) => ({ ...prev, [overrideForm.profile.id]: null }))
      setOverrideForm(null)
    } finally {
      setSavingOverride(false)
    }
  }

  async function generatePending(profile: ServerProfile): Promise<void> {
    setBusyId(profile.id)
    setApplyErrorById((prev) => ({ ...prev, [profile.id]: '' }))
    setApplySuccessId(null)
    try {
      const pending = await window.api.iniTemplates.generatePending(profile.id)
      setPendingByProfile((prev) => ({ ...prev, [profile.id]: pending }))
    } catch (err) {
      setApplyErrorById((prev) => ({ ...prev, [profile.id]: (err as Error).message }))
    } finally {
      setBusyId(null)
    }
  }

  async function openPendingFile(profile: ServerProfile, relativePath: string): Promise<void> {
    try {
      await window.api.fileBrowser.open(profile.id, relativePath)
    } catch (err) {
      setApplyErrorById((prev) => ({ ...prev, [profile.id]: (err as Error).message }))
    }
  }

  async function confirmPending(profile: ServerProfile): Promise<void> {
    setBusyId(profile.id)
    setApplyErrorById((prev) => ({ ...prev, [profile.id]: '' }))
    try {
      await window.api.iniTemplates.confirmPending(profile.id)
      setPendingByProfile((prev) => ({ ...prev, [profile.id]: null }))
      setApplySuccessId(profile.id)
      setTimeout(() => setApplySuccessId((prev) => (prev === profile.id ? null : prev)), 2500)
    } catch (err) {
      setApplyErrorById((prev) => ({ ...prev, [profile.id]: (err as Error).message }))
    } finally {
      setBusyId(null)
    }
  }

  async function discardPending(profile: ServerProfile): Promise<void> {
    if (!confirmAction(`Discard the staged preview for ${profile.name}? Its real config files stay exactly as they are.`)) return
    setBusyId(profile.id)
    try {
      await window.api.iniTemplates.discardPending(profile.id)
      setPendingByProfile((prev) => ({ ...prev, [profile.id]: null }))
    } finally {
      setBusyId(null)
    }
  }

  async function applyAll(): Promise<void> {
    if (
      !confirmAction(
        "Apply the INI templates to every ARK server? This writes into each one's own GameUserSettings.ini/Game.ini right now."
      )
    )
      return
    setApplyingAll(true)
    setApplyResults(null)
    try {
      setApplyResults(await window.api.iniTemplates.applyAll())
    } finally {
      setApplyingAll(false)
    }
  }

  function renderOverrideRow(profile: ServerProfile): JSX.Element {
    const override = overridesByProfile[profile.id]
    const pending = pendingByProfile[profile.id]
    const customSessionName = override?.sessionName.trim()
    const busy = busyId === profile.id
    return (
      <tr key={profile.id}>
        <td>{profile.name}</td>
        <td>
          {customSessionName ? (
            customSessionName
          ) : (
            <span className="muted" title="No override - falls back to the profile name above">
              {profile.name}
            </span>
          )}
        </td>
        <td>{override ? 'Yes' : <span className="muted">None</span>}</td>
        <td className="ini-templates-row-actions">
          {applyErrorById[profile.id] && <span className="error-message">{applyErrorById[profile.id]}</span>}
          {applySuccessId === profile.id && <span className="status-message">Applied</span>}
          <button type="button" onClick={() => void openOverrideForm(profile)}>
            Edit Override
          </button>
          {pending ? (
            <>
              <button type="button" onClick={() => void openPendingFile(profile, pending.gameUserSettingsIniPath)} disabled={busy}>
                Open Preview
              </button>
              {pending.gameIniPath && (
                <button type="button" onClick={() => void openPendingFile(profile, pending.gameIniPath!)} disabled={busy}>
                  Open Game.ini Preview
                </button>
              )}
              <button type="button" className="btn-accent" onClick={() => void confirmPending(profile)} disabled={busy}>
                {busy ? 'Confirming...' : 'Confirm Replace'}
              </button>
              <button type="button" className="danger" onClick={() => void discardPending(profile)} disabled={busy}>
                Discard
              </button>
            </>
          ) : (
            <button type="button" onClick={() => void generatePending(profile)} disabled={busy}>
              {busy ? 'Generating...' : 'Generate Preview'}
            </button>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="server-detail">
      <header className="server-detail-header">
        <button onClick={onBack}>&larr; Back</button>
        <h1>INI Templates</h1>
        <button
          type="button"
          className="btn-accent ini-templates-apply-all-btn"
          onClick={() => void applyAll()}
          disabled={applyingAll || profiles.length === 0}
        >
          {applyingAll ? 'Applying...' : 'Apply to All'}
        </button>
      </header>
      <p className="empty-state">
        Write a shared base config once, then only the genuinely server-specific lines per server. &quot;Generate
        Preview&quot; merges both into a real *.pending.ini file sitting right next to that server&apos;s own
        GameUserSettings.ini/Game.ini, without touching the real one yet: a key the file already has is updated
        right where it already sits (so it stays grouped with the rest of that section, not split off elsewhere), a
        key it doesn&apos;t have yet is added to its section - any comment you wrote directly above a key in a
        template comes along with it when that key is new, and the override wins over the generic template for
        anything both set. Open that preview file to double-check or hand-tweak it, then &quot;Confirm Replace&quot;
        to make it the real file - everything else already in the real file, including anything you edited by hand,
        is left completely alone until then. A server&apos;s own name always wins for SessionName, so you never
        need to set that yourself. &quot;Apply to All&quot; (above) skips this preview step and writes directly to
        every server at once.
      </p>

      {applyResults && (
        <div className="ini-templates-apply-summary">
          <strong>
            Applied to {applyResults.filter((r) => r.ok).length}/{applyResults.length} server(s)
            {applyResults.some((r) => !r.ok) ? ` - ${applyResults.filter((r) => !r.ok).length} failed` : ''}.
          </strong>
          {applyResults
            .filter((r) => !r.ok)
            .map((r) => (
              <p className="error-message" key={r.profileId}>
                {r.profileName}: {r.error}
              </p>
            ))}
          <button type="button" onClick={() => setApplyResults(null)}>
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <p className="empty-state">Loading...</p>
      ) : (
        <>
          <section className="cluster-section">
            <h3>Generic Template (every server)</h3>
            {genericImportError && <p className="error-message">{genericImportError}</p>}
            <div className="settings-grid">
              <label className="wizard-field">
                <div className="ini-template-field-header">
                  <span>GameUserSettings.ini</span>
                  <button
                    type="button"
                    className="ini-template-import-btn"
                    onClick={() =>
                      void importIniFile(
                        (text) => setGeneric((g) => ({ ...g, gameUserSettingsIni: text })),
                        setGenericImportError
                      )
                    }
                  >
                    Import from file...
                  </button>
                </div>
                <textarea
                  className="ini-template-textarea"
                  value={generic.gameUserSettingsIni}
                  onChange={(e) => setGeneric({ ...generic, gameUserSettingsIni: e.target.value })}
                  placeholder={'[ServerSettings]\nServerPVE=False'}
                  spellCheck={false}
                />
              </label>
              <label className="wizard-field">
                <div className="ini-template-field-header">
                  <span>Game.ini</span>
                  <button
                    type="button"
                    className="ini-template-import-btn"
                    onClick={() => void importIniFile((text) => setGeneric((g) => ({ ...g, gameIni: text })), setGenericImportError)}
                  >
                    Import from file...
                  </button>
                </div>
                <textarea
                  className="ini-template-textarea"
                  value={generic.gameIni}
                  onChange={(e) => setGeneric({ ...generic, gameIni: e.target.value })}
                  placeholder={'[/script/shootergame.shootergamemode]\nXPMultiplier=2.0'}
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="form-actions">
              <button type="button" onClick={() => void saveGeneric()} disabled={savingGeneric}>
                {savingGeneric ? 'Saving...' : 'Save Generic Template'}
              </button>
              {genericStatus && <span className="status-message">{genericStatus}</span>}
            </div>
          </section>

          <section className="cluster-section">
            <h3>Per-Server Overrides</h3>
            {visibleProfiles.length === 0 ? (
              <p className="empty-state">No ARK servers yet.</p>
            ) : (
              <table className="map-manager-table">
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Server Name (SessionName)</th>
                    <th>Override</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ungroupedProfiles.map((profile) => renderOverrideRow(profile))}
                  {groupNames.map((groupName) => (
                    <Fragment key={groupName}>
                      <tr className="ini-templates-group-row">
                        <td colSpan={4}>{groupName}</td>
                      </tr>
                      {visibleProfiles.filter((p) => p.group.trim() === groupName).map((profile) => renderOverrideRow(profile))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {overrideForm && (
        <div className="wizard-overlay" onClick={() => !savingOverride && setOverrideForm(null)}>
          <div className="wizard-modal wizard-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="wizard-header">
              <span className="wizard-header-icon">🧩</span>
              <h2>{overrideForm.profile.name} - Override</h2>
              <button type="button" className="wizard-close" onClick={() => setOverrideForm(null)} disabled={savingOverride}>
                ✕
              </button>
            </div>
            <p className="wizard-subtitle">
              These lines win over the generic template for this one server only - merged into the same real
              GameUserSettings.ini/Game.ini keys, not a separate block. You can paste in an existing .ini file
              wholesale - any SessionName inside it is always ignored in favor of the Server Name set below.
            </p>
            {overrideError && <p className="error-message">{overrideError}</p>}
            <div className="wizard-body">
              <label className="wizard-field">
                Server Name (SessionName)
                <input
                  type="text"
                  value={overrideForm.sessionName}
                  onChange={(e) => setOverrideForm({ ...overrideForm, sessionName: e.target.value })}
                  placeholder={overrideForm.profile.name}
                />
                <p className="wizard-hint-static">
                  Leave blank to use this server&apos;s own name in the Manager (&quot;{overrideForm.profile.name}&quot;).
                </p>
              </label>
              <label className="wizard-field">
                <div className="ini-template-field-header">
                  <span>GameUserSettings.ini override</span>
                  <button
                    type="button"
                    className="ini-template-import-btn"
                    onClick={() =>
                      void importIniFile(
                        (text) =>
                          setOverrideForm((prev) =>
                            prev ? { ...prev, content: { ...prev.content, gameUserSettingsIni: text } } : prev
                          ),
                        setOverrideError
                      )
                    }
                  >
                    Import from file...
                  </button>
                </div>
                <textarea
                  className="ini-template-textarea"
                  value={overrideForm.content.gameUserSettingsIni}
                  onChange={(e) =>
                    setOverrideForm({ ...overrideForm, content: { ...overrideForm.content, gameUserSettingsIni: e.target.value } })
                  }
                  spellCheck={false}
                />
              </label>
              <label className="wizard-field">
                <div className="ini-template-field-header">
                  <span>Game.ini override</span>
                  <button
                    type="button"
                    className="ini-template-import-btn"
                    onClick={() =>
                      void importIniFile(
                        (text) => setOverrideForm((prev) => (prev ? { ...prev, content: { ...prev.content, gameIni: text } } : prev)),
                        setOverrideError
                      )
                    }
                  >
                    Import from file...
                  </button>
                </div>
                <textarea
                  className="ini-template-textarea"
                  value={overrideForm.content.gameIni}
                  onChange={(e) => setOverrideForm({ ...overrideForm, content: { ...overrideForm.content, gameIni: e.target.value } })}
                  spellCheck={false}
                />
              </label>
              <div className="wizard-footer">
                <div>
                  <button type="button" className="danger" onClick={() => void clearOverride()} disabled={savingOverride}>
                    Clear Override
                  </button>
                </div>
                <div>
                  <button type="button" onClick={() => setOverrideForm(null)} disabled={savingOverride}>
                    Cancel
                  </button>
                  <button type="button" className="wizard-primary" onClick={() => void saveOverride()} disabled={savingOverride}>
                    {savingOverride ? 'Saving...' : 'Save Override'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
