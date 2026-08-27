/**
 * Renderer translation, locale-aware formatting and text direction.
 *
 * Catalogues are imported statically rather than fetched. This application is offline-first
 * and is installed in places with no outbound network at all; a translation backend that
 * fetches JSON would leave those deployments with untranslated screens and no explanation.
 * The cost is that every shipped language is in the bundle, which for text is small.
 *
 * English is the source language and the only one shipped. `en-XA` is a pseudo-locale
 * derived from English at load time — it is the gate that proves a string is going through
 * this layer, because anything it does not transform was never extracted.
 */
import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'

import type { CountryProfile } from '../../shared/types'
import en from '../locales/en'

export const SOURCE_LANGUAGE = 'en'
/** CLDR's reserved pseudo-locale for testing. Not offered to users; enabled by env or query. */
export const PSEUDO_LANGUAGE = 'en-XA'

export const NAMESPACES = Object.keys(en) as Array<keyof typeof en>
export const DEFAULT_NAMESPACE = 'common'

/**
 * Wrap every leaf string so an unextracted literal is obvious on sight, and pad it so a
 * layout that only fits English breaks here rather than in the field. Interpolation
 * placeholders are left intact; mangling them would fail for the wrong reason.
 */
function pseudo(value: string): string {
  const accented = value.replace(/[a-zA-Z]+/g, (word) =>
    word.replace(/[aeiouAEIOU]/g, (vowel) => PSEUDO_VOWELS[vowel] ?? vowel))
  return `⟦${accented}${'·'.repeat(Math.ceil(value.length * 0.3))}⟧`
}
const PSEUDO_VOWELS: Record<string, string> = {
  a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú'
}

function pseudoCatalogue(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      // Keep {{placeholders}} intact so interpolation still resolves.
      out[key] = value.split(/(\{\{[^}]+\}\})/).map((part) => part.startsWith('{{') ? part : pseudo(part)).join('')
    } else if (value && typeof value === 'object') {
      out[key] = pseudoCatalogue(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

export const resources = {
  [SOURCE_LANGUAGE]: en,
  [PSEUDO_LANGUAGE]: pseudoCatalogue(en) as typeof en
}

/**
 * Initialise an instance in place.
 *
 * The exported `i18n` is i18next's own default instance rather than a private one, because
 * `initReactI18next` registers the default as react-i18next's fallback. Components rendered
 * above `LocaleProvider` — the boot screen and the error state, which appear before a country
 * profile exists — would otherwise resolve nothing and render bare keys.
 */
function configure(instance: I18nInstance, language: string): I18nInstance {
  void instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: SOURCE_LANGUAGE,
    ns: NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    interpolation: { escapeValue: false },
    // A missing key must read as the key, not as an empty element that looks like a
    // rendering bug — this is what makes an incomplete catalogue visible in review.
    parseMissingKeyHandler: (key) => key,
    returnNull: false
  })
  return instance
}

/** An isolated instance, for tests that need to assert on a specific language. */
export const createI18n = (language = SOURCE_LANGUAGE): I18nInstance =>
  configure(i18next.createInstance(), language)

export const i18n = configure(i18next, SOURCE_LANGUAGE)

/**
 * The language this deployment should open in.
 *
 * `AMRIT_UI_LANGUAGE` overrides everything, which is how the pseudo-locale gate runs and how
 * an operator checks a translation without changing the country profile. Otherwise the
 * profile's locale is used when a catalogue exists for it, then its fallbacks, then English.
 */
export function resolveLanguage(
  profile: Pick<CountryProfile, 'locale' | 'fallback_locales'> | null,
  override?: string | null
): string {
  const available = Object.keys(resources)
  const candidates = [override, profile?.locale, ...(profile?.fallback_locales ?? [])]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (available.includes(candidate)) return candidate
    // en-IN has no catalogue of its own and should not fall past en to the pseudo-locale.
    const base = candidate.split('-')[0]!
    if (available.includes(base)) return base
  }
  return SOURCE_LANGUAGE
}

/** Right-to-left is a property of the deployment's language, declared by the profile. */
export function applyDirection(direction: 'ltr' | 'rtl' | undefined, language: string): void {
  document.documentElement.dir = direction ?? 'ltr'
  document.documentElement.lang = language
}
