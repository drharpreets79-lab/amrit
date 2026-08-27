import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Edit3, MapPin, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { CountryProfile, Laboratory, PostalAddress, Row } from '../../shared/types'
import { repairUnsupportedAddressFields, type AddressField, type CountryAddressFormat, validateAddress } from '../../shared/address'
import { AddressFields } from '../components/AddressFields'
import { CountrySelect } from '../components/CountrySelect'
import { useFormat } from '../i18n/provider'
import { DataTable, type TableColumn } from '../components/DataTable'
import { useToast } from '../components/Toast'
import { Button, CustomSelect, FieldGrid, HelpDrawer, InlineNotice, Input, Modal, PageHeader, SearchInput, StatusPill, formatError } from '../components/ui'

/**
 * What a laboratory's address form asks for, in every country.
 *
 * Deliberately shorter than the country's own address format. A facility record needs the
 * building, the town and the postal code; the administrative area is implied by the postal
 * code and is resolved from the directory instead of being keyed — which is what stops the
 * same state arriving under three spellings. Countries whose format has no postal code, or
 * no locality, simply render fewer of these.
 */
const LAB_ADDRESS_FIELDS: AddressField[] = ['organization', 'address_lines', 'locality', 'postal_code']

const emptyLab = (profile: CountryProfile): Laboratory => ({
  code: '', name: '', country: profile.country_name, country_code: profile.country_code, site_group: 'Human health',
  default_guideline: profile.guidelines?.default ?? 'CLSI', default_test_method: 'Disk diffusion',
  guideline_year: String(new Date().getFullYear())
})

export function LaboratoriesPage({ laboratories, currentLab, countryProfile, onChanged }: { laboratories: Laboratory[]; currentLab: Laboratory | null; countryProfile: CountryProfile; onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('laboratories')
  const { t: tc } = useTranslation('common')
  const { t: ta } = useTranslation('address')
  const format = useFormat()
  const { notify } = useToast()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Laboratory | null>(null)
  const [copySource, setCopySource] = useState<Laboratory | null>(null)
  const [lockedLabCode, setLockedLabCode] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [help, setHelp] = useState(false)
  const [lookups, setLookups] = useState<{ domains: Row[]; adminUnits: Row[]; codeValues: Row[] }>({ domains: [], adminUnits: [], codeValues: [] })
  useEffect(() => { void Promise.all([window.amrit.masters.list('domains', { includeInactive: false, limit: 10000 }), window.amrit.masters.list('codeValues', { includeInactive: false, limit: 10000 })]).then(([domains, codeValues]) => setLookups((current) => ({ ...current, domains, codeValues }))).catch(() => undefined) }, [])
  /**
   * The country of the laboratory being edited — not the country of the deployment.
   *
   * These are different questions and conflating them broke the form: a national programme
   * runs under one profile, but the laboratories it registers can sit anywhere, and every
   * geographic lookup on this screen was being asked of the deployment's country. Choosing
   * the United States and typing 14850 asked India's directory for a six-digit PIN and was
   * told, correctly and uselessly, that "14850 is not in the bundled directory for IND".
   *
   * Empty is a real state, reached by clearing the field, and it must stay empty — falling
   * back to the profile's country here is what made a deleted country reappear on its own.
   */
  const editingCountry = String(editing?.country_code ?? '').trim().toUpperCase()
  /** Which country's rules the address form runs under; the profile's only until one is set. */
  const addressCountry = editingCountry || countryProfile.country_code
  useEffect(() => {
    let alive = true
    void window.amrit.geo.reportingUnits(addressCountry)
      .then((adminUnits) => { if (alive) setLookups((current) => ({ ...current, adminUnits })) })
      .catch(() => { if (alive) setLookups((current) => ({ ...current, adminUnits: [] })) })
    return () => { alive = false }
  }, [addressCountry])

  /**
   * The address form for that country: which fields exist, which are required and what the
   * country calls them. Nothing about the address form is written in this file, so a
   * laboratory in a country with no admin area or no postal code gets a form that simply
   * does not ask for them.
   */
  const [addressFormat, setAddressFormat] = useState<CountryAddressFormat | null>(null)
  useEffect(() => {
    let alive = true
    void window.amrit.addressFormat(addressCountry)
      .then((next) => { if (alive) setAddressFormat(next) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [addressCountry])
  const searchText = (lab: Laboratory): string =>
    `${lab.code} ${lab.name} ${lab.address?.formatted ?? ''} ${lab.address?.locality ?? ''} ${lab.address?.admin_area ?? ''}`
  const filtered = useMemo(() => laboratories.filter((lab) => searchText(lab).toLowerCase().includes(query.toLowerCase())), [laboratories, query])
  const update = (key: string, value: unknown): void => setEditing((current) => current ? { ...current, [key]: value } : current)
  const closeEditor = (): void => { setEditing(null); setCopySource(null); setLockedLabCode(null) }
  const beginCopy = (lab: Laboratory): void => {
    setCopySource(lab)
    setLockedLabCode(null)
    setEditing({
      ...emptyLab(countryProfile),
      code: `${lab.code}_COPY`, name: t('editor.copySuffix', { name: lab.name }),
      // The copy is in the same country as its source, not in the deployment's country.
      country: lab.country ?? countryProfile.country_name,
      country_code: lab.country_code || lab.address?.country_code || countryProfile.country_code,
      admin_unit_id: lab.admin_unit_id, admin_path: lab.admin_path, address: lab.address, site_group: lab.site_group
    })
  }
  const codeOptions = (sets: string[], fallback: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> => { const configured = lookups.codeValues.filter((row) => sets.includes(String(row.code_set ?? ''))).map((row) => ({ value: String(row.code ?? row.display_label ?? row.description ?? ''), label: String(row.display_label ?? row.description ?? row.code ?? ''), hint: String(row.code ?? '') })).filter((item) => item.value); return configured.length ? configured : fallback }
  const domainOptions = lookups.domains.map((row) => ({ value: String(row.label ?? row.name ?? row.code ?? ''), label: String(row.label ?? row.name ?? row.code ?? '') })).filter((item) => item.value)
  // The tree of the laboratory's own country. Matching an American address against India's
  // districts would place a Manhattan hospital in a Kerala taluk.
  const unitsForCountry = useMemo(
    () => lookups.adminUnits.filter((row) => String(row.country_code ?? '') === addressCountry),
    [lookups.adminUnits, addressCountry]
  )

  /**
   * The reporting unit, worked out from the address rather than asked for.
   *
   * This form used to carry one dropdown per administrative level — "State / UT" then
   * "District" in India — directly above an address block that asked for the state again.
   * Two controls for one fact is how a laboratory ends up filed under one state and
   * addressed in another, and neither of them is a thing a clerk with an envelope in front
   * of them knows how to answer.
   *
   * So the placement is derived: the postal code resolves an administrative area through
   * the geographic directory, and the deepest unit whose name matches becomes
   * `admin_unit_id` and `admin_path` — the same two fields every scope filter has always
   * matched on. Nothing about the stored shape changed; only who fills it.
   */
  const matchedUnit = useMemo(() => {
    const comparable = (value: unknown): string => String(value ?? '')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const area = comparable(editing?.address?.admin_area)
    const locality = comparable(editing?.address?.locality)
    const areaCode = String(editing?.address?.admin_area_code ?? '').trim().toUpperCase()
    const postalCode = String(editing?.address?.postal_code ?? '').trim().toUpperCase().replace(/[\s.-]/g, '')
    const storedUnitId = String(editing?.admin_unit_id ?? '')
    const named = (row: Row): string[] => [comparable(row.name), comparable(row.name_local)].filter(Boolean)
    const coversPostalCode = (row: Row): boolean => Boolean(postalCode) && String(row.postal_code ?? '')
      .split(/[,;]/).map((entry) => entry.trim().toUpperCase().replace(/[\s.-]/g, '')).filter(Boolean)
      .some((entry) => entry === postalCode || postalCode.startsWith(entry))
    // Deepest first: a district match places the laboratory more precisely than its state.
    const ranked = [...unitsForCountry].sort((left, right) => Number(right.level ?? 0) - Number(left.level ?? 0))
    return (areaCode ? ranked.find((row) => String(row.code ?? '').trim().toUpperCase() === areaCode) : undefined)
      ?? ranked.find(coversPostalCode)
      ?? (locality ? ranked.find((row) => named(row).includes(locality)) : undefined)
      ?? (area ? ranked.find((row) => named(row).includes(area)) : undefined)
      // Preserve an explicit/imported assignment when the address is not precise enough to
      // improve it. The old renderer ignored this field and falsely said "No unit yet".
      ?? ranked.find((row) => String(row.id ?? '') === storedUnitId)
  }, [editing?.address?.admin_area, editing?.address?.admin_area_code, editing?.address?.locality, editing?.address?.postal_code, editing?.admin_unit_id, unitsForCountry])

  /**
   * Written onto the record as soon as the address resolves one, so a save carries it.
   *
   * The updater compares before it writes; without that, setting state from an effect that
   * depends on that state is a render loop.
   */
  const matchedUnitId = String(matchedUnit?.id ?? '')
  const matchedUnitPath = String(matchedUnit?.admin_path ?? '')
  useEffect(() => {
    if (!matchedUnitId) return
    setEditing((current) => {
      if (!current) return current
      if (String(current.admin_unit_id ?? '') === matchedUnitId && String(current.admin_path ?? '') === matchedUnitPath) return current
      return { ...current, admin_unit_id: matchedUnitId, admin_path: matchedUnitPath }
    })
  }, [matchedUnitId, matchedUnitPath])

  const updateAddress = (address: PostalAddress): void =>
    setEditing((current) => (current ? { ...current, address } : current))

  /**
   * Move the laboratory to another country, and take everything country-shaped with it.
   *
   * The address carries its own `country_code` — it is the key into the address pack, and a
   * US address left stamped IND validates against a six-digit PIN pattern and renders in
   * India's format. The administrative placement goes too: a unit id from the old country's
   * tree is not merely stale, it points at a district on the other side of the world.
   *
   * The typed address lines and postal code are kept. Someone correcting the country of a
   * record they have already filled in wants the correction, not an empty form.
   */
  const selectCountry = (selection: { alpha3: string; name: string }): void => {
    setEditing((current) => {
      if (!current) return current
      const next: Laboratory = { ...current, country: selection.name, country_code: selection.alpha3 }
      if (current.address) next.address = { ...current.address, country_code: selection.alpha3 }
      if (String(current.country_code ?? '') !== selection.alpha3) {
        delete next.admin_unit_id
        delete next.admin_path
      }
      return next
    })
  }
  const addressProblems = useMemo(
    () => (editing?.address && addressFormat
      ? validateAddress(repairUnsupportedAddressFields(editing.address, addressFormat), addressFormat)
      : []),
    [editing?.address, addressFormat]
  )
  const save = async (): Promise<void> => {
    if (!editing?.code.trim() || !editing.name.trim()) { notify(t('notify.requiredMissing'), t('notify.requiredDetail'), 'error'); return }
    if (!editingCountry) { notify(t('notify.countryRequired'), t('notify.countryRequiredDetail'), 'error'); return }
    if (addressProblems.length) { notify(t('notify.addressInvalid'), addressProblems.map((problem) => problem.message).join(' '), 'error'); return }
    setSaving(true)
    try {
      const target = { ...editing, code: editing.code.trim().toUpperCase(), name: editing.name.trim() }
      if (copySource) {
        const result = await window.amrit.labs.clone(copySource.code, target)
        notify(t('notify.copied'), t('notify.copiedDetail', { name: result.laboratory.name, count: result.counts.lab_panels ?? 0 }))
      } else {
        await window.amrit.labs.save(target)
        notify(t('notify.saved'), t('notify.savedDetail', { name: editing.name }))
      }
      closeEditor()
      await onChanged()
    }
    catch (caught) { notify(copySource ? t('notify.copyFailed') : t('notify.saveFailed'), formatError(caught), 'error') } finally { setSaving(false) }
  }
  const select = async (lab: Laboratory): Promise<void> => {
    try { await window.amrit.labs.select(lab.code); notify(t('notify.activeChanged'), t('notify.activeChangedDetail', { name: lab.name })); await onChanged() }
    catch (caught) { notify(t('notify.selectFailed'), formatError(caught), 'error') }
  }
  const remove = async (lab: Laboratory): Promise<void> => {
    if (!window.confirm(t('notify.confirmDelete', { name: lab.name, code: lab.code }))) return
    try { await window.amrit.labs.delete(lab.code); notify(t('notify.deleted'), lab.name); await onChanged() }
    catch (caught) { notify(t('notify.deleteFailed'), formatError(caught), 'error') }
  }
  const unitNameFor = (lab: Laboratory): string =>
    String(lookups.adminUnits.find((row) => String(row.id ?? '') === String(lab.admin_unit_id ?? ''))?.name ?? '')
  const columns: Array<TableColumn<Laboratory>> = [
    { key: 'code', label: t('columns.code'), render: (lab) => <strong className="code-label">{lab.code}</strong> },
    { key: 'name', label: t('columns.laboratory'), render: (lab) => <div className="table-primary"><strong>{lab.name}</strong><small>{lab.site_group || t('columns.domainNotSet')}</small></div> },
    // The country's own rendering of the address, falling back to the reporting unit's
    // name when only a placement was recorded. Never an assembled "district, state" list:
    // the order and the separators are a property of the country, not of this table.
    { key: 'location', label: t('columns.location'), render: (lab) => <span className="with-icon"><MapPin size={15} />{(lab.address?.formatted || '').split('\n').join(', ') || unitNameFor(lab) || lab.country || t('columns.notSpecified')}</span> },
    { key: 'guideline', label: t('columns.astDefaults'), render: (lab) => <span>{lab.default_guideline || '—'} {lab.guideline_year || ''}<small className="cell-subtitle">{lab.default_test_method || t('columns.methodNotSet')}</small></span> },
    { key: 'status', label: t('columns.status'), render: (lab) => currentLab?.code === lab.code ? <StatusPill label={t('columns.active')} tone="green" /> : <StatusPill label={t('columns.available')} /> },
    { key: 'actions', label: t('columns.actions'), className: 'table-actions', render: (lab) => <div className="row-actions"><Button variant={currentLab?.code === lab.code ? 'ghost' : 'secondary'} disabled={currentLab?.code === lab.code} onClick={(event) => { event.stopPropagation(); void select(lab) }}>{currentLab?.code === lab.code ? <Check size={16} /> : null}{currentLab?.code === lab.code ? t('selected') : t('select')}</Button><Button variant="ghost" onClick={(event) => { event.stopPropagation(); setCopySource(null); setLockedLabCode(lab.code); setEditing({ ...lab }) }}><Edit3 size={16} /> {t('edit')}</Button><Button variant="ghost" onClick={(event) => { event.stopPropagation(); beginCopy(lab) }}><Copy size={16} /> {t('copyConfiguration')}</Button><Button variant="ghost" className="danger-text" onClick={(event) => { event.stopPropagation(); void remove(lab) }}><Trash2 size={16} /><span className="sr-only">{t('delete', { name: lab.name })}</span></Button></div> }
  ]
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} purpose={t('purpose')} actions={<Button onClick={() => { setCopySource(null); setLockedLabCode(null); setEditing(emptyLab(countryProfile)) }}><Plus size={17} /> {t('add')}</Button>} onHelp={() => setHelp(true)} />
    {currentLab ? <InlineNotice tone="success" title={t('activeTitle')}>{t('activeBody', { name: currentLab.name, code: currentLab.code })}</InlineNotice> : <InlineNotice tone="warning" title={t('selectionTitle')}>{t('selectionBody')}</InlineNotice>}
    <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder={t('searchPlaceholder')} /><span className="toolbar__count">{t('count', { shown: format.number(filtered.length), total: format.number(laboratories.length) })}</span></div>
    <DataTable rows={filtered} columns={columns} keyFor={(lab) => lab.code} emptyTitle={t('emptyTitle')} emptyMessage={t('emptyMessage')} />
    <Modal open={Boolean(editing)} title={copySource ? t('editor.copyTitle') : lockedLabCode ? t('editor.editTitle') : t('editor.addTitle')} description={copySource ? t('editor.copyDescription', { name: copySource.name }) : t('editor.description')} onClose={() => !saving && closeEditor()} width="large" actions={<><Button variant="secondary" onClick={closeEditor} disabled={saving}>{tc('cancel')}</Button><Button onClick={() => void save()} disabled={saving}>{saving ? t('editor.saving') : copySource ? t('copyConfiguration') : t('editor.saveLaboratory')}</Button></>}>
      {editing && <div className="form-stack">
        {copySource && <InlineNotice tone="info" title={t('editor.copyOnlyTitle')}>{t('editor.copyOnlyBody')}</InlineNotice>}
        <FieldGrid columns={2}><Input label={t('editor.code')} value={editing.code} required maxLength={32} disabled={Boolean(lockedLabCode)} hint={t('editor.codeHint')} onChange={(event) => update('code', event.target.value)} /><Input label={t('editor.name')} value={editing.name} required onChange={(event) => update('name', event.target.value)} /></FieldGrid>
        {/*
          One question, asked once. The form takes the address a clerk can read off a
          letterhead — street, town, postal code — and everything else about where the
          laboratory sits is derived from it: the administrative area from the postal
          directory, and the reporting unit from that. The per-level dropdowns that used to
          stand above this block asked the same question a second time in India's own words.
        */}
        <FieldGrid columns={2}>
          <CountrySelect
            label={t('editor.country')}
            name="lab-country"
            required
            // Exactly what the record holds. A fallback here is what made a cleared country
            // reappear a second later: the box emptied, the fallback refilled it from the
            // profile, and the operator watched their deletion undo itself.
            value={String(editing.country_code ?? editing.country ?? '')}
            onChange={selectCountry}
          />
          <Input label={t('editor.countryCode')} name="lab-country-code" value={String(editing.country_code ?? '')} disabled hint={t('editor.countryCodeHint')} onChange={() => undefined} />
        </FieldGrid>
        {addressFormat && <AddressFields
          address={editing.address}
          format={addressFormat}
          countryCode={addressCountry}
          subdivisionCode={String(matchedUnit?.code ?? '')}
          tileUrl={countryProfile.map?.tile_url}
          askFor={LAB_ADDRESS_FIELDS}
          onChange={updateAddress}
        />}
        {/* The placement is data — it is what every scope filter matches on — so it is shown
            back rather than left to be discovered in an export that came out empty. */}
        <InlineNotice tone={matchedUnit ? 'info' : 'warning'} title={ta('sections.placement')}>
          {matchedUnit
            ? t('editor.placementDerived', { unit: String(matchedUnit.name ?? ''), path: String(matchedUnit.admin_path ?? '') })
            : t('editor.placementPending')}
        </InlineNotice>
        <FieldGrid columns={copySource ? 1 : 2}><CustomSelect label={t('editor.domain')} name="site_group" value={editing.site_group ?? ''} onChange={(value) => update('site_group', value)} options={domainOptions.length ? domainOptions : [{ value: 'Human health', label: t('editor.humanHealth') }, { value: 'Animal health', label: t('editor.animalHealth') }, { value: 'Environment', label: t('editor.environment') }, { value: 'Food', label: t('editor.foodChain') }]} />{!copySource && <CustomSelect label={t('editor.defaultGuideline')} name="default_guideline" value={editing.default_guideline ?? ''} onChange={(value) => update('default_guideline', value)} options={codeOptions(['ast_guideline', 'guideline'], [{ value: 'CLSI', label: 'CLSI' }, { value: 'EUCAST', label: 'EUCAST' }, { value: 'National', label: t('editor.nationalGuideline') }])} />}</FieldGrid>
        {!copySource && <FieldGrid columns={2}><CustomSelect label={t('editor.defaultMethod')} name="default_test_method" value={editing.default_test_method ?? ''} onChange={(value) => update('default_test_method', value)} options={codeOptions(['ast_method', 'test_method'], [{ value: 'Disk diffusion', label: t('editor.diskDiffusion') }, { value: 'MIC', label: t('editor.mic') }, { value: 'Gradient strip', label: t('editor.gradientStrip') }, { value: 'Automated', label: t('editor.automated') }])} /><Input label={t('editor.guidelineYear')} value={editing.guideline_year ?? ''} onChange={(event) => update('guideline_year', event.target.value)} /></FieldGrid>}
      </div>}
    </Modal>
    <HelpDrawer open={help} title={t('title')} onClose={() => setHelp(false)}><p>{t('help.scope')}</p><h3>{t('help.selectingTitle')}</h3><ul><li>{t('help.selecting1')}</li><li>{t('help.selecting2')}</li><li>{t('help.selecting3')}</li></ul><h3>{t('help.copyTitle')}</h3><p>{t('help.copyBody')}</p><p>{t('help.deleteBody')}</p></HelpDrawer>
  </>
}
