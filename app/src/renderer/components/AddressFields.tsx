import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, MapPin, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  type AddressField,
  type CountryAddressFormat,
  type PostalAddress,
  fieldsForForm,
  formatAddress,
  isAddressFieldRequired,
  labelTokenFor,
  moveUnsupportedFieldToAddressLines,
  normalizeAddress,
  repairUnsupportedAddressFields,
  validateAddress,
  valueFor,
  withAddressField
} from '../../shared/address'
import { normalizePlusCode } from '../../shared/open-location-code'
import type { GeoPoint, PlaceCandidate } from '../../shared/geo-directory'
import { Button, FieldGrid, InlineNotice, Input, Textarea } from './ui'

/**
 * The postal address of a facility, laid out the way its country lays one out.
 *
 * Every field, its label, whether it is required and the order it appears in come from the
 * address pack, so an Emirati deployment is asked for an emirate and never for a postal
 * code, and a Singaporean one for neither an administrative area nor a city. Nothing about
 * any particular country is written here.
 *
 * Facilities only. There is deliberately no residence variant of this component: a patient
 * has a coarsened postal code and no coordinates, and a shared component would be one edit
 * away from giving them some.
 */

/** How long to wait after the last keystroke before asking the directory. */
const LOOKUP_DELAY_MS = 350

export interface AddressFieldsProps {
  address: PostalAddress | undefined
  format: CountryAddressFormat
  countryCode: string
  /** ISO 3166-2 of the chosen reporting unit, used only when nothing finer resolves. */
  subdivisionCode?: string
  onChange: (address: PostalAddress) => void
  /** Filled from the reporting placement when the operator has not typed one themselves. */
  suggestedAdminArea?: string
  /** The deployment's XYZ tile template. Absent means no preview, which is the default. */
  tileUrl?: string | null
  /**
   * Ask for only these fields. Everything else the country's format defines is still
   * stored, still exported and still validated — it is resolved from the postal directory
   * instead of typed.
   *
   * This exists because the administrative area is the one address component a laboratory
   * should never have to key: it is implied by the postal code in every country that has
   * one, and asking for it invites three spellings of the same state. Omit the prop to ask
   * for everything, which is what a country's own address form should normally do.
   */
  askFor?: AddressField[]
}

export function AddressFields({
  address, format, countryCode, subdivisionCode, onChange, suggestedAdminArea, tileUrl, askFor
}: AddressFieldsProps): React.JSX.Element {
  const { t } = useTranslation('address')
  const [candidates, setCandidates] = useState<PlaceCandidate[]>([])
  const [postalCodeUnknown, setPostalCodeUnknown] = useState(false)
  const [noPostalDirectory, setNoPostalDirectory] = useState(false)
  const [localityQuery, setLocalityQuery] = useState('')
  const [searching, setSearching] = useState(false)
  /** What was filled in without being asked for, so the form can say so rather than
   * appearing to have invented a state out of nowhere. */
  const [derived, setDerived] = useState<Array<{ field: AddressField; value: string }>>([])

  const allFields = useMemo(() => fieldsForForm(format), [format])
  const fields = useMemo(
    () => (askFor ? allFields.filter((field) => askFor.includes(field)) : allFields),
    [allFields, askFor]
  )
  /** Country fields the operator is not shown; these are the ones the directory fills. */
  const silentFields = useMemo(
    () => allFields.filter((field) => !fields.includes(field)),
    [allFields, fields]
  )
  const hasPostalCodeField = fields.includes('postal_code')
  const postalCode = address?.postal_code ?? ''
  const point = address?.geo_point

  // The lookup completes after a keystroke pause, by which time the address in the effect's
  // closure is stale. A ref keeps the derivation writing onto what the form holds now.
  const addressRef = useRef(address)
  addressRef.current = address

  /**
   * What this country calls a field, in the interface's language.
   *
   * The pack supplies a stable token — `pin`, `zip`, `eircode`, `emirate` — and the
   * catalogue turns it into text. Rendering the token itself is how "pin" and "state" came
   * to appear as field labels on a finished screen.
   */
  const label = useCallback((field: AddressField): string => {
    const token = labelTokenFor(field, format)
    return t(`labels.${token}`, { defaultValue: token.replace(/_/g, ' ') })
  }, [format, t])

  const patch = useCallback((next: PostalAddress): void => {
    next.country_code = countryCode
    next.formatted = formatAddress(next, format)
    onChange(next)
  }, [countryCode, format, onChange])

  const setField = (field: AddressField, value: string): void => {
    patch(withAddressField(address ?? { country_code: countryCode }, field, value))
  }

  const setPlusCode = (value: string): void => {
    const next: PostalAddress = { ...(address ?? { country_code: countryCode }) }
    const code = normalizePlusCode(value)
    if (code) next.plus_code = code
    else {
      delete next.plus_code
      if (next.geo_point?.source === 'open-location-code') delete next.geo_point
    }
    patch(normalizeAddress(next, format))
  }

  /**
   * Fill the components the form did not ask for, from what the postal code resolves to.
   *
   * Only ever fills a blank. If a value is already on the record — typed before the fields
   * were narrowed, or carried in from an import — the directory does not get to overwrite
   * it; a dataset's spelling of a place is not more authoritative than the laboratory's.
   */
  const deriveSilentFields = (candidate: PlaceCandidate | undefined): void => {
    if (!candidate || silentFields.length === 0) return
    const current = addressRef.current ?? { country_code: countryCode }
    let next: PostalAddress = { ...current }
    const filled: Array<{ field: AddressField; value: string }> = []
    for (const field of silentFields) {
      if (field === 'address_lines' || field === 'organization' || field === 'sorting_code') continue
      if (valueFor(field, next)) continue
      const value = String((candidate as unknown as Record<string, unknown>)[field] ?? '')
      if (!value) continue
      next = withAddressField(next, field, value)
      filled.push({ field, value })
    }
    if (!filled.length) return
    patch(next)
    setDerived(filled)
  }
  /**
   * Held in a ref so the lookup below depends on the postal code and nothing else.
   *
   * `onChange` is a new function on every render of the parent form, so a callback closing
   * over it would restart the debounce — and re-issue the directory lookup — every time
   * somebody typed a character into the laboratory's name.
   */
  const deriveRef = useRef(deriveSilentFields)
  deriveRef.current = deriveSilentFields

  /**
   * Ask the directory what a postal code means, after the operator stops typing.
   *
   * The answer is never written into the form by itself. A directory's spelling of a place
   * frequently differs from the official one, and silently replacing what somebody typed
   * with what a dataset thinks is worse than offering it.
   */
  useEffect(() => {
    if (!hasPostalCodeField) { setCandidates([]); setPostalCodeUnknown(false); return }
    const trimmed = postalCode.trim()
    if (!trimmed) { setCandidates([]); setPostalCodeUnknown(false); setDerived([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      void window.amrit.geo.postalCode(countryCode, trimmed, subdivisionCode)
        .then((result) => {
          if (cancelled) return
          setCandidates(result.candidates)
          setPostalCodeUnknown(result.postalCodeUnknown)
          setNoPostalDirectory(result.countryHasNoPostalDirectory)
          deriveRef.current(result.candidates[0])
        })
        .catch(() => undefined)
        .finally(() => { if (!cancelled) setSearching(false) })
    }, LOOKUP_DELAY_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [countryCode, hasPostalCodeField, postalCode, subdivisionCode])

  /** Searching by town name: the route for a country with no postal system. */
  useEffect(() => {
    const trimmed = localityQuery.trim()
    if (trimmed.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      void window.amrit.geo.locality(countryCode, trimmed)
        .then((matches) => { if (!cancelled) setCandidates(matches) })
        .catch(() => undefined)
        .finally(() => { if (!cancelled) setSearching(false) })
    }, LOOKUP_DELAY_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [countryCode, localityQuery])

  /**
   * Adopt a place the operator picked.
   *
   * Fills only what is still empty. Someone who typed a town before looking up the code
   * meant that town, and a lookup is not a reason to overwrite them.
   */
  const adopt = (candidate: PlaceCandidate): void => {
    let next: PostalAddress = { ...(address ?? { country_code: countryCode }) }
    const fillStructuredField = (field: AddressField, value: string | undefined): void => {
      // A directory describes places with every component it knows. A country's postal
      // format is narrower. Writing an absent component creates a hidden field that the
      // validator rejects and the operator cannot clear, so only adopt fields this country
      // can actually print.
      if (!value || !format.fields.includes(field) || valueFor(field, next)) return
      next = withAddressField(next, field, value)
    }
    fillStructuredField('locality', candidate.locality)
    fillStructuredField('admin_area', candidate.admin_area)
    fillStructuredField('dependent_locality', candidate.dependent_locality)
    fillStructuredField('postal_code', candidate.postal_code)

    // A fine-grained neighbourhood is useful delivery information even in countries that
    // do not give it a separate `%D` slot. Preserve it as a street line, which is exactly
    // where the address standard says an unsupported component belongs.
    if (candidate.dependent_locality && !format.fields.includes('dependent_locality')) {
      next = withAddressField(next, 'dependent_locality', candidate.dependent_locality)
      next = moveUnsupportedFieldToAddressLines(next, 'dependent_locality', format)
    }
    next.geo_point = {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      precision: candidate.precision,
      source: candidate.source,
      resolved_at: new Date().toISOString()
    }
    patch(next)
    setCandidates([])
    setLocalityQuery('')
  }

  const clearPoint = (): void => {
    const next: PostalAddress = { ...(address ?? { country_code: countryCode }) }
    delete next.geo_point
    patch(next)
  }

  /** Offered when the reporting placement names an area the address field is still missing. */
  const adminAreaSuggestion = suggestedAdminArea
    && fields.includes('admin_area')
    && !valueFor('admin_area', address ?? { country_code: countryCode })
    ? suggestedAdminArea
    : ''

  const problems = useMemo(
    () => (address ? validateAddress(address, format) : []),
    [address, format]
  )

  // Older imports and a country change can leave a now-incompatible component hidden from
  // this country's form. Repair it immediately and losslessly; the operator should never
  // be blocked by a field the interface gives them no way to edit.
  useEffect(() => {
    if (!address || !problems.some((problem) => problem.code === 'unsupported')) return
    patch(repairUnsupportedAddressFields(address, format))
    setDerived((current) => current.filter((item) => format.fields.includes(item.field)))
  }, [address, format, patch, problems])

  // Unsupported components are repaired above, so never flash a warning for a problem the
  // application is already resolving. Other validation failures remain visible.
  const visibleProblems = problems.filter((problem) => problem.code !== 'unsupported')

  const examples = format.postal_code_examples.slice(0, 2)

  return <div className="address-fields">
    <h4 className="form-section-heading">{t('sections.postal')}</h4>
    <p className="form-section-hint">{t('sections.postalHint')}</p>

    <FieldGrid columns={2}>
      <Input
        label={t('plusCode.label')}
        name="address-plus-code"
        value={address?.plus_code ?? ''}
        hint={t('plusCode.hint')}
        placeholder={t('plusCode.placeholder')}
        onChange={(event) => setPlusCode(event.target.value)}
      />
      {fields.map((field) => {
        const shared = {
          label: label(field),
          name: `address-${field}`,
          required: isAddressFieldRequired(field, format),
          value: valueFor(field, address ?? { country_code: countryCode }),
          onChange: (event: { target: { value: string } }) => setField(field, event.target.value)
        }
        // `address_lines` is the one field that holds more than one line, and the lines are
        // separated by newlines. Rendered in a single-line input they arrive on screen
        // glued together — "Department of MicrobiologyGovernment Medical College" — and
        // editing then collapses two real lines into one.
        return field === 'address_lines'
          ? <Textarea key={field} {...shared} rows={2} />
          : <Input
            key={field}
            {...shared}
            hint={field === 'postal_code' && examples.length
              ? t('postalCodeExample', { example: examples.join(', ') })
              : undefined}
          />
      })}
    </FieldGrid>

    {adminAreaSuggestion && <InlineNotice tone="info" title={label('admin_area')}>
      <Button variant="ghost" onClick={() => setField('admin_area', adminAreaSuggestion)}>
        {adminAreaSuggestion}
      </Button>
    </InlineNotice>}

    {/* A value the operator never typed is still on the record and still exported, so it is
        shown. Silent derivation that nobody can see is how wrong geography gets published. */}
    {derived.length > 0 && <InlineNotice tone="info" title={t('derived.title')}>
      {t('derived.body', { values: derived.map((item) => `${label(item.field)}: ${item.value}`).join(' · ') })}
    </InlineNotice>}

    {/* Countries with no postal directory get a name search instead; countries with one get
        it as well, because a code the directory has not caught up with still needs placing. */}
    {(noPostalDirectory || !hasPostalCodeField || postalCodeUnknown) && <div className="address-locality-search">
      <Input
        label={t('lookup.localityPlaceholder')}
        name="address-locality-search"
        value={localityQuery}
        onChange={(event) => setLocalityQuery(event.target.value)}
      />
      <span className="with-icon muted"><Search size={14} />{searching ? t('lookup.searching') : ''}</span>
    </div>}

    {postalCodeUnknown && <InlineNotice tone="warning" title={t('lookup.unknownTitle')}>
      {t('lookup.unknownBody', { code: postalCode.trim(), country: countryCode })}
    </InlineNotice>}

    {noPostalDirectory && hasPostalCodeField && <InlineNotice tone="info" title={t('lookup.noDirectoryTitle', { country: countryCode })}>
      {t('lookup.noDirectoryBody')}
    </InlineNotice>}

    {candidates.length > 0 && <div className="place-candidates">
      <strong>{t('lookup.suggestionsTitle')}</strong>
      <small>{t('lookup.suggestionsHint')}</small>
      <ul>
        {candidates.map((candidate, index) => (
          <li key={`${candidate.locality}-${candidate.latitude}-${index}`}>
            <button type="button" className="place-candidate" onClick={() => adopt(candidate)}>
              <MapPin size={15} />
              <span>
                <strong>{candidate.locality}</strong>
                <small>{[candidate.dependent_locality, candidate.admin_area].filter(Boolean).join(' · ')}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>}

    <GeoPointPanel point={point} onClear={clearPoint} tileUrl={tileUrl} />

    {visibleProblems.length > 0 && <InlineNotice tone="warning" title={t('problems.title')}>
      {visibleProblems.map((problem) => problem.message).join(' ')}
    </InlineNotice>}
  </div>
}

/**
 * The resolved coordinate and, above all, how exact it is.
 *
 * The precision is not decoration. A subdivision centroid and a postal-code centre differ
 * by tens of kilometres, and a map that plots them identically tells a programme something
 * untrue about where its resistance is.
 */
export function GeoPointPanel({ point, onClear, tileUrl }: {
  point: GeoPoint | undefined
  onClear: () => void
  tileUrl: string | null | undefined
}): React.JSX.Element {
  const { t } = useTranslation('address')
  if (!point) {
    return <div className="geo-point geo-point--empty"><Crosshair size={15} /><span>{t('point.none')}</span></div>
  }
  const coordinates = t('point.coordinates', {
    latitude: point.latitude.toFixed(4),
    longitude: point.longitude.toFixed(4)
  })
  const tiles = tileUrl ? previewTiles(point, tileUrl) : []
  return <div className="geo-point">
    <div className="geo-point__figures">
      <Crosshair size={15} />
      <span>
        <strong>{coordinates}</strong>
        <small>{t(`point.precision.${point.precision}`, { defaultValue: point.precision })}</small>
      </span>
      <Button variant="ghost" onClick={onClear}>{t('lookup.clear')}</Button>
    </div>
    <p className="geo-point__hint">{t('point.precisionHint')}</p>
    {tiles.length > 0
      ? <div className="geo-point__map" role="img" aria-label={t('point.mapAlt')}>
        {tiles.map((tile) => <img key={tile} src={tile} alt="" loading="lazy" />)}
        <Crosshair className="geo-point__marker" size={22} />
      </div>
      : <p className="geo-point__hint">{t('point.mapUnavailable')}</p>}
  </div>
}

/** Zoom for the preview: close enough to recognise a town, wide enough to show its edges. */
const PREVIEW_ZOOM = 12
const PREVIEW_SPAN = 3

/**
 * A preview built from static map tiles rather than an embedded map.
 *
 * Nine `<img>` elements against whatever XYZ tile server the deployment configured. No
 * script runs, nothing is embedded, and a deployment with no tile server — which is every
 * one of them until an administrator sets `map.tile_url` — simply gets the coordinates and
 * a line saying why there is no picture. An embedded interactive map would mean loading a
 * third party's JavaScript into a window that can read the local database.
 */
function previewTiles(point: GeoPoint, template: string): string[] {
  const scale = 2 ** PREVIEW_ZOOM
  const centreX = Math.floor(((point.longitude + 180) / 360) * scale)
  const radians = (point.latitude * Math.PI) / 180
  const centreY = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * scale
  )
  const half = Math.floor(PREVIEW_SPAN / 2)
  const urls: string[] = []
  for (let row = -half; row <= half; row += 1) {
    for (let column = -half; column <= half; column += 1) {
      const x = ((centreX + column) % scale + scale) % scale
      const y = centreY + row
      if (y < 0 || y >= scale) continue
      urls.push(template
        .replace('{z}', String(PREVIEW_ZOOM))
        .replace('{x}', String(x))
        .replace('{y}', String(y)))
    }
  }
  return urls
}
