/* Provider and its consumer hook belong together; splitting them helps nothing. */
/* eslint-disable react-refresh/only-export-components */
import type React from 'react'
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

import type { CountryProfile } from '../../shared/types'
import { applyDirection, i18n, resolveLanguage } from './index'
import { createFormatters, type Formatters } from './format'

const FormatContext = createContext<Formatters | null>(null)

/**
 * Binds the active country profile to the translation instance and to every formatter.
 *
 * Language, text direction and number/date rendering all come from one place, so a country
 * cannot end up with translated text laid out left-to-right, or Arabic-Indic digits in one
 * table and Latin digits in the next.
 */
export function LocaleProvider({ profile, children }: { profile: CountryProfile; children: ReactNode }): React.JSX.Element {
  const language = useMemo(
    () => resolveLanguage(profile, window.localStorage.getItem('amrit.language')),
    [profile]
  )
  const formatters = useMemo(() => createFormatters(profile), [profile])

  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language)
    applyDirection(profile.text_direction, language)
  }, [language, profile.text_direction])

  return (
    <I18nextProvider i18n={i18n}>
      <FormatContext.Provider value={formatters}>{children}</FormatContext.Provider>
    </I18nextProvider>
  )
}

/**
 * Locale-correct formatters for the active profile.
 *
 * Falls back to an English formatter set rather than throwing, so a component rendered
 * outside the provider — in a test, or during boot — still produces readable output.
 */
export function useFormat(): Formatters {
  const context = useContext(FormatContext)
  return useMemo(
    () => context ?? createFormatters({
      schema_version: 1, profile_id: 'DEFAULT', country_code: 'ZZZ', country_name: '',
      locale: 'en', admin_levels: []
    }),
    [context]
  )
}
