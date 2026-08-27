/* Authorisation is enforced again in the main process; this screen only reflects it. */
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RotateCcw, Save, Upload } from 'lucide-react'
import type { CountryProfile } from '../../shared/types'
import { BUILD_TIME_FIELDS, EDITABLE_PROFILE_FIELDS, overridesFor } from '../../shared/deployment'
import {
  AdminLevelsSection, CustomisationsSection, IdentitySection, LocaleSection, MapSection,
  NamespaceSection, PrivacySection, RetentionSection, StandardsSection,
  type ProfilePatch, type RetentionPreview
} from '../components/DeploymentSections'
import { CountrySelect, type CountrySelection } from '../components/CountrySelect'
import { useToast } from '../components/Toast'
import {
  Button, ErrorState, InlineNotice, LoadingState, Modal, PageHeader, Section, formatError
} from '../components/ui'

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export function DeploymentPage({ onChanged }: { onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('deployment')
  const { notify } = useToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [overrides, setOverrides] = useState<Record<string, unknown>>({})
  const [loaded, setLoaded] = useState<CountryProfile | null>(null)
  const [draft, setDraft] = useState<CountryProfile | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [countryOpen, setCountryOpen] = useState(false)
  const [pendingCountry, setPendingCountry] = useState<CountrySelection | null>(null)
  const [privacyBusy, setPrivacyBusy] = useState('')
  const [preview, setPreview] = useState<RetentionPreview | null>(null)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [eraseSubject, setEraseSubject] = useState<{ objectType: string; objectId: string; reason: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await window.amrit.deployment.get()
      setOverrides(result.overrides)
      setLoaded(result.profile)
      setDraft(result.profile)
      setConfirmed(false)
      setError('')
    } catch (caught) {
      setError(formatError(caught))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const adopt = async (profile: CountryProfile, title: string, message?: string): Promise<void> => {
    setLoaded(profile)
    setDraft(profile)
    setConfirmed(false)
    notify(title, message)
    await onChanged()
    const result = await window.amrit.deployment.get()
    setOverrides(result.overrides)
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } catch (caught) {
      notify(t('toast.unchangedTitle'), formatError(caught), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label={t('loading')} />
  if (error || !draft || !loaded) {
    return <ErrorState
      message={`${error || t('unreadable')} ${t('restricted')}`}
      onRetry={() => void load()}
    />
  }

  const namespaceChanged = !same(draft.identifier_namespace, loaded.identifier_namespace)
  const dirty = EDITABLE_PROFILE_FIELDS.some((field) => !same(draft[field], loaded[field]))
  const patch = (values: ProfilePatch): void => setDraft({ ...draft, ...values })

  const save = (): Promise<void> => run(async () => {
    const profile = await window.amrit.deployment.save(
      overridesFor(overrides, loaded, draft),
      { confirmIrreversible: confirmed }
    )
    await adopt(profile, t('toast.savedTitle'), t('toast.savedBody'))
  })

  const selectCountry = (selection: CountrySelection, confirmCountryChange: boolean): Promise<void> => run(async () => {
    const profile = await window.amrit.deployment.selectCountry(selection.alpha3, { confirmCountryChange })
    setCountryOpen(false)
    setPendingCountry(null)
    await adopt(profile, t('toast.countryTitle'), t('toast.countryBody', { country: profile.country_name }))
  })

  const revert = (field: string): Promise<void> => run(async () => {
    const next = { ...overrides }
    delete next[field]
    const profile = await window.amrit.deployment.save(next, { confirmIrreversible: true })
    await adopt(profile, t('toast.revertedTitle'), t('toast.revertedBody', { field: field.replace(/_/g, ' ') }))
  })

  const chooseLogo = (): Promise<void> => run(async () => {
    const path = await window.amrit.chooseFile({ filters: [{ name: t('filePicker.image'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (!path) return
    const profile = await window.amrit.deployment.logo(path)
    await adopt(profile, t('toast.logoTitle'), t('toast.logoBody'))
  })

  const exportProfile = (): Promise<void> => run(async () => {
    const path = await window.amrit.chooseSave({
      defaultPath: `${draft.profile_id || draft.country_code}.json`,
      filters: [{ name: t('filePicker.profile'), extensions: ['json'] }]
    })
    if (!path) return
    const written = await window.amrit.deployment.export(path)
    notify(t('toast.exportedTitle'), written)
  })

  const importProfile = (): Promise<void> => run(async () => {
    const path = await window.amrit.chooseFile({ filters: [{ name: t('filePicker.profile'), extensions: ['json'] }] })
    if (!path) return
    const profile = await window.amrit.deployment.import(path, { confirmIrreversible: confirmed })
    await adopt(profile, t('toast.adoptedTitle'), t('toast.adoptedBody'))
  })

  /** Every privacy operation is irreversible, so each reports its own failure rather than
   *  silently leaving the screen looking as though it succeeded. */
  const privacy = async (step: string, action: () => Promise<void>): Promise<void> => {
    setPrivacyBusy(step)
    try {
      await action()
    } catch (caught) {
      notify(t('retention.toast.failedTitle'), formatError(caught), 'error')
    } finally {
      setPrivacyBusy('')
    }
  }

  const previewRetention = (): Promise<void> => privacy('preview', async () => {
    const result = await window.amrit.privacy.purge({ dryRun: true })
    setPreview(result as unknown as RetentionPreview)
  })

  const purgeRetention = (): Promise<void> => privacy('purge', async () => {
    const result = await window.amrit.privacy.purge({ dryRun: false })
    setPurgeOpen(false)
    const removed = (result.removed ?? []).reduce((total, entry) => total + Number((entry as { rows?: unknown }).rows ?? 0), 0)
    notify(t('retention.toast.purgedTitle'), t('retention.toast.purgedBody', { count: removed }))
    setPreview(result as unknown as RetentionPreview)
  })

  const eraseAudit = (subject: { objectType: string; objectId: string; reason: string }): Promise<void> =>
    privacy('erase', async () => {
      const result = await window.amrit.privacy.eraseAudit(subject.objectType, subject.objectId, subject.reason)
      setEraseSubject(null)
      notify(t('retention.toast.erasedTitle'), t('retention.toast.erasedBody', result))
    })

  const resetAll = (): Promise<void> => run(async () => {
    const profile = await window.amrit.deployment.reset()
    setResetOpen(false)
    await adopt(profile, t('toast.resetTitle'), t('toast.resetBody'))
  })

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        purpose={t('purpose', { country: draft.country_name, code: draft.country_code })}
        actions={<>
          <Button variant="secondary" disabled={busy} onClick={() => void importProfile()}><Upload size={17} /> {t('actions.import')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void exportProfile()}><Download size={17} /> {t('actions.export')}</Button>
          <Button disabled={busy || !dirty} onClick={() => void save()}><Save size={17} /> {t('actions.save')}</Button>
        </>}
      />

      {dirty && <InlineNotice tone="info">{t('unsaved')}</InlineNotice>}

      <Section title={t('country.title')} description={t('country.description')}>
        <CountrySelect
          label={t('country.label')}
          name="deployment-country"
          value={draft.country_code === 'ZZZ' ? '' : draft.country_code}
          disabled={busy}
          required
          hint={t('country.hint')}
          onChange={(selection) => {
            if (!selection.alpha3 || selection.alpha3 === draft.country_code) return
            setPendingCountry(selection)
            if (draft.country_code === 'ZZZ') void selectCountry(selection, false)
            else setCountryOpen(true)
          }}
        />
        {draft.country_code === 'ZZZ' && <InlineNotice tone="warning" title={t('country.requiredTitle')}>
          {t('country.requiredBody')}
        </InlineNotice>}
      </Section>

      <IdentitySection draft={draft} onChange={patch} onChooseLogo={() => void chooseLogo()} logoBusy={busy} />
      <AdminLevelsSection draft={draft} onChange={patch} />
      <LocaleSection draft={draft} onChange={patch} />
      <StandardsSection draft={draft} onChange={patch} />
      <PrivacySection draft={draft} onChange={patch} />
      <MapSection draft={draft} onChange={patch} />
      <RetentionSection
        draft={draft}
        preview={preview}
        busy={privacyBusy}
        onPreview={() => void previewRetention()}
        onPurge={() => setPurgeOpen(true)}
        onErase={setEraseSubject}
      />
      <NamespaceSection draft={draft} onChange={patch} changed={namespaceChanged} confirmed={confirmed} onConfirm={setConfirmed} />
      <CustomisationsSection overrides={overrides} onRevert={(field) => void revert(field)} />

      <Section title={t('buildTime.title')} description={t('buildTime.description')}>
        <ul className="build-time-list">
          {BUILD_TIME_FIELDS.map((entry) => <li key={entry.label}><strong>{entry.label}</strong><span>{entry.reason}</span></li>)}
        </ul>
        <Button variant="ghost" disabled={busy} onClick={() => setResetOpen(true)}><RotateCcw size={17} /> {t('actions.resetAll')}</Button>
      </Section>

      <Modal
        open={countryOpen}
        title={t('country.modalTitle')}
        description={pendingCountry ? t('country.modalDescription', { country: pendingCountry.name }) : ''}
        width="small"
        onClose={() => { setCountryOpen(false); setPendingCountry(null) }}
        actions={<>
          <Button variant="secondary" onClick={() => { setCountryOpen(false); setPendingCountry(null) }}>{t('actions.cancel')}</Button>
          <Button variant="danger" disabled={busy || !pendingCountry} onClick={() => pendingCountry && void selectCountry(pendingCountry, true)}>{t('country.confirm')}</Button>
        </>}
      >
        <p>{t('country.modalBody')}</p>
      </Modal>

      <Modal
        open={resetOpen}
        title={t('resetModal.title')}
        description={t('resetModal.description')}
        width="small"
        onClose={() => setResetOpen(false)}
        actions={<>
          <Button variant="secondary" onClick={() => setResetOpen(false)}>{t('actions.cancel')}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void resetAll()}>{t('actions.reset')}</Button>
        </>}
      >
        <p>{t('resetModal.body')}</p>
      </Modal>

      <Modal
        open={purgeOpen}
        title={t('retention.purgeModalTitle')}
        description={t('retention.purgeModalDescription')}
        width="small"
        onClose={() => setPurgeOpen(false)}
        actions={<>
          <Button variant="secondary" onClick={() => setPurgeOpen(false)}>{t('actions.cancel')}</Button>
          <Button variant="danger" disabled={Boolean(privacyBusy)} onClick={() => void purgeRetention()}>{t('retention.purge')}</Button>
        </>}
      >
        <p>{t('retention.purgeModalBody')}</p>
      </Modal>

      <Modal
        open={Boolean(eraseSubject)}
        title={t('retention.eraseModalTitle')}
        description={t('retention.eraseModalDescription')}
        width="small"
        onClose={() => setEraseSubject(null)}
        actions={<>
          <Button variant="secondary" onClick={() => setEraseSubject(null)}>{t('actions.cancel')}</Button>
          <Button variant="danger" disabled={Boolean(privacyBusy)} onClick={() => eraseSubject && void eraseAudit(eraseSubject)}>{t('retention.erase')}</Button>
        </>}
      >
        <p>{t('retention.eraseBody')}</p>
      </Modal>
    </>
  )
}
