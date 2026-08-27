/* The country cache and its hook belong with the control they serve, not in a file of their own. */
/* eslint-disable react-refresh/only-export-components */
import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { CountryOption } from '../../shared/types'
import { Combobox } from './ui'

/**
 * Pick a country by name; keep its ISO 3166-1 code.
 *
 * Country was a free-text box, and free text is how one deployment ends up holding "India",
 * "INDIA", "Bharat" and "IN" as four different countries in the same column — none of which
 * a regional aggregation can group. The list is the checked-in ISO 3166-1 reference the
 * country profiles are themselves built from, so the codes a laboratory stores and the codes
 * the profile system resolves cannot drift apart.
 *
 * The alpha-3 is what is written to the record. The name travels alongside it for display
 * and for the legacy `country` column, and the alpha-2 is handed back for the formats that
 * speak it, but nothing downstream should ever match on either of those.
 */

/** Shared across every mounted picker: 249 rows fetched once, not once per form. */
let cache: CountryOption[] | null = null
let inFlight: Promise<CountryOption[]> | null = null

async function loadCountries(): Promise<CountryOption[]> {
  if (cache) return cache
  inFlight ??= window.amrit.countries().then((rows) => { cache = rows; inFlight = null; return rows })
  return inFlight
}

export function useCountries(): CountryOption[] {
  const [countries, setCountries] = useState<CountryOption[]>(cache ?? [])
  useEffect(() => {
    let alive = true
    void loadCountries().then((rows) => { if (alive) setCountries(rows) }).catch(() => undefined)
    return () => { alive = false }
  }, [])
  return countries
}

export interface CountrySelection {
  alpha3: string
  alpha2: string
  name: string
}

export function CountrySelect({ label, value, onChange, name, required, hint, disabled }: {
  label: string
  /** ISO 3166-1 alpha-3, alpha-2, or — for a record written before this control existed — a name. */
  value: string
  onChange: (selection: CountrySelection) => void
  name: string
  required?: boolean
  hint?: string
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('common')
  const countries = useCountries()
  const options = useMemo(
    () => countries.map((entry) => ({
      value: entry.alpha3,
      label: entry.name,
      // Both codes are searchable, because whoever knows one of them rarely knows which of
      // the two this field wants.
      hint: entry.alpha2
    })),
    [countries]
  )
  /**
   * Records written before this control accepted only text, so a stored "India" has to
   * resolve to IND rather than showing as an unknown value. Matched on name and on the
   * alpha-2 as well; anything still unmatched is left exactly as it is rather than guessed.
   */
  const resolved = useMemo(() => {
    const candidate = (value ?? '').trim()
    if (!candidate) return ''
    const upper = candidate.toUpperCase()
    if (countries.some((entry) => entry.alpha3 === upper)) return upper
    return countries.find((entry) => entry.alpha2 === upper)?.alpha3
      ?? countries.find((entry) => entry.name.toLowerCase() === candidate.toLowerCase())?.alpha3
      ?? candidate
  }, [countries, value])

  return <Combobox
    label={label}
    name={name}
    value={resolved}
    options={options}
    required={required}
    disabled={disabled}
    hint={hint ?? t('countrySelect.hint')}
    placeholder={t('countrySelect.placeholder')}
    onChange={(next) => {
      const entry = countries.find((item) => item.alpha3 === next)
      onChange(entry
        ? { alpha3: entry.alpha3, alpha2: entry.alpha2, name: entry.name }
        : { alpha3: '', alpha2: '', name: '' })
    }}
  />
}
