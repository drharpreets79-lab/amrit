/**
 * The deployment settings form, one component per section.
 *
 * Split this way on purpose: Phase 11's first-run wizard is the same field set in a guided
 * order, and composing these is the difference between one form and two that drift apart.
 * Each section is a controlled component over a draft profile — it never writes anything, so
 * the page (or the wizard) owns saving, validation feedback and authorisation.
 */
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { logoSource } from '../../shared/deployment'
import type { AdminLevelDefinition, CountryProfile } from '../../shared/types'
import { Button, FieldGrid, InlineNotice, Input, Section, Select, Switch, Textarea } from './ui'

export type ProfilePatch = Partial<CountryProfile>
export interface SectionProps {
  draft: CountryProfile
  onChange: (patch: ProfilePatch) => void
}

/** Display calendars offered by `Intl.DateTimeFormat`; storage stays Gregorian UTC regardless. */
const CALENDARS: Array<NonNullable<CountryProfile['calendar']>> = [
  'gregory', 'buddhist', 'ethiopic', 'islamic', 'islamic-umalqura', 'nepali', 'persian', 'roc'
]
const NUMBERING_SYSTEMS = ['latn', 'arab', 'arabext', 'beng', 'deva', 'guru', 'gujr', 'knda', 'mlym', 'mymr', 'orya', 'taml', 'telu', 'thai', 'tibt']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const listToText = (values: readonly string[] | undefined): string => (values ?? []).join(', ')
const textToList = (value: string): string[] =>
  value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)

export function IdentitySection({ draft, onChange, onChooseLogo, logoBusy = false }: SectionProps & {
  onChooseLogo?: () => void
  logoBusy?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('deployment')
  const branding = draft.branding ?? { product_name: '', authority_name: '' }
  const colors = branding.colors ?? {}
  const preview = logoSource(branding.logo)
  const patchBranding = (patch: Record<string, unknown>): void =>
    onChange({ branding: { ...branding, ...patch } as CountryProfile['branding'] })
  return (
    <Section title="Identity and branding" description="What this deployment calls itself, and who operates it.">
      <FieldGrid>
        <Input label="Country name" name="country_name" value={draft.country_name} onChange={(event) => onChange({ country_name: event.target.value })} />
        <Input label="Product name" name="product_name" value={branding.product_name ?? ''} onChange={(event) => patchBranding({ product_name: event.target.value })} hint="Shown in the sidebar, the footer and exported reports." />
        <Input label="Authority name" name="authority_name" value={branding.authority_name ?? ''} onChange={(event) => patchBranding({ authority_name: event.target.value })} hint="The organisation accountable for this surveillance system." />
      </FieldGrid>

      <div className="deployment-logo">
        <div className="deployment-logo__preview">
          {preview
            ? <img src={preview} alt={`${branding.product_name || 'Deployment'} logo`} />
            : <span className="deployment-logo__none">{t('sections.noLogo')}</span>}
        </div>
        <div>
          <span className="field__label">{t('sections.logo')}</span>
          <p className="field__hint">
            {t('sections.logoHint')}
          </p>
          {onChooseLogo && <Button variant="secondary" disabled={logoBusy} onClick={onChooseLogo}>{logoBusy ? 'Checking image…' : 'Choose a logo…'}</Button>}
        </div>
      </div>

      <FieldGrid columns={3}>
        {['navy', 'blue', 'orange'].map((token) => (
          <Input key={token} type="color" label={`Brand ${token}`} name={`colour-${token}`} value={colors[token] ?? '#000000'}
            onChange={(event) => patchBranding({ colors: { ...colors, [token]: event.target.value.toUpperCase() } })} />
        ))}
      </FieldGrid>
    </Section>
  )
}

export function AdminLevelsSection({ draft, onChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation('deployment')
  const levels = [...draft.admin_levels].sort((left, right) => left.level - right.level)
  const write = (next: AdminLevelDefinition[]): void =>
    onChange({ admin_levels: next.map((level, index) => ({ ...level, level: index + 1 })) })
  const patch = (index: number, values: Partial<AdminLevelDefinition>): void =>
    write(levels.map((level, position) => position === index ? { ...level, ...values } : level))
  return (
    <Section
      title="Administrative levels"
      description="This country's sub-national hierarchy, outermost first. Laboratories, scoping and every dashboard drill-down follow it."
      actions={<Button variant="secondary" onClick={() => write([...levels, {
        level: levels.length + 1, key: `admin${levels.length + 1}`, label: 'Administrative area',
        label_plural: 'Administrative areas', code_system: 'ISO3166-2', required: false
      }])}><Plus size={16} /> {t('sections.addLevel')}</Button>}
    >
      {levels.length === 0 && <InlineNotice tone="warning">{t('sections.needOneLevel')}</InlineNotice>}
      {levels.map((level, index) => (
        <div className="admin-level-row" key={index}>
          <FieldGrid columns={4}>
            <Input label={`Level ${level.level} key`} name={`level-${index}-key`} value={level.key} onChange={(event) => patch(index, { key: event.target.value })} hint="Machine name; appears in exports." />
            <Input label="Label" name={`level-${index}-label`} value={level.label} onChange={(event) => patch(index, { label: event.target.value })} />
            <Input label="Label (plural)" name={`level-${index}-label-plural`} value={level.label_plural} onChange={(event) => patch(index, { label_plural: event.target.value })} />
            <Input label="Code system" name={`level-${index}-code-system`} value={level.code_system} onChange={(event) => patch(index, { code_system: event.target.value })} hint="ISO3166-2, LGD, GeoNames, FIPS…" />
          </FieldGrid>
          <div className="admin-level-row__controls">
            <Switch label="A laboratory must be placed at this level" checked={level.required} onChange={(value) => patch(index, { required: value })} />
            <Button variant="ghost" aria-label={t('sections.removeLevel', { level: level.level })} onClick={() => write(levels.filter((_, position) => position !== index))}><Trash2 size={16} /> {t('sections.remove')}</Button>
          </div>
        </div>
      ))}
    </Section>
  )
}

export function LocaleSection({ draft, onChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation('deployment')
  return (
    <Section title="Locale and time" description="How dates and numbers are read and written. Stored values stay ISO-8601 Gregorian UTC whatever is chosen here.">
      <FieldGrid columns={3}>
        <Input label="Locale" name="locale" value={draft.locale ?? ''} onChange={(event) => onChange({ locale: event.target.value })} hint="BCP 47, e.g. en-IN, ar-EG, ne-NP." />
        <Input label="Fallback locales" name="fallback_locales" value={listToText(draft.fallback_locales)} onChange={(event) => onChange({ fallback_locales: textToList(event.target.value) })} hint="Comma separated, tried in order." />
        <Select label="Text direction" name="text_direction" value={draft.text_direction ?? 'ltr'} onChange={(event) => onChange({ text_direction: event.target.value as CountryProfile['text_direction'] })}>
          <option value="ltr">{t('sections.ltr')}</option>
          <option value="rtl">{t('sections.rtl')}</option>
        </Select>
        <Select label="Numbering system" name="numbering_system" value={draft.numbering_system ?? 'latn'} onChange={(event) => onChange({ numbering_system: event.target.value })}>
          {NUMBERING_SYSTEMS.map((system) => <option key={system} value={system}>{system}</option>)}
        </Select>
        <Input label="Timezone" name="timezone" value={draft.timezone ?? ''} onChange={(event) => onChange({ timezone: event.target.value || null })} hint={draft.timezone_ambiguous ? 'This country spans several zones — each site may override it.' : 'IANA identifier, e.g. Africa/Lagos.'} />
        <Select label="Display calendar" name="calendar" value={draft.calendar ?? 'gregory'} onChange={(event) => onChange({ calendar: event.target.value as CountryProfile['calendar'] })}>
          {CALENDARS.map((calendar) => <option key={calendar} value={calendar}>{calendar}</option>)}
        </Select>
        <Select label="Date input order" name="date_input_order" value={draft.date_input_order ?? 'YMD'} onChange={(event) => onChange({ date_input_order: event.target.value as CountryProfile['date_input_order'] })}>
          <option value="DMY">{t('sections.dmy')}</option>
          <option value="MDY">{t('sections.mdy')}</option>
          <option value="YMD">{t('sections.ymd')}</option>
        </Select>
        <Select label="First day of week" name="first_day_of_week" value={String(draft.first_day_of_week ?? 1)} onChange={(event) => onChange({ first_day_of_week: Number(event.target.value) })}>
          {WEEKDAYS.map((day, index) => <option key={day} value={index + 1}>{day}</option>)}
        </Select>
        <Select label="Epidemiological week" name="epi_week_system" value={draft.epi_week_system ?? 'iso'} onChange={(event) => onChange({ epi_week_system: event.target.value as CountryProfile['epi_week_system'] })}>
          <option value="iso">{t('sections.epiIso')}</option>
          <option value="mmwr">{t('sections.epiMmwr')}</option>
        </Select>
        <Select label="Reporting year starts" name="fiscal_year_start_month" value={String(draft.fiscal_year_start_month ?? 1)} onChange={(event) => onChange({ fiscal_year_start_month: Number(event.target.value) })}>
          {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
        </Select>
      </FieldGrid>
    </Section>
  )
}

export function StandardsSection({ draft, onChange }: SectionProps): React.JSX.Element {
  const guidelines = draft.guidelines ?? { default: 'EUCAST', available: ['EUCAST'] }
  const codeSystems = draft.code_systems ?? {}
  return (
    <Section title="Standards and guidelines" description="Which breakpoint authority this country follows, and which coded vocabularies it may use.">
      <FieldGrid columns={3}>
        <Select label="Default guideline" name="guideline_default" value={guidelines.default} onChange={(event) => onChange({ guidelines: { ...guidelines, default: event.target.value } })}>
          {(guidelines.available.length ? guidelines.available : [guidelines.default]).map((body) => <option key={body} value={body}>{body}</option>)}
        </Select>
        <Input label="Available guidelines" name="guideline_available" value={listToText(guidelines.available)} onChange={(event) => onChange({ guidelines: { ...guidelines, available: textToList(event.target.value) } })} hint="Comma separated, e.g. EUCAST, CLSI." />
        <Input label="National standards body" name="guideline_body" value={guidelines.national_body ?? ''} onChange={(event) => onChange({ guidelines: { ...guidelines, national_body: event.target.value || null } })} />
      </FieldGrid>
      <Input label="Reporting frameworks" name="reporting_frameworks" value={listToText(draft.reporting_frameworks)} onChange={(event) => onChange({ reporting_frameworks: textToList(event.target.value) })} hint="Comma separated, e.g. GLASS, ANIMUSE, InFARM." />
      {Object.entries(codeSystems).map(([name, entry]) => (
        <Switch key={name} label={`${name.toUpperCase()} code system`}
          description={entry.licence ? `Licence: ${entry.licence}. Enable only if this deployment holds it.` : undefined}
          checked={entry.enabled}
          onChange={(value) => onChange({ code_systems: { ...codeSystems, [name]: { ...entry, enabled: value } } })} />
      ))}
    </Section>
  )
}

export function PrivacySection({ draft, onChange }: SectionProps): React.JSX.Element {
  const privacy = draft.privacy ?? {}
  return (
    <Section title="Privacy" description="Disclosure control and the identifiers this jurisdiction forbids storing.">
      <FieldGrid columns={3}>
        <Input type="number" min={1} label="k-anonymity floor" name="k_anonymity_floor" value={String(privacy.k_anonymity_floor ?? 5)} onChange={(event) => onChange({ privacy: { ...privacy, k_anonymity_floor: Number(event.target.value) } })} hint="Aggregates below this count are suppressed." />
        <Input type="number" min={0} label="Retention (days)" name="retention_days" value={privacy.retention_days == null ? '' : String(privacy.retention_days)} onChange={(event) => onChange({ privacy: { ...privacy, retention_days: event.target.value === '' ? null : Number(event.target.value) } })} hint="Blank means no automatic expiry." />
        <Input label="Residency note" name="residency_note" value={privacy.residency_note ?? ''} onChange={(event) => onChange({ privacy: { ...privacy, residency_note: event.target.value || null } })} />
        <Input type="number" min={0} label="Patient postal code characters kept on export" name="patient_postal_code_digits" value={privacy.patient_postal_code_digits == null ? '' : String(privacy.patient_postal_code_digits)} onChange={(event) => onChange({ privacy: { ...privacy, patient_postal_code_digits: event.target.value === '' ? null : Number(event.target.value) } })}
          hint="Leading characters kept in exports and FHIR bundles; 0 drops the code entirely. Blank uses the built-in 3. Three characters de-identify a large-area code and pin a street in a small country — this is a local judgement." />
      </FieldGrid>
      <Textarea label="Banned identifier keys" name="banned_identifier_keys" rows={2} value={listToText(draft.banned_identifier_keys)} onChange={(event) => onChange({ banned_identifier_keys: textToList(event.target.value) })}
        hint="Comma separated. Merged into the generic blocklist, which always applies — this list can only make the guard stricter." />
    </Section>
  )
}

export function MapSection({ draft, onChange }: SectionProps): React.JSX.Element {
  const map = draft.map ?? {}
  const [latitude, longitude] = map.center ?? [0, 0]
  const setCentre = (lat: number, lng: number): void => onChange({ map: { ...map, center: [lat, lng] } })
  return (
    <Section title="Map" description="Where dashboards open, and which basemap they fetch. Several countries cannot reach the common tile CDNs.">
      <FieldGrid columns={4}>
        <Input type="number" step="0.0001" label="Centre latitude" name="map_lat" value={String(latitude)} onChange={(event) => setCentre(Number(event.target.value), longitude)} />
        <Input type="number" step="0.0001" label="Centre longitude" name="map_lng" value={String(longitude)} onChange={(event) => setCentre(latitude, Number(event.target.value))} />
        <Input type="number" min={1} max={18} label="Zoom" name="map_zoom" value={String(map.zoom ?? 2)} onChange={(event) => onChange({ map: { ...map, zoom: Number(event.target.value) } })} />
        <Input label="Tile URL" name="map_tile_url" value={map.tile_url ?? ''} onChange={(event) => onChange({ map: { ...map, tile_url: event.target.value || null } })} hint="Absolute https only. Blank uses the built-in default." />
      </FieldGrid>
    </Section>
  )
}

export function NamespaceSection({ draft, onChange, confirmed, onConfirm, changed }: SectionProps & {
  confirmed: boolean
  onConfirm: (value: boolean) => void
  changed: boolean
}): React.JSX.Element {
  const { t } = useTranslation('deployment')
  const namespace = draft.identifier_namespace ?? { base_uri: '', urn_prefix: '' }
  return (
    <Section title="Identifier namespace" description="The URIs written into every FHIR resource this deployment exports.">
      <InlineNotice tone="warning" title={t('sections.irreversibleTitle')}>
        {t('sections.irreversibleBody')}
      </InlineNotice>
      <FieldGrid>
        <Input label="Base URI" name="base_uri" value={namespace.base_uri} onChange={(event) => onChange({ identifier_namespace: { ...namespace, base_uri: event.target.value } })} hint="Absolute https URL." />
        <Input label="URN prefix" name="urn_prefix" value={namespace.urn_prefix} onChange={(event) => onChange({ identifier_namespace: { ...namespace, urn_prefix: event.target.value } })} hint="Lowercase, colon separated, e.g. urn:example:amr." />
      </FieldGrid>
      {changed && <Switch label="I understand, and want to change the identifier namespace" checked={confirmed} onChange={onConfirm} />}
    </Section>
  )
}

export interface RetentionPreview {
  applied: boolean
  retentionDays: number | null
  cutoff: string | null
  removed: Array<{ table?: unknown; label?: unknown; rows?: unknown }>
}

/**
 * Retention and erasure — the two irreversible privacy operations.
 *
 * Both are deliberately two-step. A purge previews first because no backup taken after the
 * fact can undo it, and an erasure names its subject and its justification before it runs.
 * The main process re-checks authorisation on both; this screen only presents them.
 */
export function RetentionSection({ draft, preview, busy, onPreview, onPurge, onErase }: {
  draft: CountryProfile
  preview: RetentionPreview | null
  busy: string
  onPreview: () => void
  onPurge: () => void
  onErase: (input: { objectType: string; objectId: string; reason: string }) => void
}): React.JSX.Element {
  const { t } = useTranslation('deployment')
  const [subject, setSubject] = useState({ objectType: '', objectId: '', reason: '' })
  const retentionDays = draft.privacy?.retention_days ?? null
  const expiring = (preview?.removed ?? []).filter((entry) => Number(entry.rows ?? 0) > 0)
  return (
    <Section title={t('retention.title')} description={t('retention.description')}>
      {retentionDays === null
        ? <InlineNotice tone="info">{t('retention.unset')}</InlineNotice>
        : <>
          <div className="form-actions">
            <Button variant="secondary" disabled={Boolean(busy)} onClick={onPreview}>
              {busy === 'preview' ? t('retention.previewing') : t('retention.preview')}
            </Button>
            <Button variant="danger" disabled={Boolean(busy) || !expiring.length} onClick={onPurge}>
              {busy === 'purge' ? t('retention.purging') : t('retention.purge')}
            </Button>
          </div>
          {preview && (preview.cutoff
            ? <InlineNotice tone={expiring.length ? 'warning' : 'success'}>
              {t('retention.configured', { days: preview.retentionDays, cutoff: preview.cutoff })}
              {expiring.length
                ? <ul className="build-time-list">{expiring.map((entry, index) => (
                  <li key={index}><strong>{t('retention.wouldRemove', { count: Number(entry.rows ?? 0), label: String(entry.label ?? entry.table ?? '') })}</strong></li>
                ))}</ul>
                : ` ${t('retention.nothingExpired')}`}
            </InlineNotice>
            : <InlineNotice tone="info">{t('retention.unset')}</InlineNotice>)}
        </>}

      <h3 className="subheading">{t('retention.eraseTitle')}</h3>
      <p className="field__hint">{t('retention.eraseBody')}</p>
      <FieldGrid columns={3}>
        <Input label={t('retention.objectType')} name="erase-object-type" hint={t('retention.objectTypeHint')}
          value={subject.objectType} onChange={(event) => setSubject({ ...subject, objectType: event.target.value })} />
        <Input label={t('retention.objectId')} name="erase-object-id"
          value={subject.objectId} onChange={(event) => setSubject({ ...subject, objectId: event.target.value })} />
        <Input label={t('retention.reason')} name="erase-reason" hint={t('retention.reasonHint')}
          value={subject.reason} onChange={(event) => setSubject({ ...subject, reason: event.target.value })} />
      </FieldGrid>
      <Button variant="danger" disabled={Boolean(busy) || !subject.objectType.trim() || !subject.objectId.trim() || !subject.reason.trim()}
        onClick={() => onErase(subject)}>
        {busy === 'erase' ? t('retention.erasing') : t('retention.erase')}
      </Button>
    </Section>
  )
}

/** Everything the operator changed, against the profile this installation would otherwise use. */
export function CustomisationsSection({ overrides, onRevert }: {
  overrides: Record<string, unknown>
  onRevert: (field: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('deployment')
  const [expanded, setExpanded] = useState<string | null>(null)
  const fields = Object.keys(overrides).sort()
  return (
    <Section title="Customisations" description="Fields this deployment has changed. Everything else follows the base profile and tracks its updates.">
      {fields.length === 0
        ? <p className="field__hint">{t('sections.nothingCustomised')}</p>
        : <ul className="override-list">
          {fields.map((field) => (
            <li key={field}>
              <div>
                <button type="button" className="override-list__toggle" aria-expanded={expanded === field} onClick={() => setExpanded(expanded === field ? null : field)}>
                  {field.replace(/_/g, ' ')}
                </button>
                <Button variant="ghost" onClick={() => onRevert(field)}>{t('sections.revert')}</Button>
              </div>
              {expanded === field && <pre className="override-list__value">{JSON.stringify(overrides[field], null, 2)}</pre>}
            </li>
          ))}
        </ul>}
    </Section>
  )
}
